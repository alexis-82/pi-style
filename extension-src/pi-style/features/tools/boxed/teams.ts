// Presentation-only adapters for pi-teams tools. Never read its files or own its run state.
import { pathToFileURL } from "node:url";
import type { Component } from "@earendil-works/pi-tui";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { fgHex, isHexColor, stripAnsi } from "../../../shared/ansi.js";
import type { BoxTheme } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import { type BatchToolMeta, EMPTY_BATCH_COMPONENT, registerBatchCall, registerBatchResult } from "./batch.js";
import { compactToolPath } from "./path.js";
import { isResultSeen, markResultSeen, teamEventGlyph } from "./session-config.js";
import type { BoxedToolDefinition, BoxedToolResult } from "./shared.js";
import { formatDuration, formatTokens, normalizeModelLabel, normalizePreview } from "./shared.js";
import {
	hasTeammateRunHandle,
	rememberTaskRuns,
	rememberTeammateIdentity,
	rememberTeammateResult,
	rememberTeammateRun,
	rememberTeammateRunHandle,
	settlementForRun,
	settleTeammateRun,
	type TeammateRunSettlement,
	teammateColorForName,
	teammateColorForRun,
	teammateForRun,
} from "./team-run-labels.js";

export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set([
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"send_message",
	"peer_sessions",
	"peer_send",
	"peer_activity",
	"teammate_status",
	"teammate_release",
	"teammate_shutdown",
	"list_models",
	"tasks_create",
	"tasks_list",
	"tasks_get",
	"tasks_update",
	"tasks_cancel",
	"tasks_execute",
	"tasks_output",
	"tasks_stop",
	// Legacy names remain presentation-only aliases for saved sessions.
	"teammate_retire",
	"team_task_create",
	"team_task_update",
	"team_task_get",
	"team_task_list",
]);

const agentMeta = (mode: string): BatchToolMeta => ({
	toolName: `Agent:${mode}`,
	label: "Teammate",
});
const empty: Component = { render: () => [], invalidate() {} };
const clean = (value: unknown, limit = 220): string =>
	typeof value === "string"
		? stripAnsi(value)
				.replace(/\p{Cc}/gu, " ")
				.trim()
				.slice(0, limit)
		: "";
const short = (value: unknown): string => clean(value, 24);
const physicalLines = (value: string): string[] =>
	stripAnsi(value)
		.split(/\r\n|\r|\n/)
		.map((line) => line.replace(/\p{Cc}/gu, " "));
const rawText = (result: BoxedToolResult): string =>
	(result.content ?? [])
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
const details = (result: BoxedToolResult): Record<string, unknown> =>
	result.details && typeof result.details === "object" && !Array.isArray(result.details)
		? (result.details as Record<string, unknown>)
		: {};
// Do not assume the pi-teams setting backgroundByDefault: omission does not
// establish an effective mode. Explicit modes split adjacent batches.
const modeKey = (args: Record<string, unknown>): "background" | "foreground" | "unspecified" =>
	args.run_in_background === true ? "background" : args.run_in_background === false ? "foreground" : "unspecified";
// An absent pi-teams color gets the theme's generic accent, not an invented
// teammate-specific color. Keep the ANSI span limited to the @reference.
const styledTeammate = (theme: BoxTheme, label: string, color?: unknown): string =>
	typeof color === "string" && isHexColor(color) ? fgHex(theme, color, label) : theme.fg("accent", label);

function rows(lines: () => string[], max = 8): Component {
	return {
		invalidate() {},
		render(width: number) {
			if (width < 8) return [];
			return lines()
				.slice(0, max)
				.map((line) => safeTruncateToWidth(line, width));
		},
	};
}
function simple(text: string, theme: BoxTheme): Component {
	return rows(() => [theme.fg("dim", text)], 1);
}
/** Expanded team detail text is dim; a row the producer already tinted
 *  (error/warning checks, artifact links) keeps its emphasis. */
const dimPlain = (theme: BoxTheme, line: string): string =>
	line.trim() && !line.includes("\x1b[") ? theme.fg("dim", line) : line;

/** Hanging detail block: the first non-blank row carries the dim `└─` branch and
 *  every later row aligns under it. Blank rows stay blank. */
function hangingBody(theme: BoxTheme, rows: readonly string[], indent = ""): string[] {
	const first = rows.findIndex((row) => row.trim() !== "");
	return rows.map((row, index) => {
		const text = row.replace(/\s+$/, "");
		if (!text.trim()) return "";
		const branch = theme.fg("dim", `${indent}${index === first ? "└─" : "  "}`);
		return `${branch} ${theme.fg("dim", text)}`;
	});
}
function agentDetail(args: Record<string, unknown>, theme: BoxTheme, result?: BoxedToolResult): string {
	const data = details(result ?? {});
	const who = short(data.teammateName) || short(args.name);
	const description = clean(args.description, 100);
	// Distinguish only explicit context policy or explicit cold-resume intent.
	const intent =
		typeof args.resume === "string"
			? "resume"
			: args.context === "fresh"
				? "fresh"
				: args.context === "continue"
					? "continue"
					: "";
	// Color and name are optional metadata from the owning runtime, never
	// inferred from specialist definitions or teammate names.
	const parts = [who ? styledTeammate(theme, `@${who}`, data.color) : description || theme.fg("dim", "Teammate")];
	if (who && description) parts.push(description);
	// Only the admitted model is authoritative; the canonical ref stays in the
	// detail and collapsed rows clip it to the short label (§3/§6).
	if (typeof data.model === "string") parts.push(clean(data.model, 120));
	if (intent) parts.push(theme.fg("dim", intent));
	if (typeof data.thinking === "string") parts.push(theme.fg("dim", `thinking ${short(data.thinking)}`));
	// Definition pins override max_turns in the invocation. Only an effective
	// limit published by pi-teams is safe to label as the actual maximum.
	if (typeof data.maxTurns === "number" && Number.isSafeInteger(data.maxTurns) && data.maxTurns > 0)
		parts.push(theme.fg("dim", `max ${data.maxTurns} turns`));
	return parts.join(" · ");
}

/** Run-level settlement state of one Agent member (ADR 0012 §1/§5): the glyph
 *  tracks the run, not the tool call — `◌` while a live handle exists, `●`/`✗`/
 *  `○` once settled, `●` from admission when no live state exists (resume). */
