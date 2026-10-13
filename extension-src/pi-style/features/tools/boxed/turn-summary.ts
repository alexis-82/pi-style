// Turn tool summary registry (ADR 0007).
//
// Default merged mode has ONE duration-free ◈ thought/tool run disclosure.
// Its thought leader owns the row; tools-only runs use their first tool call.
// All finalized members (including errors/mutations) hide when closed. The
// disclosure sets every member's public native expansion flag, so nested
// batches and native Ctrl+O stay coherent. Incomplete runs never collapse.
// Legacy mode (mergedTurnSummary:false) retains the ADR 0007 ➔ row, error
// visibility, and optional mutating exemptions.
//
// The summary also reports the turn's aggregate diff stats (`· Edit +6 -2`,
// diff colors) computed purely from tool-result data — `details.diff` for
// edit, the parsed `── diff ──` output section for the quick-edit family
// (the same sources the box renderers read) — so live, scroll-back, and
// resume render identically. `write` carries no diff and is skipped; error
// members never contribute applied-diff stats.
//
// In legacy mode, mutating tools (edit/write/quick_edit/substitute_edit/
// target_edit) are exempt by default (`tools.collapseMutatingTools: off`):
// their blocks are the record of what was done to the user's files, so they
// always stay visible (compact preview) even in an ended turn — the summary
// covers only read-only tools (read/ls/find/grep/bash). Turning the leaf on
// restores the full collapse.
//
// Design notes:
// - The registry is populated from **session content**, never from runtime
//   event flags: the live path registers the final assistant message +
//   toolResults at `turn_end`; the restore path rebuilds the registry from
//   `sessionManager.getBranch()` at session start / `session_tree`, so
//   scroll-back and session resume render identically.
// - A turn is "ended" only when every tool call of its message has a matching
//   tool result AND (live) turn_end fired / (restore) the message is
//   finalized (`stopReason`) or a later user/assistant message exists.
// - Elapsed per member is frozen from the renderer wall-clock state
//   (STARTED_AT/ENDED_AT) at the first post-turn result pass; the summary
//   totals the members' frozen elapsed. No render-time I/O.
// - No new Pi-core patch identity: the dispatcher (boxed/index.ts) decides
//   collapse before the per-tool renderers run, so every certified renderer
//   surface stays untouched when the turn is not collapsed.

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import { countDiffStats, firstText } from "../../../shared/split-diff.js";
import {
	mergedSummaryText,
	publishMessageStats,
	registerTurnToggleHandler,
	resetSummaryBridge,
} from "../../../shared/turn-summary-bridge.js";
import { pluralForm } from "./output-tree.js";
import { extractQuickEditDiff, getQuickEditToolConfig } from "./quick-edit.js";
import { getToolsRenderConfig } from "./session-config.js";
import { formatDiffStatsPair } from "./shared.js";

export interface TurnMemberInfo {
	readonly toolCallId: string;
	readonly toolName: string;
	/** Whether a tool result was registered for this call (run completeness). */
	readonly hasResult: boolean;
	isError: boolean;
	/** Frozen wall-clock elapsed (ms), recorded from the renderer context state. */
	elapsedMs?: number;
	/** Frozen diff line stats recorded from the tool result (edit family). */
	diffStats?: { additions: number; removals: number } | undefined;
	/** Normalized read path (ADR 0010): chunked reads of one file summarize as
	 *  one file, not one per chunk. */
	pathKey?: string;
}

export interface TurnState {
	/**
	 * First non-error member that collapses under the current render config
	 * (mutating members are skipped unless `tools.collapseMutatingTools` is
	 * on); renders the summary line. Empty when every member errored or when
	 * the turn's members are all mutating with the exemption active (such a
	 * turn collapses nothing).
	 */
	leaderId: string;
	ended: boolean;
	members: readonly TurnMemberInfo[];
	/** Assistant messages that contributed members, in run order. Set when the
	 * run finalizes; consumed by the merged summary bridge to attribute each
	 * message's tool stats to its thought segment. */
	messages?: readonly object[];
	/** Fallback disclosure state for renderers without a native expansion
	 * control, and the tools-only/legacy header affordance. Captured native
	 * render-context flags take precedence (Ctrl+O can always re-close). */
	forcedOpen: boolean;
}

/** One assistant message's slice of a run: its message identity + members. */
interface RunSegment {
	readonly message: object;
	readonly members: readonly TurnMemberInfo[];
}

/**
 * Tools that change the user's files. Their blocks are the record of what was
 * done — they stay visible after the turn and are excluded from the summary
 * unless `tools.collapseMutatingTools` is on. bash is deliberately NOT here:
 * read-only and mutating commands are indistinguishable without parsing the
 * command text.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "quick_edit", "substitute_edit", "target_edit"]);

/** Whether the tool changes the user's files (exempt from turn collapse). */
export function isMutatingTool(toolName: string): boolean {
	return MUTATING_TOOLS.has(toolName);
}

/** Whether the summary should also cover mutating tools (render config). */
function mutatingCollapses(): boolean {
	return getToolsRenderConfig().collapseMutatingTools;
}

interface TurnEntry {
	readonly turn: TurnState;
	readonly member: TurnMemberInfo;
}

const memberByCallId = new Map<string, TurnEntry>();

/** message → the turns its tool calls belong to. Lets the merged thought
 *  label (`◈ … · Called N tools`) toggle the run's tool blocks on click
 *  without the messages feature importing the turn registry directly. */
let turnsByMessage = new WeakMap<object, Set<TurnState>>();

interface MemberExpansion {
	setExpanded(open: boolean): void;
	isExpanded(): boolean;
}

// Native flags, not an independent click-open boolean, own tool visibility.
// This lets Ctrl+O and individual tool clicks compose with the run disclosure.
const expansionByCallId = new Map<string, MemberExpansion>();

export function noteTurnMemberExpansion(toolCallId: string, expansion: MemberExpansion): void {
	expansionByCallId.set(toolCallId, expansion);
	const turn = memberByCallId.get(toolCallId)?.turn;
	// Pi's global Ctrl+O can close a click-opened run without going through our
	// disclosure handler. Once every native member is closed, release the run's
	// compact-view override so a subsequent Ctrl+O opens full tool output again.
	if (
		turn?.forcedOpen &&
		!expansion.isExpanded() &&
		turn.members.every((member) => {
			const control = expansionByCallId.get(member.toolCallId);
			return control !== undefined && !control.isExpanded();
		})
	)
		turn.forcedOpen = false;
}

export function isTurnMemberExpanded(toolCallId: string): boolean {
	return expansionByCallId.get(toolCallId)?.isExpanded() === true;
}

export function effectiveTurnExpansion(toolCallId: string, expanded: boolean): boolean {
	if (expansionByCallId.has(toolCallId)) return expanded;
	return expanded || getTurnEntry(toolCallId)?.turn.forcedOpen === true;
}

function turnIsOpen(turn: TurnState): boolean {
	return turn.members.some((member) => {
		const control = expansionByCallId.get(member.toolCallId);
		return control ? control.isExpanded() : turn.forcedOpen;
	});
}

function attributeTurnMessage(message: object, turn: TurnState): void {
	let turns = turnsByMessage.get(message);
	if (!turns) {
		turns = new Set();
		turnsByMessage.set(message, turns);
	}
	turns.add(turn);
}