function memberEvent(
	member: { runId?: string; isError?: boolean },
	live: boolean,
): {
	glyph: string;
	color: string;
	settlement?: TeammateRunSettlement;
} {
	const settlement = member.runId ? settlementForRun(member.runId) : undefined;
	if (settlement) {
		if (settlement.outcome === "failed") return { glyph: teamEventGlyph("failed"), color: "error", settlement };
		if (settlement.outcome === "stopped") return { glyph: teamEventGlyph("stopped"), color: "dim", settlement };
		return { glyph: teamEventGlyph("settled"), color: "success", settlement };
	}
	if (member.isError) return { glyph: teamEventGlyph("failed"), color: "error" };
	// A live in-process handle means the run is still in flight; without one
	// (resume/replay) the row renders settled from admission, muted — the
	// notification alone claims an outcome. Pre-admission rows track the live
	// execution flag instead (hollow while running, settled on replay).
	const running = member.runId !== undefined ? hasTeammateRunHandle(member.runId) : live;
	return { glyph: teamEventGlyph(running ? "running" : "settled"), color: "muted" };
}

/** ` · 2m 03s · ↓146.5k` line tail from settlement data; absent producer
 *  fields are omitted silently (never fabricated, ADR 0012 §1/§4). */
function settlementTail(settlement: TeammateRunSettlement | undefined): string {
	if (!settlement) return "";
	const parts = [formatDuration(settlement.durationMs), formatTokens(settlement.totalTokens)].filter(
		(part): part is string => part !== undefined,
	);
	return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** Collapsed rows clip the member's admitted model to its short label;
 *  expanded rows keep the canonical full ref (authoritative for Agent.model). */
function memberDetail(member: { detail: string; modelRef?: string }, expanded: boolean): string {
	if (expanded || !member.modelRef) return member.detail;
	return member.detail.split(member.modelRef).join(normalizeModelLabel(member.modelRef));
}

function agentLine(
	theme: BoxTheme,
	batch: {
		leaderId: string;
		members: readonly {
			toolCallId: string;
			detail: string;
			modelRef?: string;
			runId?: string;
			effectiveMode?: "background" | "foreground";
			isError?: boolean;
			errorText?: string;
			noticeText?: string;
			resultText?: string;
			receiptText?: string;
		}[];
	},
	expanded: boolean,
	live: boolean,
): string[] {
	const members = batch.members;
	const events = members.map((member) => memberEvent(member, live));
	const settledCount = events.filter((event, i) => {
		const member = members[i];
		return Boolean(event.settlement || member?.isError || (member?.runId && !hasTeammateRunHandle(member.runId)));
	}).length;
	const failedCount = events.filter((event, i) => event.settlement?.outcome === "failed" || members[i]?.isError).length;
	const headEvent = failedCount
		? { glyph: teamEventGlyph("failed"), color: "error" }
		: settledCount === members.length && members.length > 0
			? { glyph: teamEventGlyph("settled"), color: "success" }
			: { glyph: teamEventGlyph("running"), color: "muted" };
	const max = expanded ? members.length : Math.min(3, members.length);
	const lines: string[] = [];
	if (members.length === 1) {
		const event = events[0] ?? { glyph: teamEventGlyph("running"), color: "muted" };
		const member = members[0];
		lines.push(
			`${theme.fg(event.color, event.glyph)} Agent ${member ? memberDetail(member, expanded) : ""}${settlementTail(event.settlement)}`,
		);
	} else {
		lines.push(
			`${theme.fg(headEvent.color, headEvent.glyph)} Agent (${members.length}) · ${settledCount}/${members.length}`,
		);
		for (let i = 0; i < max; i++) {
			const event = events[i] ?? { glyph: teamEventGlyph("running"), color: "muted" };
			const member = members[i];
			// Tree glyphs are structure, never emphasis: they stay dim while the
			// status glyph and the identity keep their tints.
			lines.push(
				`${theme.fg("dim", i === members.length - 1 ? "└─" : "├─")} ${theme.fg(event.color, event.glyph)} ${member ? memberDetail(member, expanded) : ""}${settlementTail(event.settlement)}`,
			);
		}
		if (max < members.length) lines.push(theme.fg("dim", `   … ${members.length - max} more · Ctrl+O to expand`));
	}
	for (const member of members) {
		const foreground = member.effectiveMode === "foreground";
		const ownLeader = member.toolCallId === batch.leaderId;
		const firstDetail = stripAnsi(member.detail).split(" · ", 1)[0] ?? "";
		const attribution = firstDetail.startsWith("@") ? firstDetail : "teammate";
		const appendReceipt = (kind: string, value: string, color: string): void => {
			const receiptLines = expanded ? physicalLines(value) : [clean(value, 160)];
			lines.push(theme.fg("dim", `   └─ ${attribution}`));
			lines.push(
				...receiptLines.map((line, index) => theme.fg(color, `      ${index === 0 ? `${kind}: ` : ""}${line}`)),
			);
		};
		if (member.isError && member.errorText) appendReceipt("ERROR", member.errorText, "error");
		if (member.noticeText) appendReceipt("NOTICE", member.noticeText, "warning");
		if (member.receiptText) appendReceipt("RECEIPT", member.receiptText, "dim");
		if (member.resultText && foreground && !ownLeader) appendReceipt("Answer", member.resultText, "dim");
	}
	if (lines.length > 10000) {
		const omitted = lines.length - 9999;
		lines.splice(9999);
		lines.push(`… ${omitted} teammate receipt lines omitted`);
	}
	return lines;
}

export const agentTool: BoxedToolDefinition = {
	call(args, theme, context) {
		const mode = modeKey(args);
		const known = context.state.teamAgentDetails;
		const cached = known && typeof known === "object" ? { details: known } : undefined;
		const { batch, isLeader } = registerBatchCall(agentMeta(mode), agentDetail(args, theme, cached), context);
		const self = batch.members.find((item) => item.toolCallId === context.toolCallId);
		const cachedData = details(cached ?? {});
		if (self && typeof cachedData.model === "string") self.modelRef = clean(cachedData.model, 120);
		if (self && typeof cachedData.agentId === "string") self.runId = cachedData.agentId;
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return rows(() => agentLine(theme, batch, context.expanded, context.executionStarted), 10000);
	},
	result(result, options, theme, context) {
		const mode = modeKey(context.args);
		// Save authoritative admission metadata on Pi's per-call renderer state,
		// so later call re-renders cannot erase it with invocation-only arguments.
		if (!options.isPartial && result.details && typeof result.details === "object") {
			context.state.teamAgentDetails = result.details;
			rememberTeammateRun(result.details, context.args);
		}
		const { batch } = registerBatchCall(agentMeta(mode), agentDetail(context.args, theme, result), context);
		const data = details(result);
		if (!options.isPartial) {
			const member = batch.members.find((item) => item.toolCallId === context.toolCallId);
			const confirmed =
				data.background === true
					? "background"
					: typeof data.agentId === "string"
						? "foreground"
						: mode === "unspecified"
							? undefined
							: mode;
			if (member && confirmed) member.effectiveMode = confirmed;
			// Run identity + admitted model key the row glyph and the short
			// collapsed label (ADR 0012 §3/§5).
			if (member && typeof data.model === "string") member.modelRef = clean(data.model, 120);
			if (member && typeof data.agentId === "string") member.runId = data.agentId;
		}
		const output = rawText(result);
		const failed = context.isError || data.status === "error" || !!data.error;
		const hasRunIdentity = typeof data.agentId === "string";
		const foreground = data.background === true ? false : hasRunIdentity || mode === "foreground";
		if (!options.isPartial && hasRunIdentity) {
			if (foreground) {
				// A foreground run settles with its own tool result — there is no
				// completion notification to supersede the row (ADR 0012 §5).
				settleTeammateRun(data.agentId, { outcome: failed ? "failed" : "completed" });
			} else if (context.executionStarted) {
				// A live background run stays hollow until the completion
				// notification supersedes it (ADR 0012 §5). Replayed results do
				// not register handles, so resumed rows render `●` from admission.
				rememberTeammateRunHandle(data.agentId, { state: context.state, invalidate: context.invalidate });
			}
		}
		const validationReceipt = !failed && !hasRunIdentity && data.background !== true && output.length > 0;
		const failureText = output || (typeof data.error === "string" ? data.error : "Agent admission failed");
		const notice = [
			data.modelFallback ? `model fallback ${clean(data.modelFallback, 120)}` : "",
			data.budgetExhausted
				? `budget exhausted${typeof data.budgetSeconds === "number" ? ` (${data.budgetSeconds}s)` : ""}`
				: "",
		]
			.filter(Boolean)
			.join(" · ");
		const critical = [failed ? `ERROR ${clean(failureText, 160)}` : "", notice].filter(Boolean).join(" · ");
		registerBatchResult(
			agentMeta(mode),
			{
				isPartial: options.isPartial,
				isError: failed,
				errorText: failed ? failureText : undefined,
				...(notice ? { noticeText: notice } : {}),
				...(!failed && foreground && batch.leaderId !== context.toolCallId ? { resultText: output } : {}),
				...(validationReceipt ? { receiptText: output } : {}),
			},
			context,
		);
		const isLeader = batch.leaderId === context.toolCallId;
		if (!isLeader) return empty;
		if (options.isPartial) return empty;
		const outputLines = physicalLines(output);
		if (options.expanded && output && (foreground || failed || validationReceipt))
			return rows(() => {
				const detailLimit = critical ? 9998 : 9999;
				const omitted = Math.max(0, outputLines.length - detailLimit);
				return [
					...(critical ? [theme.fg(failed ? "error" : "warning", `└─ ${critical}`)] : []),
					...outputLines.slice(0, detailLimit).map((line) => dimPlain(theme, line)),
					...(omitted ? [theme.fg("dim", `… ${omitted} diagnostic lines omitted`)] : []),
				];
			}, 10000);
		if (validationReceipt) return rows(() => [theme.fg("warning", `└─ RECEIPT: ${clean(output, 180)}`)], 1);
		if (critical && !foreground) return empty;
		if (critical && foreground)
			return rows(
				() => [theme.fg(failed ? "error" : "warning", `└─ ${critical}`), ...(output ? [clean(output, 160)] : [])],
				2,
			);
		if (output && foreground) return simple(`└─ ${clean(output, 160)}`, theme);
		return critical ? rows(() => [theme.fg(failed ? "error" : "warning", `└─ ${critical}`)], 1) : empty;
	},
};

function teammateLabel(args: Record<string, unknown>, key: "target" | "agent_id", theme: BoxTheme): string {
	if (key === "agent_id") {
		// A run id is an address, not an identity: resolve it to the admitted
		// teammate name. An unknown run keeps a short id so the value is never
		// mistaken for a teammate reference (Pi still receives the full id).
		const id = typeof args[key] === "string" ? args[key] : undefined;
		const resolved = teammateForRun(id);
		if (resolved)
			return styledTeammate(theme, `@${resolved}`, teammateColorForRun(id) ?? teammateColorForName(resolved));
		const compact = short(id);
		// No `@`: an unresolved run id must never read as a teammate reference.
		// UUIDs clip to a stable prefix so the value still identifies the run.
		const label = compact.length > 12 ? `${compact.slice(0, 8)}…` : compact;
		return label ? theme.fg("muted", label) : "teammate";
	}
	const value = short(args[key]);
	if (!value) return "teammate";
	if (value === "lead") return "lead";
	return styledTeammate(theme, `@${value}`, teammateColorForName(value));
}
/** Minimum-disclosure card shared by team messages and peer sends (ADR 0012
 *  §9): one head line, the body entirely behind expansion, receipts dropped
 *  because the settled glyph is the receipt. The body uses the thinking-quote
 *  rail language (2-space indent + `│ ` on every line including blanks). */
function cardLines(
	theme: BoxTheme,
	options: {
		head: string;
		body?: string | undefined;
		failure?: string | undefined;
		failurePrefix?: string | undefined;
		expanded: boolean;
	},
): string[] {
	const glyph = options.failure
		? theme.fg("error", teamEventGlyph("failed"))
		: theme.fg("muted", teamEventGlyph("settled"));
	const body = options.body?.trim() ? options.body : undefined;
	const headLine = options.failure
		? `${glyph} ${options.head} · ${options.failurePrefix ?? ""}${options.failure}`
		: `${glyph} ${options.head}`;
	if (!options.expanded)
		return [`${headLine}${body && !options.failure ? theme.fg("dim", " (Ctrl+O to expand)") : ""}`];
	// Expanded body: no rail glyph — a hanging dim block (first row `└─`, the rest
	// aligned) matches every other team card.
	return [headLine, ...(body ? hangingBody(theme, physicalLines(body)) : [])];
}
/** Producers may already spell out the failure (`Message not sent: …`); the
 *  card supplies its own prefix, so drop a leading duplicate instead of printing
 *  `not sent: Message not sent: …` (fail-closed: an all-prefix reason stays). */
function trimReceiptPrefix(reason: string, prefix: string): string {
	const label = prefix.trim().replace(/:$/, "");
	if (!reason) return "failed";
	if (!label) return reason;
	const pattern = new RegExp(`^(?:message\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:?\\s*`, "i");
	return reason.replace(pattern, "").trim() || reason;
}

function cardHeight(body: string | undefined, expanded: boolean): number {
	return expanded && body?.trim() ? 1 + physicalLines(body).length : 1;
}
function messageTool(
	key: "target" | "agent_id",
	head: (label: string) => string,
	failurePrefix: string,
	accepted: RegExp,
): BoxedToolDefinition {
	return {
		call: (args, theme, context) => {
			const label = teammateLabel(args, key, theme);
			const body = typeof args.message === "string" ? args.message : undefined;
			// The failure state is written by the result renderer; reading it inside
			// the render closure keeps the one-line card current (ADR 0012 §9).
			const render = (expanded: boolean): string[] =>
				cardLines(theme, {
					head: head(label),
					...(body !== undefined ? { body } : {}),
					...(typeof context.state.teamMessageFailure === "string"
						? { failure: context.state.teamMessageFailure }
						: {}),
					failurePrefix,
					expanded,
				});
			if (!context.expanded) return rows(() => render(false), 1);
			return rows(() => render(true), cardHeight(body, true));
		},
		result: (result, options, _theme, context) => {
			if (options.isPartial) return empty;
			const text = rawText(result);
			// Success stays quiet; a failure re-renders the call card loud via the
			// stored reason (ADR 0012 §9). Malformed text still degrades to a
			// cleaned plain reason — nothing is lost verbatim beyond the budget.
			if (!accepted.test(text)) context.state.teamMessageFailure = trimReceiptPrefix(clean(text, 200), failurePrefix);
			return empty;
		},
	};
}

export const sendMessageTool = messageTool(
	"target",
	(label) => `Message to ${label}`,
	"not sent: ",
	/^Message queued for @/,
);
export const steerTool = messageTool("agent_id", (label) => `Steer to ${label}`, "", /^Steering accepted/);

const peerLabel = (peerSessionId: unknown): string => {
	const value = clean(peerSessionId, 64);
	return value ? `peer ${value.slice(0, 8)}` : "peer";
};
/** Peer surfaces (presentation-only): independent `pi` sessions found in the
 *  configured peer scope. `peer_send` reuses the minimal message card; its body
 *  is untrusted plain text and only ever renders behind expansion. */
export const peerSessionsTool: BoxedToolDefinition = {
	call: (_args, theme) => rows(() => [`${theme.fg("muted", teamEventGlyph("settled"))} Peer sessions`], 1),
	result(result, options, theme) {
		if (options.isPartial) return empty;
		const text = textResult(result);
		const value = parseJson(text);
		if (!Array.isArray(value)) return rows(() => [theme.fg("dim", `└ ${clean(text, 200) || "no peers"}`)], 1);
		const peers = value.filter(isRecord);
		if (peers.length === 0) return rows(() => [theme.fg("dim", "└ no peer sessions")], 1);
		const limit = options.expanded ? peers.length : 3;
		const shown = peers.slice(0, limit);
		const lines = shown.map((peer, index) => {
			const name = clean(peer.displayName, 64) || clean(peer.peerSessionId, 64) || "peer";
			const facets = [clean(peer.status, 24), clean(peer.activity, 120)].filter(Boolean).join(" · ");
			return `${theme.fg("dim", index === 0 ? "└─" : "  ")} ${theme.fg("text", name)}${facets ? ` ${theme.fg("dim", facets)}` : ""}`;
		});
		if (peers.length > shown.length)
			lines.push(theme.fg("dim", `   … ${peers.length - shown.length} more · Ctrl+O to expand`));
		return rows(() => lines, limit + 1);
	},
};

export const peerSendTool: BoxedToolDefinition = {
	call(args, theme, context) {
		const head = `Peer message to ${theme.fg("muted", peerLabel(args.peerSessionId))}`;
		const body = typeof args.text === "string" ? args.text : undefined;
		const render = (expanded: boolean): string[] =>
			cardLines(theme, {
				head,
				...(body !== undefined ? { body } : {}),
				...(typeof context.state.teamPeerFailure === "string" ? { failure: context.state.teamPeerFailure } : {}),
				expanded,
			});
		if (!context.expanded) return rows(() => render(false), 1);
		return rows(() => render(true), cardHeight(body, true));
	},
	result(result, options, _theme, context) {
		if (options.isPartial) return empty;
		// A refused/unavailable/expired receipt is a loud failure; delivery stays quiet.
		const text = textResult(result);
		if (!/^Peer message (queued|held|delivered)/.test(text))
			context.state.teamPeerFailure = clean(text, 200) || "failed";
		return empty;
	},
};

export const peerActivityTool: BoxedToolDefinition = {
	call: (_args, theme) => rows(() => [`${theme.fg("muted", teamEventGlyph("settled"))} Peer activity`], 1),
	result(result, options, theme) {
		if (options.isPartial) return empty;
		const text = clean(textResult(result), options.expanded ? 2000 : 200) || "updated";
		return rows(() => [theme.fg("dim", `└ ${text}`)], 1);
	},
};

// get_subagent_result renders the formatted text record; pi-teams also publishes
// structured `details`, which keeps the run identity/color index current. A
// malformed or changed record remains accessible verbatim when expanded.
export const getAgentResultTool: BoxedToolDefinition = {
	call(args, theme, context) {
		return rows(() => {
			const label = teammateLabel(args, "agent_id", theme);
			// `◌ Get result @name` while waiting; `●` once the result exists (§8).
			const glyph = theme.fg("muted", teamEventGlyph(isResultSeen(context.state) ? "settled" : "running"));
			return [`${glyph} Get result ${label}${args.wait === true ? " · wait" : ""}`];
		}, 1);
	},
	result(result, options, theme, context) {
		markResultSeen(context.state);
		if (options.isPartial) return empty;
		const text = stripAnsi(rawText(result));
		if (result.details) rememberTeammateRun(result.details);
		rememberTeammateResult(context.args.agent_id, text);
		if (options.expanded)
			return rows(
				() =>
					hangingBody(
						theme,
						text
							.split("\n")
							// The head already names the teammate; only the run id stays, so a
							// steer/get call can still address the exact run.
							.filter((line) => !line.startsWith("Teammate: "))
							.map((line) => clean(line, 2000)),
					),
				10000,
			);
		// Collapsed: the shared preview collapse (§2) parses the record header as
		// labeled fields and drops identity/type noise so `@name` and the raw run id
		// never print twice (§8). Malformed records fall back to cleaned verbatim
		// lines. The run id stays available on expansion.
		const preview =
			normalizePreview(text, {
				dropFields: ["Type", "Teammate", "Agent", "Description", "Model", "Tool uses", "Duration"],
			}) ||
			clean(text, 160) ||
			"(no output)";
		return rows(() => [theme.fg("dim", `└ ${preview}`)], 1);
	},
};

type Task = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
const taskCode = (task: Task): string => clean(task.code ?? task.id, 32);
/** Status-aware task identity (mirrors pi-teams `taskIdentity`): a planned
 *  pending task names its assignee, a terminal task keeps the teammate that
 *  actually ran it, and everything else prefers the current owner. */
function taskIdentityName(task: Task): string | undefined {
	const attempts = Array.isArray(task.attempts) ? task.attempts : [];
	const latest = attempts.at(-1);
	const latestName = isRecord(latest) && typeof latest.teammateName === "string" ? latest.teammateName : undefined;
	const assignee = short(task.assignee) || undefined;
	const owner = short(task.owner) || undefined;
	const status = clean(task.status, 24);
	if (status === "completed" || status === "cancelled") return latestName ?? assignee ?? owner;
	if (status === "pending") return assignee;
	return owner ?? assignee ?? latestName;
}
/** Task status glyph — identical to the pi-teams table so the tool card and
 *  the inline Tasks widget never disagree: `○` open, `◌` blocked, `◐` claimed,
 *  `◉` live run, `◆` review, `✓`/`⊘`/`✗`/`■` terminal. */
function taskGlyph(task: Task, theme: BoxTheme): string {
	const status = clean(task.status, 24);
	const latest = Array.isArray(task.attempts) ? task.attempts.at(-1) : undefined;
	const latestStatus = isRecord(latest) ? clean(latest.status, 16) : "";
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "cancelled") return theme.fg("dim", "⊘");
	if (latestStatus === "running") return theme.fg("accent", "◉");
	if (latestStatus === "failed") return theme.fg("error", "✗");
	if (latestStatus === "stopped") return theme.fg("dim", "■");
	if (status === "in_progress") return theme.fg("accent", "◐");
	if (status === "in_review") return theme.fg("warning", "◆");
	if (Array.isArray(task.blockedBy) && task.blockedBy.length > 0) return theme.fg("warning", "◌");
	return theme.fg("muted", "○");
}
/** `◐ T3 @owner Title` — the shared task row used by the `tasks_list` card. */
function taskRowLine(task: Task, theme: BoxTheme): string {
	const who = taskIdentityName(task);
	const identity = who ? styledTeammate(theme, `@${who}`, teammateColorForName(who)) : theme.fg("muted", "unassigned");
	const blockers = (Array.isArray(task.blockedBy) ? task.blockedBy : []).map((item) => clean(item, 24)).filter(Boolean);
	const blocked = blockers.length > 0 ? ` ${theme.fg("warning", `← ${blockers.join(",")}`)}` : "";
	return `${taskGlyph(task, theme)} ${theme.fg("dim", taskCode(task))} ${identity} ${clean(task.title, 300)}${blocked}`;
}
/** `1 in progress, 5 open` — the board counts the `tasks_list` head lifts. */
function taskCountSegments(tasks: readonly Task[]): string {
	const count = (status: string) => tasks.filter((task) => clean(task.status, 24) === status).length;
	const counts = [
		[count("completed"), "done"],
		[count("in_progress"), "in progress"],
		[count("pending"), "open"],
		[count("in_review"), "in review"],
		[count("cancelled"), "cancelled"],
	] as const;
	return counts
		.filter(([value]) => value > 0)
		.map(([value, label]) => `${value} ${label}`)
		.join(", ");
}
function taskSummary(task: Task, theme: BoxTheme): string {
	const parts = [taskCode(task), clean(task.title, 90), clean(task.status, 24)];
	const owner = short(task.owner ?? task.assignee);
	if (owner) parts.push(styledTeammate(theme, `@${owner}`));
	const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : [];
	if (blockers.length) parts.push(`blocked by ${blockers.map((item) => clean(item, 24)).join(",")}`);
	return parts.filter(Boolean).join(" · ");
}
/** Full outcome dump used only by the tasks_get detail (ADR 0013: that
 *  surface's rendering stays byte-identical, so its audit shape is pinned
 *  here instead of following the delta-card formatter below). */