/** Set a turn's click-open state, invalidating every member when it flips. */
function setTurnOpen(turn: TurnState, open: boolean): boolean {
	if (!turn.ended) return false;
	let changed = turn.forcedOpen !== open;
	turn.forcedOpen = open;
	for (const member of turn.members) {
		const control = expansionByCallId.get(member.toolCallId);
		if (!control || control.isExpanded() === open) continue;
		try {
			control.setExpanded(open);
		} catch {
			// A detached native component cannot prevent the remaining run from
			// opening/closing. Its renderer falls back to the run override.
			expansionByCallId.delete(member.toolCallId);
		}
		changed = true;
	}
	if (changed) invalidateTurnMembers(turn);
	return changed;
}

/** Toggle every ended turn whose members belong to these messages (the
 *  merged thought-label click: `◈ … · Called N tools`). The turns flip as one
 *  coherent unit — any open member closes the whole set, all closed opens it.
 *  Returns whether any turn flipped. */
function turnsForMessages(messages: readonly object[]): Set<TurnState> {
	const turns = new Set<TurnState>();
	for (const message of messages) {
		for (const turn of turnsByMessage.get(message) ?? []) if (turn.ended) turns.add(turn);
	}
	return turns;
}

export function turnsOpenForMessages(messages: readonly object[]): boolean {
	return [...turnsForMessages(messages)].some(turnIsOpen);
}

export function toggleTurnsForMessages(messages: readonly object[], open?: boolean): boolean {
	const turns = turnsForMessages(messages);
	const expand = open ?? ![...turns].some(turnIsOpen);
	let flipped = false;
	for (const turn of turns) if (setTurnOpen(turn, expand)) flipped = true;
	return flipped;
}

/** Per-member component invalidate callbacks captured during render passes. */
const invalidateByCallId = new Map<string, () => void>();

/** Reset all turn state (session start/shutdown). */
export function resetTurnRegistry(): void {
	memberByCallId.clear();
	invalidateByCallId.clear();
	expansionByCallId.clear();
	turnsByMessage = new WeakMap();
	currentRun = undefined;
	currentRunSegments = [];
	resetSummaryBridge();
}

interface ToolCallLike {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly name?: unknown;
	readonly arguments?: unknown;
}

function toolCallsOf(message: unknown): ToolCallLike[] {
	if (!message || typeof message !== "object") return [];
	const content = (message as { readonly content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const calls: ToolCallLike[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as ToolCallLike;
		if (candidate.type === "toolCall") calls.push(candidate);
	}
	return calls;
}

/** Tool-result fields the registry consumes (ToolResultMessage subset). */
export interface TurnResultLike {
	readonly toolCallId: string;
	readonly isError?: boolean;
	readonly content?: readonly unknown[] | undefined;
	readonly details?: unknown;
}

/** Result facts per tool call id: presence, error flag, and raw payload. */
interface RawMemberResult {
	readonly isError: boolean;
	readonly content?: readonly unknown[] | undefined;
	readonly details?: unknown;
}

/**
 * Extract a mutating member's diff line stats from its tool result — the
 * same sources the box renderers read: `details.diff` for `edit`, the
 * parsed `── diff ──` output section for the quick-edit family. `write`
 * carries no diff and yields undefined. Pure: no render-time work.
 */
function diffStatsFromResult(
	toolName: string,
	result: RawMemberResult | undefined,
): { additions: number; removals: number } | undefined {
	if (!result) return undefined;
	if (isMutatingTool(toolName) && toolName !== "write") {
		const diff = (result.details as { diff?: unknown } | undefined)?.diff;
		if (typeof diff === "string" && diff.length > 0) return countDiffStats(diff);
	}
	if (getQuickEditToolConfig(toolName)) {
		const text = Array.isArray(result.content)
			? firstText(result.content as Array<{ type: string; text?: string }>)
			: "";
		const diff = text ? extractQuickEditDiff(text) : undefined;
		if (diff) return countDiffStats(diff);
	}
	return undefined;
}

/** Normalized path key of a read call: chunked reads of one file (different
 *  raw forms of the same path) map to one key, so the summary counts files,
 *  not chunks (ADR 0010). */
function readPathKeyOf(call: ToolCallLike): string | undefined {
	if (call.name !== "read" || !call.arguments || typeof call.arguments !== "object") return undefined;
	const args = call.arguments as Record<string, unknown>;
	const raw =
		typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
	if (raw === undefined || raw.length === 0) return undefined;
	return raw.replace(/^\.\//, "");
}

function buildMembers(
	calls: readonly ToolCallLike[],
	resultsById: ReadonlyMap<string, RawMemberResult>,
): TurnMemberInfo[] {
	return calls.map((call) => {
		const toolCallId = String(call.id ?? "");
		const toolName = typeof call.name === "string" ? call.name : "tool";
		const result = resultsById.get(toolCallId);
		const pathKey = readPathKeyOf(call);
		return {
			toolCallId,
			toolName,
			hasResult: result !== undefined,
			isError: result?.isError === true,
			diffStats: result?.isError ? undefined : diffStatsFromResult(toolName, result),
			...(pathKey !== undefined ? { pathKey } : {}),
		};
	});
}

function registerTurn(
	calls: readonly ToolCallLike[],
	segments: readonly { message: object; calls: readonly ToolCallLike[] }[],
	resultsById: ReadonlyMap<string, RawMemberResult>,
	ended: boolean,
): TurnState | undefined {
	if (calls.length === 0) return undefined;
	const complete = calls.every((call) => typeof call.id === "string" && resultsById.has(String(call.id ?? "")));
	const members: TurnMemberInfo[] = buildMembers(calls, resultsById);
	const leader = members.find((member) => !member.isError && (!isMutatingTool(member.toolName) || mutatingCollapses()));
	const turn: TurnState = {
		leaderId: leader?.toolCallId ?? "",
		ended: ended && complete,
		members: Object.freeze(members),
		forcedOpen: false,
	};
	if (turn.ended) {
		// Publish the merged-summary bridge records for the restore path: the
		// live path publishes at finishAgentRun instead.
		const messageSegments = segments.filter((segment) => segment.calls.length > 0);
		turn.messages = messageSegments.map((segment) => segment.message);
		for (const segment of messageSegments) {
			attributeTurnMessage(segment.message, turn);
			publishSegmentStats({ message: segment.message, members: buildMembers(segment.calls, resultsById) });
		}
	}
	for (const member of members) memberByCallId.set(member.toolCallId, { turn, member });
	return turn;
}

/**
 * One summary group = one agent run (user request → `agent_end`). Pi emits
 * `turn_end` per assistant message, so tool batches of the same request are
 * appended to the same run and collapse into ONE summary line at `agent_end`.
 */
let currentRun: TurnState | undefined;
/** Per-message segments of the run in progress (parallel to `currentRun`). */
let currentRunSegments: RunSegment[] = [];

/** Live path: start a fresh run group (`agent_start`). */
export function beginAgentRun(): void {
	currentRun = undefined;
	currentRunSegments = [];
}

/**
 * Live path: append the finalized assistant message's tool calls and results
 * to the current run (`turn_end` event). The run stays expanded until
 * `finishAgentRun`; a batch interrupted mid-tool never collapses.
 *
 * Stats publish HERE (not only at `finishAgentRun`): text-split thought
 * segments can render their aggregate mid-run, and a mid-conversation
 * `agent_start` re-fire resets the run — publishing per turn_end keeps every
 * registered segment's stats visible to the merged labels regardless of when
 * (or whether) the run finalizes cleanly.
 */
export function registerTurnFromMessage(message: unknown, toolResults: readonly TurnResultLike[]): void {
	const calls = toolCallsOf(message);
	if (calls.length === 0) return;
	const resultsById = new Map<string, RawMemberResult>();
	for (const result of toolResults) {
		if (typeof result?.toolCallId !== "string") continue;
		resultsById.set(result.toolCallId, {
			isError: result.isError === true,
			content: result.content,
			details: result.details,
		});
	}
	const newMembers: TurnMemberInfo[] = buildMembers(calls, resultsById);
	const leader = newMembers.find(
		(member) => !member.isError && (!isMutatingTool(member.toolName) || mutatingCollapses()),
	);
	if (!currentRun) {
		currentRun = {
			leaderId: leader?.toolCallId ?? "",
			ended: false,
			members: Object.freeze(newMembers),
			forcedOpen: false,
		};
	} else {
		if (currentRun.leaderId === "" && leader) currentRun.leaderId = leader.toolCallId;
		currentRun.members = Object.freeze([...currentRun.members, ...newMembers]);
	}
	if (message !== null && typeof message === "object") {
		currentRunSegments.push({ message, members: Object.freeze(newMembers) });
		attributeTurnMessage(message, currentRun);
	}
	for (const member of newMembers) memberByCallId.set(member.toolCallId, { turn: currentRun, member });
	// Publish immediately (mid-run visibility + reset immunity).
	if (message !== null && typeof message === "object")
		publishSegmentStats({ message, members: Object.freeze(newMembers) });
}

/**
 * Live path: finalize the current run (`agent_end`). Returns the run so the
 * caller can invalidate its blocks; undefined when the run had no tool calls
 * or is interrupted (a call without a result stays expanded).
 */
export function finishAgentRun(): TurnState | undefined {
	const run = currentRun;
	const segments = currentRunSegments;
	currentRun = undefined;
	currentRunSegments = [];
	if (!run) return undefined;
	// A member without a result means the run was interrupted before every call
	// settled; such a run never collapses.
	if (run.members.every((member) => member.hasResult)) {
		run.ended = true;
		run.messages = segments.map((segment) => segment.message);
		for (const segment of segments) attributeTurnMessage(segment.message, run);
		for (const segment of segments) publishSegmentStats(segment);
	}
	return run.ended ? run : undefined;
}

/** Publish one message's tool stats to the merged-summary bridge. The merged
 * line deliberately has no elapsed; per-tool terminal clocks freeze separately. */
function publishSegmentStats(segment: RunSegment): void {
	let additions = 0;
	let removals = 0;
	let diffMembers = 0;
	let failed = 0;
	for (const member of segment.members) {
		if (member.isError) failed++;
		if (member.diffStats !== undefined) {
			additions += member.diffStats.additions;
			removals += member.diffStats.removals;
			diffMembers++;
		}
	}
	publishMessageStats(segment.message, {
		calls: segment.members.length,
		failed,
		...(diffMembers > 0 ? { diff: { additions, removals } } : {}),
	});
}

interface TurnEntryLike {
	readonly type?: unknown;
	readonly message?: {
		readonly role?: unknown;
		readonly content?: unknown;
		readonly details?: unknown;
		readonly stopReason?: unknown;
		readonly toolCallId?: unknown;
		readonly isError?: unknown;
	};
}

/**
 * Restore path: rebuild the registry from session entries (session start /
 * `session_tree`). Consecutive assistant messages between user messages form
 * one run; a run is ended when every tool call has a result AND a later user
 * message exists (historical) or its last assistant message is finalized
 * (`stopReason`). The currently streaming run stays expanded.
 */
export function rebuildTurnRegistryFromEntries(entries: readonly TurnEntryLike[] | undefined): void {
	memberByCallId.clear();
	turnsByMessage = new WeakMap();
	currentRun = undefined;
	currentRunSegments = [];
	resetSummaryBridge();
	if (!Array.isArray(entries)) return;
	const resultsById = new Map<string, RawMemberResult>();
	const runs: Array<{
		calls: ToolCallLike[];
		lastStopReason: string | undefined;
		followedByUser: boolean;
		segments: Array<{ message: object; calls: ToolCallLike[] }>;
	}> = [];
	let current: (typeof runs)[number] | undefined;
	const closeRun = () => {
		if (current && current.calls.length > 0) runs.push(current);
		current = undefined;
	};
	entries.forEach((entry) => {
		if (entry?.type !== "message") return;
		const message = entry.message;
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			resultsById.set(message.toolCallId, {
				isError: message.isError === true,
				content: Array.isArray(message.content) ? (message.content as readonly unknown[]) : undefined,
				details: message.details,
			});
		} else if (message?.role === "assistant") {
			if (!current) current = { calls: [], lastStopReason: undefined, followedByUser: false, segments: [] };
			const calls = toolCallsOf(message);
			current.calls.push(...calls);
			current.segments.push({ message, calls });
			current.lastStopReason =
				typeof message.stopReason === "string" && message.stopReason !== "" ? message.stopReason : undefined;
		} else if (message?.role === "user") {
			if (current) {
				current.followedByUser = true;
				closeRun();
			} else {
				// A user message with no preceding open run is a plain boundary.
				closeRun();
			}
		}
	});
	closeRun();
	for (const run of runs) {
		const complete = run.calls.every((call) => typeof call.id === "string" && resultsById.has(String(call.id ?? "")));
		const ended = complete && (run.followedByUser || run.lastStopReason !== undefined);
		registerTurn(run.calls, run.segments, resultsById, ended);
	}
	// Branch switches may retain components for common ancestors, but never
	// keep expansion/invalidation closures for tools outside the active branch.
	for (const id of invalidateByCallId.keys()) if (!memberByCallId.has(id)) invalidateByCallId.delete(id);
	for (const id of expansionByCallId.keys()) if (!memberByCallId.has(id)) expansionByCallId.delete(id);
}

/** Registry lookup for the render dispatcher. */
export function getTurnEntry(toolCallId: string): TurnEntry | undefined {
	return memberByCallId.get(toolCallId);
}

/**
 * Capture a member's component invalidate callback during a render pass. Pi
 * only re-invokes the tool renderer selectors from updateDisplay(); calling
 * the captured callback after turn_end rebuilds the block with the collapsed
 * summary. Idempotent per toolCallId (latest component wins).
 */
export function noteTurnMemberRender(toolCallId: string, invalidate: () => void): void {
	if (typeof invalidate !== "function") return;
	invalidateByCallId.set(toolCallId, invalidate);
}

/**
 * Force the just-finished turn's tool blocks to re-render (updateDisplay).
 * Components that never rendered (headless/print) have no captured callback.
 */
export function invalidateTurnMembers(turn: TurnState): void {
	for (const member of turn.members) {
		const invalidate = invalidateByCallId.get(member.toolCallId);
		if (!invalidate) continue;
		try {
			invalidate();
		} catch {
			// A detached component must not break the turn-end path.
			invalidateByCallId.delete(member.toolCallId);
		}
	}
}

/** Refresh retained tool components after a branch/registry rebuild. */
export function invalidateRegisteredTurnMembers(): void {
	const turns = new Set([...memberByCallId.values()].map((entry) => entry.turn));
	for (const turn of turns) invalidateTurnMembers(turn);
}

/**
 * Drop the turn's captured invalidate callbacks. NOT called on the live
 * agent_end path anymore: the callbacks must survive so the summary-row
 * click toggle (`toggleTurnOpen`) can re-dispatch every member later. Kept
 * as an explicit teardown seam for hosts/tests; a missing callback is
 * skipped gracefully by invalidateTurnMembers.
 */
export function releaseTurnInvalidators(turn: TurnState): void {
	for (const member of turn.members) invalidateByCallId.delete(member.toolCallId);
}

/**
 * Freeze a member's wall-clock elapsed into the registry (idempotent; the
 * value is frozen by the renderer state once the terminal result rendered).
 */
export function noteTurnMemberElapsed(toolCallId: string, elapsedMs: number | undefined): void {
	if (elapsedMs === undefined) return;
	const entry = memberByCallId.get(toolCallId);
	if (!entry || entry.member.elapsedMs !== undefined) return;
	entry.member.elapsedMs = elapsedMs;
}

/** Per-tool summary phrasing: `Read 2 files` / `ran 4 shell commands`. */
const TURN_SUMMARY_STYLE: Readonly<Record<string, { readonly verb: string; readonly unit: string }>> = Object.freeze({
	read: { verb: "Read", unit: "file" },
	bash: { verb: "ran", unit: "shell command" },
	ls: { verb: "Listed", unit: "path" },
	find: { verb: "Found", unit: "file" },
	grep: { verb: "Grepped", unit: "pattern" },
	edit: { verb: "Edited", unit: "file" },
	write: { verb: "Wrote", unit: "file" },
	quick_edit: { verb: "Edited", unit: "file" },
	substitute_edit: { verb: "Edited", unit: "file" },
	target_edit: { verb: "Edited", unit: "file" },
});

export interface TurnSummaryParts {
	/** `Read 2 files`, `ran 4 shell commands`, ... in first-use order. */
	readonly parts: readonly string[];
	readonly failedCount: number;
	/** Sum of members' frozen elapsed; undefined when nothing was recorded. */
	readonly elapsedMs: number | undefined;
	/** Aggregate diff line stats over non-error edit-family members; undefined
	 * when none carried a diff. Collected regardless of the mutating exemption:
	 * visible edit blocks are exactly what these stats describe. */
	readonly diffStats: { additions: number; removals: number } | undefined;
}

/**
 * Aggregate a turn's collapsed members into summary parts (pure). Mutating
 * members are excluded from counts/elapsed unless `tools.collapseMutatingTools`
 * is on — by default their visible blocks are the record; the summary counts
 * only what it hides. Their diff stats aggregate either way.
 */
export function turnSummaryParts(turn: TurnState): TurnSummaryParts {
	const counts = new Map<string, number>();
	const order: string[] = [];
	let failedCount = 0;
	let elapsedMs: number | undefined;
	let diffAdditions = 0;
	let diffRemovals = 0;
	let diffMembers = 0;
	const collapseMutating = mutatingCollapses();
	const readSeenPaths = new Set<string>();
	for (const member of turn.members) {
		if (member.isError) {
			failedCount++;
			continue;
		}
		if (member.diffStats !== undefined) {
			diffAdditions += member.diffStats.additions;
			diffRemovals += member.diffStats.removals;
			diffMembers++;
		}
		if (!collapseMutating && isMutatingTool(member.toolName)) continue;
		if (member.elapsedMs !== undefined) elapsedMs = (elapsedMs ?? 0) + member.elapsedMs;
		// Chunked reads of one file count once (after elapsed aggregation — every
		// chunk's time still contributes).
		if (member.toolName === "read" && member.pathKey !== undefined) {
			if (readSeenPaths.has(member.pathKey)) continue;
			readSeenPaths.add(member.pathKey);
		}
		const existing = counts.get(member.toolName);
		if (existing === undefined) {
			counts.set(member.toolName, 1);
			order.push(member.toolName);
		} else counts.set(member.toolName, existing + 1);
	}
	const parts = order.map((toolName) => {
		const count = counts.get(toolName) ?? 0;
		const style = TURN_SUMMARY_STYLE[toolName];
		// Unknown tools (extension tools like TaskCreate/ask_user_question) use a
		// neutral phrasing with the invariant tool name: `used 5 TaskCreate`.
		return style ? `${style.verb} ${count} ${pluralForm(style.unit, count)}` : `used ${count} ${toolName}`;
	});
	return {
		parts,
		failedCount,
		elapsedMs,
		diffStats: diffMembers > 0 ? { additions: diffAdditions, removals: diffRemovals } : undefined,
	};
}

function formatTurnSummaryLine(theme: BoxTheme, turn: TurnState): string {
	const summary = turnSummaryParts(turn);
	if (getToolsRenderConfig().mergedTurnSummary) {
		return theme.fg(
			"dim",
			mergedSummaryText(getToolsRenderConfig().mergedSummaryGlyph, 0, {
				calls: turn.members.length,
				failed: summary.failedCount,
				...(summary.diffStats ? { diff: summary.diffStats } : {}),
			}),
		);
	}
	// The summary is deliberately quiet: the whole line renders dim so completed
	// tool work recedes behind the assistant's answer. Only the diff stats
	// (`+N` added / `-M` removed) and the failed marker stay color-coded —
	// changes and errors must remain visible at a glance.
	const parts = summary.parts.join(", ");
	let line = `${theme.fg("dim", `➔ ${parts}`)}`;
	if (summary.diffStats !== undefined)
		line += `${theme.fg("dim", " · Edit ")}${formatDiffStatsPair(theme, summary.diffStats.additions, summary.diffStats.removals)}`;
	if (summary.failedCount > 0)
		line += theme.fg("error", ` · ${summary.failedCount} ${pluralForm("failure", summary.failedCount)}`);
	if (summary.elapsedMs !== undefined) line += theme.fg("dim", ` · ${(summary.elapsedMs / 1000).toFixed(2)}s`);
	return line;
}

/** Toggle a finalized turn between its one-line summary and the expanded
 *  member boxes (click on the summary row). Invalidates every member so each
 *  re-dispatches through the collapse gate; the leader re-renders its toggle
 *  row, members their boxes (open) or nothing (closed). */
export function toggleTurnOpen(turn: TurnState): void {
	if (!turn.ended) return;
	setTurnOpen(turn, !turnIsOpen(turn));
}

/** Leader call component: renders the live turn summary line on every pass.
 *  Clicking the row toggles the whole turn open/closed (the handler consumes
 *  the click before Pi's native per-box toggle, which would otherwise flip
 *  only this one component and render a single solo tool). */
export function renderTurnSummaryCall(theme: BoxTheme, turn: TurnState): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			return [safeTruncateToWidth(formatTurnSummaryLine(theme, turn), Math.max(1, width), "…")];
		},
		handleMouse(event) {
			if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
			toggleTurnOpen(turn);
			return { handled: true };
		},
	};
}