function auditOutcomeLines(outcome: unknown, theme: BoxTheme, expanded = false): string[] {
	if (!isRecord(outcome)) return [];
	const lines: string[] = [];
	const appendText = (label: string, text: string) => {
		const physical = stripAnsi(text)
			.split("\n")
			.map((line) => clean(line, 2000));
		if (expanded)
			lines.push(`${label}${physical[0] ? ` ${physical[0]}` : ""}`, ...physical.slice(1).map((line) => `  ${line}`));
		else lines.push(`${label} ${clean(text, 300)}`);
	};
	if (typeof outcome.summary === "string") appendText("Summary:", outcome.summary);
	if (Array.isArray(outcome.artifacts))
		lines.push(`Artifacts: ${outcome.artifacts.map((x) => clean(x, 240)).join(", ")}`);
	if (Array.isArray(outcome.verification))
		for (const item of outcome.verification)
			if (isRecord(item)) {
				const prefix = `${item.outcome === "failed" ? "✗" : item.outcome === "passed" ? "✓" : "○"} `;
				const check =
					typeof item.check === "string"
						? stripAnsi(item.check)
								.split("\n")
								.map((line) => clean(line, 1000))
						: [""];
				const evidence =
					typeof item.evidence === "string"
						? stripAnsi(item.evidence)
								.split("\n")
								.map((line) => clean(line, 1000))
						: [];
				lines.push(`${prefix}${check[0] ?? ""}${evidence[0] ? ` — ${evidence[0]}` : ""}`);
				if (expanded)
					lines.push(...check.slice(1).map((line) => `  ${line}`), ...evidence.slice(1).map((line) => `  ${line}`));
			}
	if (Array.isArray(outcome.remainingIssues) && outcome.remainingIssues.length)
		for (const issue of outcome.remainingIssues) if (typeof issue === "string") appendText("Remaining:", issue);
	return lines.map((line) => theme.fg("dim", `  ${line}`));
}