/** Forced-open leader call component: the summary row stays rendered above
 *  the leader's normal call lines so the turn can be closed again by clicking
 *  it (the affordance the closed state always had). Row 0 is the toggle; the
 *  remaining rows forward to the child with the row offset removed. */
export function renderTurnToggleRow(theme: BoxTheme, turn: TurnState, child: Component): Component {
	return {
		invalidate() {
			child.invalidate();
		},
		render(width: number): string[] {
			return [safeTruncateToWidth(formatTurnSummaryLine(theme, turn), Math.max(1, width), "…"), ...child.render(width)];
		},
		handleMouse(event) {
			if (event.y === 0) {
				if (event.type === "click" && event.button === "left") {
					toggleTurnOpen(turn);
					return { handled: true };
				}
				return undefined;
			}
			return child.handleMouse?.({ ...event, y: event.y - 1 });
		},
	};
}

/**
 * Empty result component for the turn-summary leader. The summary lives in the
 * call component; the result adds nothing. Deliberately NOT the shared
 * EMPTY_BATCH_COMPONENT singleton, so the decoration's hideBatchMember
 * (identity-compared) never hides the leader.
 */
export function emptyTurnResult(): Component {
	return {
		invalidate() {},
		render() {
			return [];
		},
	};
}

// Expose the message→turn toggle through the bridge so the merged thought
// label (`◈ … · Called N tools`) can open/close the run's tool blocks without
// the messages feature importing this registry (depcruise: sibling features).
registerTurnToggleHandler(toggleTurnsForMessages, turnsOpenForMessages);