/** Outcome compression (ADR 0013 §2): counts only — `4 checks: 4 passed ·
 *  1 issue remaining · 3 artifacts`. Failed checks never hide inside the
 *  counts; they also break out into their own loud rows (see failedCheckRows). */
function outcomeCompression(outcome: unknown): string {
	if (!isRecord(outcome)) return "";
	const segments: string[] = [];
	const verification = Array.isArray(outcome.verification) ? outcome.verification.filter(isRecord) : [];
	if (verification.length > 0) {
		const passed = verification.filter((item) => item.outcome === "passed").length;
		const failed = verification.filter((item) => item.outcome === "failed").length;
		segments.push(
			`${verification.length} check${verification.length === 1 ? "" : "s"}: ${passed} passed${failed > 0 ? ` · ${failed} failed` : ""}`,
		);
	}
	const issues = Array.isArray(outcome.remainingIssues) ? outcome.remainingIssues : [];
	if (issues.length > 0) segments.push(`${issues.length} issue${issues.length === 1 ? "" : "s"} remaining`);
	const artifacts = Array.isArray(outcome.artifacts) ? outcome.artifacts : [];
	if (artifacts.length > 0) segments.push(`${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`);
	return segments.join(" · ");
}

/** Every failed verification check as its own loud `✗ <check>` row (ADR 0013
 *  §2): successes compress, failures never do. */
function failedCheckRows(outcome: unknown, theme: BoxTheme): string[] {
	if (!isRecord(outcome) || !Array.isArray(outcome.verification)) return [];
	return outcome.verification
		.filter(isRecord)
		.filter((item) => item.outcome === "failed")
		.map((item) => (typeof item.check === "string" ? clean(item.check, 300) : ""))
		.filter(Boolean)
		.map((check) => theme.fg("error", `✗ ${check}`));
}

/** Clip one artifact path for a delta-card row (ADR 0013 §3); real absolute
 *  paths additionally hyperlink via the existing capability logic. */
function artifactRow(path: string, theme: BoxTheme): string {
	const clipped = compactToolPath(path, 48);
	const link =
		path.startsWith("/") && getCapabilities().hyperlinks ? hyperlink(clipped, pathToFileURL(path).href) : clipped;
	return theme.fg("dim", `  artifact: ${link}`);
}

/** Outcome formatter for delta cards (ADR 0013 §2/§3) — the single place task
 *  outcomes are formatted outside the pinned tasks_get audit dump. Collapsed:
 *  the count compression plus loud failed-check rows. Expanded: `│ `-railed
 *  Summary rows, `↗` artifact tree rows with middle-clipped paths, `✓/✗`
 *  verification rows with the first evidence line, railed remaining issues. */
function outcomeLines(outcome: unknown, theme: BoxTheme, expanded = false): string[] {
	if (!isRecord(outcome)) return [];
	if (!expanded) {
		const compression = outcomeCompression(outcome);
		return compression
			? [theme.fg("dim", compression), ...failedCheckRows(outcome, theme)]
			: failedCheckRows(outcome, theme);
	}
	const lines: string[] = [];
	const rail = (text: string): string => (text.trim() ? theme.fg("dim", `  ${text.replace(/\s+$/, "")}`) : "");
	if (typeof outcome.summary === "string") {
		const physical = physicalLines(outcome.summary);
		if (physical.length > 0)
			lines.push(rail(`Summary: ${physical[0] ?? ""}`), ...physical.slice(1).map((line) => rail(line)));
	}
	const artifacts = Array.isArray(outcome.artifacts)
		? outcome.artifacts.map((path) => clean(path, 500)).filter(Boolean)
		: [];
	for (const path of artifacts) lines.push(artifactRow(path, theme));
	const verification = Array.isArray(outcome.verification) ? outcome.verification.filter(isRecord) : [];
	for (const item of verification) {
		const failed = item.outcome === "failed";
		const glyph = failed ? "✗" : item.outcome === "passed" ? "✓" : "○";
		const check = typeof item.check === "string" ? clean(item.check, 1000) : "";
		const evidence =
			typeof item.evidence === "string"
				? stripAnsi(item.evidence)
						.split("\n")
						.map((line) => clean(line, 1000))
						.find(Boolean)
				: undefined;
		lines.push(theme.fg(failed ? "error" : "dim", `  ${glyph} ${check}${evidence ? ` — ${evidence}` : ""}`));
	}
	const issues = Array.isArray(outcome.remainingIssues) ? outcome.remainingIssues : [];
	for (const issue of issues)
		if (typeof issue === "string") {
			const physical = physicalLines(issue);
			if (physical.length > 0)
				lines.push(rail(`Remaining: ${physical[0] ?? ""}`), ...physical.slice(1).map((line) => rail(line)));
		}
	return lines;
}

/** Mutation delta row (ADR 0013 §1): verb + actor per status, with the outcome
 *  compression tail for completed results. Undefined for unmapped statuses —
 *  the caller falls back to the existing `code · title · status` summary
 *  (fail-closed, never invented verbs). */
function taskDelta(name: string, task: Task, theme: BoxTheme): string | undefined {
	const code = taskCode(task);
	const status = clean(task.status, 24);
	const owner = short(task.owner ?? task.assignee);
	const actor = owner ? ` · ${styledTeammate(theme, `@${owner}`)}` : "";
	if (name === "tasks_create") return `${code} created${status ? ` · ${status}` : ""}`;
	if (name === "tasks_cancel") return `${code} cancelled`;
	if (name === "tasks_update") {
		if (status === "in_progress") return `${code} claimed${actor}`;
		if (status === "in_review") return `${code} submitted for review${actor}`;
		if (status === "pending") return `${code} claim released`;
		if (status === "completed") {
			const compression = outcomeCompression(task.outcome);
			return `${code} accepted${actor}${compression ? ` · ${compression}` : ""}`;
		}
	}
	return undefined;
}
function taskDetail(task: Task, theme: BoxTheme): string[] {
	const lines = [`${taskCode(task)} ${clean(task.title, 300)} · ${clean(task.status, 30)}`];
	for (const key of [
		"description",
		"owner",
		"assignee",
		"dependencies",
		"blockedBy",
		"requirementRevision",
		"reviewRequested",
		"executionPlan",
		"createdAt",
		"updatedAt",
		"spec",
		"context",
		"attempts",
	]) {
		const value = task[key];
		if (value === undefined) continue;
		if (key === "attempts" && Array.isArray(value)) {
			lines.push(`Attempts (${value.length}):`);
			for (const attempt of value)
				if (isRecord(attempt)) {
					lines.push(
						`  ${clean(attempt.runId, 80)} · ${clean(attempt.teammateName, 64) || "unassigned"} · ${clean(attempt.status, 24)}${attempt.error ? ` · ERROR ${clean(attempt.error, 500)}` : ""}`,
					);
					if (typeof attempt.partialResult === "string")
						lines.push(...attempt.partialResult.split("\n").map((line) => `    ${clean(line, 2000)}`));
					if (attempt.result) lines.push(...auditOutcomeLines(attempt.result, theme, true));
				}
		} else if (key === "spec" || key === "context" || key === "executionPlan")
			lines.push(
				`${key}:`,
				...JSON.stringify(value, null, 2)
					.split("\n")
					.map((line) => `  ${clean(line, 2000)}`),
			);
		else if (typeof value === "number" || typeof value === "boolean") lines.push(`${key}: ${value}`);
		else if (key === "description" && typeof value === "string")
			lines.push("description:", ...value.split("\n").map((line) => `  ${clean(line, 2000)}`));
		else
			lines.push(`${key}: ${Array.isArray(value) ? value.map((x) => clean(x, 120)).join(", ") : clean(value, 1200)}`);
	}
	if (task.outcome) lines.push(...auditOutcomeLines(task.outcome, theme, true));
	return lines;
}
const textResult = (result: BoxedToolResult): string => rawText(result);

/** Display-name dedupe normalization (§6): lowercase, non-alphanumerics stripped. */
const normalizeModelToken = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `provider/modelId — Name` row parser for the list_models card (ADR 0012
 *  §6). Returns undefined unless every content line parses — anything else
 *  keeps the verbatim fail-closed fallback. A trailing `N of M matching models
 *  shown` line lifts into the header. */
function parseModelRows(
	raw: string,
): { rows: { ref: string; display?: string }[]; shown?: { n: number; m: number } } | undefined {
	const lines = raw
		.split("\n")
		.map((line) => stripAnsi(line).trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const trailer = /^(\d+) of (\d+) matching models shown$/.exec(lines.at(-1) ?? "");
	const contentLines = trailer ? lines.slice(0, -1) : lines;
	if (contentLines.length === 0) return undefined;
	const rows: { ref: string; display?: string }[] = [];
	for (const line of contentLines) {
		const match = /^(\S+) — (.+)$/.exec(line);
		if (!match) return undefined;
		rows.push({ ref: match[1] ?? "", ...(match[2]?.trim() ? { display: match[2]?.trim() } : {}) });
	}
	if (!trailer) return { rows };
	const n = Number(trailer[1]);
	const m = Number(trailer[2]);
	if (!Number.isSafeInteger(n) || !Number.isSafeInteger(m)) return undefined;
	return { rows, shown: { n, m } };
}

/** Call-line label for a team tool. `tasks_list` counts are lifted into the
 *  head by the result renderer (the same closure-state pattern the message card
 *  uses), so the head answers "what board" in one line. */
function teamToolLabel(name: string, args: Record<string, unknown>, counts = ""): string {
	const labels: Record<string, string> = {
		tasks_create: `Create task · ${clean(args.title, 80)}`,
		tasks_list: `Tasks${args.status ? ` · ${short(args.status)}` : ""}${counts ? ` (${counts})` : ""}`,
		tasks_get: `Task ${short(args.id)}`,
		tasks_update: `Update ${short(args.id)}${args.status ? ` · ${short(args.status)}` : ""}`,
		tasks_cancel: `Cancel ${short(args.id)}`,
		tasks_execute: `Execute ${short(args.id)} → ${short(args.name) || short(args.type)}`,
		tasks_output: `Output ${short(args.id)}`,
		tasks_stop: `Stop ${short(args.id)}`,
		teammate_status: `Teammate status @${clean(args.name, 64)}`,
		teammate_release: `Release @${clean(args.name, 64)}`,
		teammate_shutdown: `Shutdown @${clean(args.name, 64)}`,
		list_models: `Models${args.query ? ` · ${clean(args.query, 60)}` : ""}${counts ? ` · ${counts}` : ""}`,
	};
	return labels[name] ?? name;
}

function teamTool(name: string): BoxedToolDefinition {
	return {
		call(args, theme, context) {
			// The head is built inside the render closure so the counts published by
			// the result renderer appear on the next paint (no second header line).
			return rows(() => {
				// Counts published by the result renderer land on this paint, so the
				// card never prints a second header line.
				const counts =
					name === "tasks_list"
						? clean(context.state.teamTaskCounts, 120)
						: name === "list_models"
							? clean(context.state.teamModelCounts, 24)
							: "";
				return [`${theme.fg("muted", teamEventGlyph("settled"))} ${teamToolLabel(name, args, counts)}`];
			}, 1);
		},
		result(result, options, theme, context) {
			if (options.isPartial) return empty;
			const raw = textResult(result);
			const value = parseJson(raw);
			const receipt = details(result);
			const error =
				context.isError ||
				!!receipt.error ||
				!!receipt.recoveryError ||
				receipt.changed === false ||
				(isRecord(value) && (typeof value.error === "string" || value.recovery !== undefined));
			const prefix = error ? theme.fg("error", "ERROR · ") : theme.fg("dim", "└─ ");
			// Task projections publish the run ids that executed each attempt; binding
			// them keeps steer/get receipts addressable even when no Agent receipt for
			// that run exists in this session branch.
			if (Array.isArray(value)) for (const item of value) rememberTaskRuns(item);
			else if (isRecord(value)) {
				rememberTaskRuns(value);
				if (isRecord(value.task)) rememberTaskRuns(value.task, value.runId);
			}
			if (name === "tasks_list" && Array.isArray(value)) {
				const tasks = value.filter(isRecord);
				if (tasks.length === 0) return empty;
				context.state.teamTaskCounts = taskCountSegments(tasks);
				const limit = options.expanded ? tasks.length : 3;
				const shown = tasks.slice(0, limit);
				// Hanging card: the first row carries the dim branch, the rest align
				// under it. Status is carried by the glyph, not a repeated word.
				const list = shown.map(
					(task, index) => `${theme.fg("dim", index === 0 ? "└─" : "  ")} ${taskRowLine(task, theme)}`,
				);
				if (tasks.length > shown.length) list.push(theme.fg("dim", `   … ${tasks.length - shown.length} more`));
				return rows(() => list, limit + 1);
			}
			if (isRecord(value) && (typeof value.title === "string" || typeof value.status === "string")) {
				if (name === "tasks_get" && options.expanded)
					return rows(() => taskDetail(value, theme).map((line) => dimPlain(theme, line)), 10000);
				// Mutation results answer "what changed" (ADR 0013 §1); tasks_get
				// reads and unmapped/error results keep the full summary line.
				const delta = !error ? taskDelta(name, value, theme) : undefined;
				if (delta === undefined) {
					const lines = [`${prefix}${taskSummary(value, theme)}`];
					if (value.outcome) lines.push(...outcomeLines(value.outcome, theme, options.expanded));
					if (options.expanded && typeof value.description === "string")
						lines.push(
							...value.description
								.split("\n")
								.map((line) => (line.trim() ? theme.fg("dim", `  ${clean(line, 2000)}`) : "")),
						);
					return rows(() => lines, 8);
				}
				// Delta rows hang from the dash-less `└` card family (ADR 0013 §1);
				// tree glyphs stay reserved for tasks_list/tasks_get rows. Failed-check
				// breakouts are collapsed-only — expanded rows carry full ✓/✗ detail.
				const lines = [
					`${theme.fg("dim", "└ ")}${delta}`,
					...(options.expanded ? [] : failedCheckRows(value.outcome, theme)),
				];
				if (options.expanded) {
					if (value.outcome) lines.push(...outcomeLines(value.outcome, theme, true));
					if (typeof value.description === "string")
						lines.push(
							...value.description
								.split("\n")
								.map((line) => (line.trim() ? theme.fg("dim", `  ${clean(line, 2000)}`) : "")),
						);
				}
				return rows(() => lines, options.expanded ? 10000 : 8);
			}
			if (name === "tasks_execute" && isRecord(value)) {
				const task = isRecord(value.task) ? value.task : {};
				const attempt = Array.isArray(task.attempts) ? task.attempts.at(-1) : undefined;
				const teammate = clean(isRecord(attempt) ? attempt.teammateName : "", 64);
				const actor = teammate ? styledTeammate(theme, `@${teammate}`) : "teammate";
				const status = clean(task.status, 24);
				// `T5 · in_progress · attempt → @teammate` — no disclaimer row; the
				// model still reads the disclaimer in the tool text (ADR 0013 §1).
				const lines = [
					`${error ? prefix : theme.fg("dim", "└ ")}${taskCode(task)}${status ? ` · ${status}` : ""} · attempt → ${actor}`,
				];
				const runId = clean(value.runId, 100);
				if (options.expanded && runId) lines.push(theme.fg("dim", `  run ${runId}`));
				return rows(() => lines, 2);
			}
			if (name === "tasks_output" && isRecord(value)) {
				const attempt = isRecord(value.attempt) ? value.attempt : {};
				const output = typeof value.result === "string" ? value.result : "";
				const status = clean(attempt.status ?? value.status, 32) || "attempt status unavailable";
				const who = clean(attempt.teammateName, 64);
				// One status line: the failure reason joins it instead of printing a
				// second `ERROR` row (the head already says which attempt it was).
				const reason =
					typeof value.error === "string"
						? clean(value.error, options.expanded ? 2000 : 240)
						: context.isError
							? "failed"
							: "";
				const lines = [
					`${theme.fg("dim", "└─ ")}${theme.fg("text", status)}${
						who ? ` · ${styledTeammate(theme, `@${who}`, teammateColorForName(who))}` : ""
					}${reason ? ` · ${theme.fg("error", `error: ${reason}`)}` : ""}`,
				];
				if (output) {
					if (options.expanded)
						lines.push(
							...output.split("\n").map((line) => (line.trim() ? theme.fg("dim", `   ${clean(line, 2000)}`) : "")),
						);
					else
						lines.push(
							theme.fg(
								"dim",
								`   ${normalizePreview(output, { dropFields: ["Status", "Teammate"] }) || clean(output, 180)}`,
							),
						);
				}
				return rows(() => lines, options.expanded ? 10000 : 3);
			}
			if (name === "tasks_stop" && isRecord(value)) {
				const stopped = value.stopped === true;
				const text = stopped ? "attempt stop requested" : "no running attempt";
				const line = error ? `${prefix}${text}` : stopped ? `${theme.fg("dim", "└ ")}${text}` : text;
				return rows(() => [line], 1);
			}
			if (name === "list_models" && !error) {
				const parsed = parseModelRows(raw);
				if (parsed) {
					// `N of M` lifts into the call head, so the card prints one header.
					context.state.teamModelCounts = parsed.shown ? `${parsed.shown.n}/${parsed.shown.m}` : "";
					// Collapsed rows show the id tail; expanded rows and the single-match
					// row keep the canonical full ref — the copyable payload (§6).
					const label = (row: { ref: string; display?: string }): string => {
						const full = options.expanded || parsed.rows.length === 1;
						const id = full ? row.ref : normalizeModelLabel(row.ref);
						const display =
							row.display && normalizeModelToken(row.display) !== normalizeModelToken(normalizeModelLabel(row.ref))
								? ` — ${row.display}`
								: "";
						return `${id}${display}`;
					};
					// Hanging rows: the first carries the branch, the rest align under it.
					const bodyRows = parsed.rows.map((row, index) =>
						theme.fg("dim", `${index === 0 ? "└─" : "  "} ${label(row)}`),
					);
					const count = options.expanded ? bodyRows.length : 4;
					return rows(
						() => [
							...bodyRows.slice(0, count),
							...(bodyRows.length > count ? [theme.fg("dim", `   … ${bodyRows.length - count} more`)] : []),
						],
						count,
					);
				}
				// Unparseable results keep the verbatim fail-closed fallback (§6).
				const modelLines = raw.split("\n").map((line) => clean(line, 2000));
				const count = options.expanded ? modelLines.length : 4;
				return rows(
					() => [
						...modelLines.slice(0, count),
						...(modelLines.length > count ? [theme.fg("dim", `… ${modelLines.length - count} more`)] : []),
					],
					count,
				);
			}
			if (name.startsWith("teammate_")) {
				const data = receipt;
				// `name` + `color` are authoritative when the runtime publishes them; the
				// name index keeps later task/message rows in the same identity color.
				rememberTeammateIdentity(data);
				const state = clean(data.state, 24);
				const availability = clean(data.availability, 32);
				const recovery = clean(data.recoveryError ?? data.recovery, options.expanded ? 1000 : 300);
				const verb = name === "teammate_shutdown" ? "shut down" : name === "teammate_release" ? "released" : undefined;
				// Facets only; the call line already carries the identity, so the body
				// never repeats `@name`. Defaults are dropped: `available` is the
				// expected state, only deviations earn a word (and a warning tint).
				const segments: string[] = [];
				const add = (value: string, color: "dim" | "warning" = "dim") => {
					if (value) segments.push(theme.fg(color, value));
				};
				add(state || (verb && data.changed === true ? verb : ""));
				add(clean(data.operation, 24), "warning");
				if (availability === "unavailable") add("unavailable", "warning");
				if (typeof data.contextAvailable === "boolean")
					add(
						`context ${data.contextAvailable ? "available" : "unavailable"}`,
						data.contextAvailable ? "dim" : "warning",
					);
				if (name !== "teammate_status" && data.changed === true) add("task claims unchanged");
				const head = error
					? `${theme.fg("error", "└─ ")}${theme.fg("error", clean(raw, options.expanded ? 2000 : 200) || "failed")}`
					: `${theme.fg("dim", "└─ ")}${segments.join(theme.fg("dim", " · ")) || theme.fg("dim", clean(raw, 200) || "done")}`;
				const lines = [head];
				if (recovery) lines.push(theme.fg("error", `   Recovery: ${recovery}`));
				// Expanded adds what the one-liner omits: admitted type and run identity
				// (the values `steer_subagent`/`get_subagent_result` still address).
				if (options.expanded) {
					const type = clean(data.type, 64);
					if (type) lines.push(theme.fg("dim", `   type ${type}`));
					const live = clean(data.currentRunId, 256);
					const last = clean(data.lastRunId, 256);
					if (live && live !== last) lines.push(theme.fg("dim", `   live run ${live}`));
					if (last) lines.push(theme.fg("dim", `   last run ${last}`));
				}
				return rows(() => lines, 8);
			}
			const lines = options.expanded ? raw.split("\n").map((line) => clean(line, 2000)) : [clean(raw, 200)];
			return rows(
				() => lines.map((line, i) => (i === 0 ? `${prefix}${line}` : `  ${line}`)),
				options.expanded ? 50 : 1,
			);
		},
	};
}
export const teamTaskTools: Readonly<Record<string, BoxedToolDefinition>> = Object.fromEntries([
	...[
		"teammate_status",
		"teammate_release",
		"teammate_shutdown",
		"list_models",
		"tasks_create",
		"tasks_list",
		"tasks_get",
		"tasks_update",
		"tasks_cancel",
		"tasks_execute",
		"tasks_output",
		"tasks_stop",
	].map((name) => [name, teamTool(name)]),
	// Legacy name kept for saved sessions only; pi-teams registered this tool as
	// `teammate_shutdown`.
	["teammate_retire", teamTool("teammate_shutdown")],
	["peer_sessions", peerSessionsTool],
	["peer_send", peerSendTool],
	["peer_activity", peerActivityTool],
	["team_task_create", teamTool("tasks_create")],
	["team_task_update", teamTool("tasks_update")],
	["team_task_get", teamTool("tasks_get")],
	["team_task_list", teamTool("tasks_list")],
]);
