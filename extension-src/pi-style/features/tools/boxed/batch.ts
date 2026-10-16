// Consecutive quiet-tool (read/ls/find) call batching.
//
// Groups back-to-back calls of the same quiet tool inside one assistant turn
// into a single collapsible, **boxless** tree panel instead of one boxed panel
// per call. The first call of a batch becomes its leader: the leader's call
// component renders the whole panel (header + tree), reading the live batch
// state on every render pass. Subsequent members render zero lines, so they
// consume no vertical space.
//
// Chunk-merge (ADR 0010, `tools.mergeChunkedReads`): a large file read through
// sequential continuation chunks (pi's read truncates at 2000 lines / 50KB, so
// the model re-reads with `offset` — one call per assistant message) merges
// into ONE expanding inline line (`➔ Read chat.ts:525-2629 · 10 chunks`).
// Continuation chunks join their file's pure chunk batch across batch closes
// and message boundaries within the agent run; each later chunk's entry
// renders zero lines like any batch member. Contiguity is verified from
// requested offset/limit and refined by the actual truncation line count from
// the tool result. Non-contiguous same-file reads (deliberate re-reads) and
// mixed-path batches keep the standard panel. Live and restore replay through
// the same registry, so both render identically for pure chunk sequences.
//
// Design notes:
// - Live batches render directly from the registry so member completions (which
//   trigger ui.requestRender via Pi's tool_execution_end handler) are picked up
//   without cross-component invalidation plumbing. Once a batch is finalized,
//   width/config-stable renders reuse the cached line array.
// - Batch boundaries: a new batch starts when the active batch is closed. The
//   active batch closes when a non-batchable tool call is dispatched
//   (boxed/index.ts), when a new message starts (pi/index.ts), and on session
//   reset (session-coordinator.ts). A lone `read` call renders as a single
//   inline line (`➔ Read <path>`); lone ls/find calls render a flat output
//   tree (a batch of one).
// - No surrounding box: indentation and tree glyphs (├─/└─) carry the
//   hierarchy; the header line of a batched panel is the summary
//   (` Read (N) · 0.08s`).
// - Errors stay visible: failed members are always rendered inline (even in the
//   collapsed state), with their error text indented beneath the path.
// - read members render a single path row (a lone read collapses to one inline
//   line). ls/find members render their parsed output as a file subtree (flat
//   for a lone call, nested per member when batched) — see
//   renderOutputBatchPanel. Pending/failed members without output fall back to
//   the path row.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import { type BoxTheme, dimLine, formatToolTitlePrefix, themeCacheKey } from "../../../shared/box.js";
import { safeTruncateToWidth, safeVisibleWidth } from "../../../shared/render-budget.js";
import { OUTPUT_TREE_HEAD_LIMIT, pluralForm, renderOutputTree, TREE_CHILD_INDENT, TREE_INDENT } from "./output-tree.js";
import { compactToolPath } from "./path.js";
import { getToolsRenderCacheSignature, getToolsRenderConfig } from "./session-config.js";
import type { BoxedToolContext } from "./shared.js";

/** Quiet tools whose calls group into a single batch panel. */
export const BATCHABLE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "ls", "find", "Agent"]);

export function isBatchableTool(toolName: unknown): boolean {
	return typeof toolName === "string" && BATCHABLE_TOOL_NAMES.has(toolName);
}

export interface BatchToolMeta {
	readonly toolName: string;
	/** Human label shown in the batch header (e.g. "Read", "List", "Find"). */
	readonly label: string;
	/** Header label for output-tree panels: "Find" for find, "List" for ls. */
	readonly headerLabel?: string;
}

export type BatchMemberStatus = "pending" | "running" | "done";

export interface BatchMember {
	readonly toolCallId: string;
	detail: string;
	status: BatchMemberStatus;
	isError: boolean;
	errorText?: string;
	noticeText?: string;
	resultText?: string;
	receiptText?: string;
	/** Effective mode for optional pi-teams dispatches, when the runtime confirms it. */
	effectiveMode?: "background" | "foreground";
	/** Admitted run id (Agent members, ADR 0012 §5): keys run-level settlement
	 *  lookups so the row glyph tracks the run, not the tool call. */
	runId?: string;
	/** Canonical admitted model ref (Agent members): collapsed rows show its
	 *  short label; expanded rows keep the full ref (ADR 0012 §3). */
	modelRef?: string;
	/** find glob pattern (header detail for output panels). */
	pattern?: string;
	/** Display path (header detail for output panels). */
	pathLabel?: string;
	/** Parsed output entries once the result arrives (ls/find). `undefined` until
	 *  the result is registered; an empty array means a successful zero-entry
	 *  result (e.g. an empty directory). */
	outputEntries?: string[];
	/** Read chunk coordinates (same-file continuation reads, ADR 0010). The
	 *  display path doubles as the merge key; `end` is the requested end
	 *  (offset + limit - 1) when known, refined by the result's actual output
	 *  line count once it settles. */
	chunk?: ReadChunkInfo;
}

/** Coordinates of one read call within a chunk-merge sequence (ADR 0010). */
export interface ReadChunkInfo {
	/** Normalized display path — the merge key. */
	readonly path: string;
	/** 1-indexed first line (offset, default 1). */
	readonly start: number;
	/** 1-indexed last line when known (requested or refined); `undefined` for
	 *  offset-only reads whose result has not settled yet. */
	readonly end?: number;
}

type BatchRenderCache = {
	key: string;
	lines: string[];
};

export interface BatchState {
	readonly meta: BatchToolMeta;
	readonly leaderId: string;
	readonly startedAt: number;
	completedAt?: number;
	closed: boolean;
	readonly members: BatchMember[];
	revision: number;
	renderCache?: BatchRenderCache;
	/** User click-open: the header row was clicked, so the tree renders every
	 *  member (and per-member file subtrees their full output) instead of the
	 *  head-limited preview. The `batchOpenGlyph` header promised a disclosure;
	 * the click now keeps it. */
	open: boolean;
}

/** Tree head limit: only the first few members are listed, the rest collapse. */
const BATCH_TREE_HEAD_LIMIT = 5;
/** Per-member file subtree head limit in a batched output panel. */
const BATCH_MEMBER_FILE_HEAD_LIMIT = 4;
const BATCH_ERROR_LINES = 2;
/** Indent for tree lines below the header. */
const BATCH_TREE_INDENT = TREE_INDENT;

/** Component rendered for non-leader batch members (zero height). */
export const EMPTY_BATCH_COMPONENT: Component = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

let activeBatch: BatchState | undefined;
const batchByCallId = new Map<string, BatchState>();
/** Chunk-merge candidates (ADR 0010): the most recent pure, contiguous read
 *  chunk batch per display path. Survives batch closes and assistant message
 *  boundaries (a continuation chunk in a later message still merges); cleared
 *  at agent-run and session boundaries. */
const chunkCandidateByPath = new Map<string, BatchState>();

/** Close the current batch: no new members join; existing panels keep rendering. */
export function closeActiveBatch(): void {
	if (!activeBatch) return;
	activeBatch.closed = true;
	activeBatch = undefined;
}

/** Reset all batch state (session start/shutdown). */
export function resetBatchRegistry(): void {
	activeBatch = undefined;
	batchByCallId.clear();
	chunkCandidateByPath.clear();
}

/** Reset chunk-merge candidates (agent-run boundary): a new request's reads
 *  never merge into the previous run's sequences. Also closes the active
 *  batch — a run boundary always ends the previous run's grouping. */
export function resetReadChunkCandidates(): void {
	closeActiveBatch();
	chunkCandidateByPath.clear();
}

/** Whether `next` continues `prev` as a same-file chunk sequence: exact line
 *  contiguity when the previous end is known, forward progression otherwise
 *  (offset-only read whose result has not settled). */
function chunkContinues(prev: ReadChunkInfo, next: ReadChunkInfo): boolean {
	if (prev.end !== undefined) return next.start === prev.end + 1;
	return next.start > prev.start;
}

/** Structural chunk-batch test used for rendering AND candidacy: every member
 *  is a read chunk of one path and the chunks are pairwise contiguous. */
function isContiguousChunkBatch(batch: BatchState): boolean {
	const first = batch.members[0]?.chunk;
	if (!first) return false;
	let prev = first;
	for (let i = 1; i < batch.members.length; i++) {
		const cur = batch.members[i]?.chunk;
		if (!cur || cur.path !== first.path || !chunkContinues(prev, cur)) return false;
		prev = cur;
	}
	return true;
}

/** A pure, contiguous same-file read chunk sequence (2+ members) rendered as
 *  one expanding inline line (`tools.mergeChunkedReads`, ADR 0010). */
function isChunkReadBatch(batch: BatchState): boolean {
	return (
		getToolsRenderConfig().mergeChunkedReads &&
		batch.meta.toolName === "read" &&
		batch.members.length >= 2 &&
		isContiguousChunkBatch(batch)
	);
}

/** Keep the per-path candidate registry in sync after any read-batch mutation:
 *  a pure contiguous chunk batch is the merge target for its path; any other
 *  shape (mixed paths, non-contiguous joins, non-chunk reads) drops the
 *  batch's candidacy. */
function syncChunkCandidacy(batch: BatchState): void {
	if (batch.meta.toolName !== "read") return;
	const first = batch.members[0]?.chunk;
	if (first && batch.members.length >= 1 && isContiguousChunkBatch(batch)) {
		chunkCandidateByPath.set(first.path, batch);
		return;
	}
	for (const [path, candidate] of chunkCandidateByPath) if (candidate === batch) chunkCandidateByPath.delete(path);
}

function createBatch(
	meta: BatchToolMeta,
	leaderId: string,
	detail: string,
	opts: { pattern?: string; pathLabel?: string; chunk?: ReadChunkInfo } = {},
): BatchState {
	const batch: BatchState = {
		meta,
		leaderId,
		startedAt: performance.now(),
		closed: false,
		revision: 0,
		open: false,
		members: [
			{
				toolCallId: leaderId,
				detail,
				status: "pending",
				isError: false,
				...(opts.pattern ? { pattern: opts.pattern } : {}),
				...(opts.pathLabel ? { pathLabel: opts.pathLabel } : {}),
				...(opts.chunk ? { chunk: opts.chunk } : {}),
			},
		],
	};
	activeBatch = batch;
	batchByCallId.set(leaderId, batch);
	syncChunkCandidacy(batch);
	return batch;
}

function bumpBatchRevision(batch: BatchState): void {
	batch.revision++;
	delete batch.renderCache;
}

/**
 * Register a call renderer invocation. Idempotent per toolCallId: re-fires
 * (updateDisplay on the same component) reuse the call's existing batch, even
 * after the batch was closed.
 */
export function registerBatchCall(
	meta: BatchToolMeta,
	detail: string,
	context: BoxedToolContext,
	opts: { pattern?: string; pathLabel?: string; chunk?: ReadChunkInfo } = {},
): { batch: BatchState; isLeader: boolean } {
	const existing = batchByCallId.get(context.toolCallId);
	if (existing) {
		const member = existing.members.find((entry) => entry.toolCallId === context.toolCallId);
		if (member) {
			const changed =
				member.detail !== detail || member.pattern !== opts.pattern || member.pathLabel !== opts.pathLabel;
			member.detail = detail;
			if (opts.pattern !== undefined) member.pattern = opts.pattern;
			if (opts.pathLabel !== undefined) member.pathLabel = opts.pathLabel;
			if (changed) bumpBatchRevision(existing);
		}
		return { batch: existing, isLeader: existing.leaderId === context.toolCallId };
	}
	// Chunk-merge (ADR 0010): a continuation chunk joins its file's candidate
	// batch even when that batch was closed (message boundary, non-read tool in
	// between) — the merged inline line at the leader's position expands to
	// cover the chunk, and this call renders zero lines like any batch member.
	if (opts.chunk && getToolsRenderConfig().mergeChunkedReads) {
		const candidate = chunkCandidateByPath.get(opts.chunk.path);
		const lastChunk = candidate?.members.at(-1)?.chunk;
		if (candidate && lastChunk && lastChunk.path === opts.chunk.path && chunkContinues(lastChunk, opts.chunk)) {
			const member: BatchMember = {
				toolCallId: context.toolCallId,
				detail,
				status: "pending",
				isError: false,
				chunk: opts.chunk,
			};
			candidate.members.push(member);
			batchByCallId.set(context.toolCallId, candidate);
			// Re-opening: the batch was possibly fully settled; a pending member
			// must restart completion tracking (elapsed recomputes at final settle).
			delete candidate.completedAt;
			bumpBatchRevision(candidate);
			syncChunkCandidacy(candidate);
			return { batch: candidate, isLeader: candidate.leaderId === context.toolCallId };
		}
	}
	const current = activeBatch;
	if (!current || current.closed || current.meta.toolName !== meta.toolName) {
		closeActiveBatch();
		return { batch: createBatch(meta, context.toolCallId, detail, opts), isLeader: true };
	}
	const member: BatchMember = {
		toolCallId: context.toolCallId,
		detail,
		status: "pending",
		isError: false,
		...(opts.pattern ? { pattern: opts.pattern } : {}),
		...(opts.pathLabel ? { pathLabel: opts.pathLabel } : {}),
		...(opts.chunk ? { chunk: opts.chunk } : {}),
	};
	current.members.push(member);
	batchByCallId.set(context.toolCallId, current);
	bumpBatchRevision(current);
	syncChunkCandidacy(current);
	return { batch: current, isLeader: false };
}

export interface BatchResultData {
	readonly isPartial: boolean;
	readonly isError: boolean;
	readonly errorText: string | undefined;
	readonly noticeText?: string;
	readonly resultText?: string;
	readonly receiptText?: string;
	/** Parsed output entries (ls/find) stored on the member for tree rendering. */
	readonly entries?: string[];
	/** Actual output line count of a settled read result (truncation details or
	 *  counted text lines): refines the member chunk's `end` so the next
	 *  continuation chunk's contiguity check and the merged range display stay
	 *  exact even for byte-capped / offset-only reads. */
	readonly readOutputLines?: number;
}

/**
 * Register a result renderer invocation: updates the member's status/metadata
 * and records batch completion once every member has settled. The member's
 * display detail stays as registered by the call renderer (the result context's
 * args may be normalized differently).
 *
 * `data.entries === undefined` means "keep the registered entries": callers
 * that already registered final output (see hasFinalBatchOutput) omit the
 * field on warm re-render passes, and that must never count as a change —
 * comparing against the stored array would otherwise bump the revision on
 * every pass.
 */
export function registerBatchResult(
	meta: BatchToolMeta,
	data: BatchResultData,
	context: BoxedToolContext,
): { batch: BatchState | undefined; isLeader: boolean } {
	const batch = batchByCallId.get(context.toolCallId);
	if (!batch || batch.meta.toolName !== meta.toolName) return { batch: undefined, isLeader: false };
	const member = batch.members.find((entry) => entry.toolCallId === context.toolCallId);
	if (member) {
		const nextStatus = data.isPartial ? "running" : "done";
		const nextIsError = !data.isPartial && data.isError;
		// Chunk end refinement (ADR 0010): the actual output line count pins the
		// member chunk's end (byte-capped / offset-only reads), keeping later
		// contiguity checks and the merged range display exact.
		const refinedEnd =
			member.chunk && data.readOutputLines !== undefined ? member.chunk.start + data.readOutputLines - 1 : undefined;
		const changed =
			member.status !== nextStatus ||
			member.isError !== nextIsError ||
			member.errorText !== (nextIsError ? data.errorText : undefined) ||
			member.noticeText !== data.noticeText ||
			member.resultText !== data.resultText ||
			member.receiptText !== data.receiptText ||
			(data.entries !== undefined && member.outputEntries !== data.entries) ||
			(refinedEnd !== undefined && member.chunk?.end !== refinedEnd);
		member.status = nextStatus;
		member.isError = nextIsError;
		if (member.isError && data.errorText !== undefined) member.errorText = data.errorText;
		else delete member.errorText;
		if (data.noticeText !== undefined) member.noticeText = data.noticeText;
		else delete member.noticeText;
		if (data.resultText !== undefined) member.resultText = data.resultText;
		else delete member.resultText;
		if (data.receiptText !== undefined) member.receiptText = data.receiptText;
		else delete member.receiptText;
		if (data.entries !== undefined) member.outputEntries = data.entries;
		if (refinedEnd !== undefined && member.chunk) member.chunk = { ...member.chunk, end: refinedEnd };
		if (changed) bumpBatchRevision(batch);
	}
	if (batch.completedAt === undefined && batch.members.every((entry) => entry.status === "done")) {
		batch.completedAt = performance.now();
		bumpBatchRevision(batch);
	}
	return { batch, isLeader: batch.leaderId === context.toolCallId };
}

/** True when the member for `toolCallId` has settled with final parsed output
 *  (done, non-error, entries registered). Result renderers use this to skip
 *  re-parsing an unchanged final output on warm re-render passes. */
export function hasFinalBatchOutput(toolCallId: string): boolean {
	const batch = batchByCallId.get(toolCallId);
	if (!batch) return false;
	const member = batch.members.find((entry) => entry.toolCallId === toolCallId);
	return member !== undefined && member.outputEntries !== undefined && member.status === "done" && !member.isError;
}

interface BatchStatus {
	readonly total: number;
	readonly done: number;
	readonly failed: number;
	readonly allDone: boolean;
	readonly elapsedMs: number | undefined;
}

function batchStatus(batch: BatchState): BatchStatus {
	let done = 0;
	let failed = 0;
	for (const member of batch.members) {
		if (member.status !== "done") continue;
		done++;
		if (member.isError) failed++;
	}
	const total = batch.members.length;
	const allDone = done === total;
	return {
		total,
		done,
		failed,
		allDone,
		elapsedMs: allDone && batch.completedAt !== undefined ? batch.completedAt - batch.startedAt : undefined,
	};
}

function formatElapsed(theme: BoxTheme, elapsedMs: number): string {
	return theme.fg("dim", ` · ${(elapsedMs / 1000).toFixed(2)}s`);
}

function bold(theme: BoxTheme, text: string): string {
	return typeof theme?.bold === "function" ? theme.bold(text) : text;
}

function isOutputTool(meta: BatchToolMeta): boolean {
	return meta.toolName === "ls" || meta.toolName === "find";
}

/** Header line: state glyph + batch label(count) + progress/elapsed (no box). */
function formatBatchHeader(theme: BoxTheme, batch: BatchState, status: BatchStatus): string {
	const label = `${batch.meta.headerLabel ?? batch.meta.label} (${status.total})`;
	if (status.failed > 0) return theme.fg("error", bold(theme, `✗ ${label} · ${status.failed} failed`));
	if (status.allDone) {
		const glyph = getToolsRenderConfig().batchOpenGlyph;
		const elapsed = status.elapsedMs === undefined ? "" : formatElapsed(theme, status.elapsedMs);
		return `${theme.fg("text", bold(theme, `${glyph} ${label}`))}${elapsed}`;
	}
	if (status.done > 0)
		return `${theme.fg("text", bold(theme, `◌ ${label}`))}${theme.fg("dim", ` · ${status.done}/${status.total}`)}`;
	return bold(theme, formatToolTitlePrefix(theme, label));
}

function memberGlyph(theme: BoxTheme, member: BatchMember, show: boolean): string {
	if (!show) return "";
	if (member.isError) return theme.fg("error", "✗");
	if (member.status === "done") return theme.fg("success", "✓");
	return theme.fg("text", "◌");
}

function renderErrorLines(theme: BoxTheme, errorText: string, width: number): string[] {
	const raw = stripAnsi(errorText)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (raw.length === 0) return [];
	const prefix = `${dimLine("  │  ")}`;
	const out = raw
		.slice(0, BATCH_ERROR_LINES)
		.map((line) => safeTruncateToWidth(`${prefix}${theme.fg("error", line)}`, Math.max(1, width), "…"));
	if (raw.length > BATCH_ERROR_LINES)
		out.push(safeTruncateToWidth(`${prefix}${theme.fg("error", "…")}`, Math.max(1, width), "…"));
	return out;
}

function renderPathRow(
	theme: BoxTheme,
	prefix: string,
	path: string,
	color: string,
	width: number,
	suffix = "",
): string {
	const detail = compactToolPath(path, width - safeVisibleWidth(prefix) - safeVisibleWidth(suffix));
	return safeTruncateToWidth(`${prefix}${theme.fg(color, detail)}${suffix}`, Math.max(1, width), "…");
}

function renderBatchTree(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	const showGlyphs = !status.allDone || status.failed > 0;
	const limit = batch.open ? batch.members.length : BATCH_TREE_HEAD_LIMIT;
	const visible = batch.members.slice(0, limit);
	const more = batch.members.length - visible.length;
	const lastIndex = visible.length - 1;
	const out: string[] = [];
	for (let i = 0; i < visible.length; i++) {
		const member = visible[i];
		if (!member) continue;
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const glyph = memberGlyph(theme, member, showGlyphs);
		// Primary color for files read successfully, error red for failures.
		const pathColor = member.isError ? "error" : member.status === "done" ? "accent" : "text";
		const prefix = `${BATCH_TREE_INDENT}${dimLine(branch)}${glyph ? ` ${glyph}` : ""} `;
		out.push(
			batch.meta.toolName === "find"
				? safeTruncateToWidth(`${prefix}${theme.fg(pathColor, member.detail)}`, Math.max(1, width), "…")
				: renderPathRow(theme, prefix, member.detail, pathColor, width),
		);
		if (member.isError && member.errorText) out.push(...renderErrorLines(theme, member.errorText, width));
	}
	if (more > 0) {
		out.push(
			safeTruncateToWidth(
				`${BATCH_TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `${more} more`)}`,
				Math.max(1, width),
				"…",
			),
		);
	}
	return out;
}

/** Header for a lone (batch-of-one) ls/find output panel: `Find: <pattern> <N> files · in <path>`. */
function formatLoneOutputHeader(theme: BoxTheme, meta: BatchToolMeta, member: BatchMember): string {
	const label = meta.headerLabel ?? meta.label;
	const count = member.outputEntries?.length ?? 0;
	const filesPart = theme.fg("accent", `${count} ${count === 1 ? "file" : "files"}`);
	const patternPart = meta.toolName === "find" && member.pattern ? `${theme.fg("text", member.pattern)} ` : "";
	const pathPart = member.pathLabel ? theme.fg("dim", ` · in ${compactToolPath(member.pathLabel)}`) : "";
	return `${bold(theme, `${label}:`)} ${patternPart}${filesPart}${pathPart}`;
}

/** Nested file subtree for one member inside a batched (2+) output panel. */
function renderMemberSubtree(
	theme: BoxTheme,
	member: BatchMember,
	isLastMember: boolean,
	width: number,
	open: boolean,
): string[] {
	const safeWidth = Math.max(1, width);
	const trunk = isLastMember ? " " : dimLine("│");
	const out: string[] = [];

	// Member header row: path + file count (or status glyph when not done).
	const entries = member.outputEntries ?? [];
	if (member.isError) {
		const prefix = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${theme.fg("error", "✗")} `;
		out.push(renderPathRow(theme, prefix, member.pathLabel ?? member.detail, "error", safeWidth));
		if (member.errorText) out.push(...renderErrorLines(theme, member.errorText, width));
		return out;
	}
	if (member.status !== "done" || member.outputEntries === undefined) {
		const glyph = member.status === "done" ? theme.fg("success", "✓") : theme.fg("text", "◌");
		const prefix = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${glyph} `;
		out.push(renderPathRow(theme, prefix, member.pathLabel ?? member.detail, "text", safeWidth));
		return out;
	}

	const countLabel = theme.fg("dim", ` · ${entries.length} ${pluralForm("file", entries.length)}`);
	const prefix = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} `;
	out.push(renderPathRow(theme, prefix, member.pathLabel ?? member.detail, "accent", safeWidth, countLabel));

	const visible = entries.slice(0, open ? entries.length : BATCH_MEMBER_FILE_HEAD_LIMIT);
	const more = entries.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const entry = visible[i] ?? "";
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const prefix = `${BATCH_TREE_INDENT}${trunk}${TREE_CHILD_INDENT}${dimLine(branch)} `;
		out.push(renderPathRow(theme, prefix, entry, "toolOutput", safeWidth));
	}
	if (more > 0) {
		const line = `${BATCH_TREE_INDENT}${trunk}${TREE_CHILD_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("file", more)}`)}`;
		out.push(safeTruncateToWidth(line, safeWidth, "…"));
	}
	return out;
}

/** ls/find output panel: lone call renders a flat tree; a batch renders nested subtrees. */
function renderOutputBatchPanel(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	const safeWidth = Math.max(1, width);

	// Lone successful call with output: flat tree under a `Find:/List:` header.
	if (batch.members.length === 1) {
		const member = batch.members[0];
		if (member && member.outputEntries !== undefined && !member.isError) {
			const header = safeTruncateToWidth(formatLoneOutputHeader(theme, batch.meta, member), safeWidth, "…");
			return renderOutputTree(theme, header, member.outputEntries, safeWidth, {
				headLimit: batch.open ? member.outputEntries.length : OUTPUT_TREE_HEAD_LIMIT,
				moreUnit: "file",
				entryColor: "toolOutput",
				indent: BATCH_TREE_INDENT,
			});
		}
		// Pending/error/empty-without-entries: fall through to the path-only panel.
	}

	// Batched (2+) or a not-yet-ready lone call: per-member rows/subtrees.
	const header = safeTruncateToWidth(formatBatchHeader(theme, batch, status), safeWidth, "…");
	const out: string[] = [header];
	const limit = batch.open ? batch.members.length : BATCH_TREE_HEAD_LIMIT;
	const visible = batch.members.slice(0, limit);
	const more = batch.members.length - visible.length;
	visible.forEach((member, index) => {
		const isLast = index === visible.length - 1 && more <= 0;
		out.push(...renderMemberSubtree(theme, member, isLast, safeWidth, batch.open));
	});
	if (more > 0) {
		out.push(
			safeTruncateToWidth(`${BATCH_TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `${more} more`)}`, safeWidth, "…"),
		);
	}
	return out;
}

/** Lone `read` call: single inline line `➔ Read <path>` — no count, no tree. */
function isLoneRead(batch: BatchState): boolean {
	return batch.meta.toolName === "read" && batch.members.length === 1;
}

/** Merged range detail for a chunk batch: `<path>:<firstStart>-<lastEnd>`
 *  (end omitted while the final chunk's extent is still unknown). */
function mergedChunkDetail(batch: BatchState): string {
	const first = batch.members[0]?.chunk;
	if (!first) return "";
	let end: number | undefined;
	for (const member of batch.members) {
		const memberEnd = member.chunk?.end;
		if (memberEnd !== undefined && (end === undefined || memberEnd > end)) end = memberEnd;
	}
	return `${first.path}:${first.start}${end !== undefined ? `-${end}` : ""}`;
}

/** Chunk-merged read sequence (ADR 0010): ONE inline line per file,
 *  `➔ Read <path>:525-2629 · 10 chunks · 1.20s`, expanding as chunks arrive.
 *  Running shows live `done/total` progress; a failed chunk keeps its glyph,
 *  error color, failure count, and error text lines visible. */
function renderMergedChunkPanel(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	const prefix = bold(theme, formatToolTitlePrefix(theme, batch.meta.label));
	const glyph = status.failed > 0 ? theme.fg("error", "✗") : status.allDone ? "" : theme.fg("text", "◌");
	const detailColor = status.failed > 0 ? "error" : status.allDone ? "accent" : "text";
	const suffix = !status.allDone
		? theme.fg("dim", ` · ${status.done}/${status.total}`)
		: `${theme.fg("dim", ` · ${status.total} ${pluralForm("chunk", status.total)}`)}${
				status.failed > 0
					? theme.fg("error", ` · ${status.failed} ${pluralForm("failure", status.failed)}`)
					: status.elapsedMs === undefined
						? ""
						: formatElapsed(theme, status.elapsedMs)
			}`;
	const line = renderPathRow(
		theme,
		`${prefix}${glyph ? ` ${glyph}` : ""} `,
		mergedChunkDetail(batch),
		detailColor,
		width,
		suffix,
	);
	const out = [line];
	const failedMember = batch.members.find((member) => member.isError);
	if (failedMember?.errorText) out.push(...renderErrorLines(theme, failedMember.errorText, width));
	return out;
}

/** Lone read renders `➔ Read <path>` on one line; errors keep their error text. */
function renderLoneReadPanel(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	const member = batch.members[0];
	if (!member) return [];
	const prefix = bold(theme, formatToolTitlePrefix(theme, batch.meta.label));
	const glyph = memberGlyph(theme, member, !status.allDone || status.failed > 0);
	const pathColor = member.isError ? "error" : member.status === "done" ? "accent" : "text";
	const out = [renderPathRow(theme, `${prefix}${glyph ? ` ${glyph}` : ""} `, member.detail, pathColor, width)];
	if (member.isError && member.errorText) out.push(...renderErrorLines(theme, member.errorText, width));
	return out;
}

function renderBatchPanelLines(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	// Lone read collapses to a single inline line; a chunk-merged read sequence
	// collapses to one expanding inline line per file (ADR 0010); batched reads
	// and lone ls/find calls keep their tree panels.
	if (isLoneRead(batch)) return renderLoneReadPanel(theme, batch, status, width);
	if (isChunkReadBatch(batch)) return renderMergedChunkPanel(theme, batch, status, width);
	if (isOutputTool(batch.meta) && batch.members.some((member) => member.outputEntries !== undefined)) {
		return renderOutputBatchPanel(theme, batch, status, width);
	}
	const header = safeTruncateToWidth(formatBatchHeader(theme, batch, status), Math.max(1, width), "…");
	const lines = [header];
	lines.push(...renderBatchTree(theme, batch, status, width));
	return lines;
}

/**
 * Leader call component: renders the live batch panel (header + tree) reading
 * the registry on every render pass. Members render EMPTY_BATCH_COMPONENT.
 * Clicking the header row toggles the uncut tree; clicks on other rows are
 * consumed too — Pi's native per-box toggle would otherwise flip only this
 * component's expanded flag and replace the panel with one solo row.
 */
export function renderBatchAwareCall(theme: BoxTheme, batch: BatchState): Component {
	return {
		invalidate() {
			delete batch.renderCache;
		},
		render(width: number): string[] {
			const status = batchStatus(batch);
			if (!status.allDone) return renderBatchPanelLines(theme, batch, status, width);
			const cacheKey = [themeCacheKey(theme), getToolsRenderCacheSignature(), width, batch.revision].join("|");
			if (batch.renderCache?.key === cacheKey) return batch.renderCache.lines;
			const lines = renderBatchPanelLines(theme, batch, status, width);
			batch.renderCache = { key: cacheKey, lines };
			return lines;
		},
		handleMouse(event) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			if (event.y === 0) {
				batch.open = !batch.open;
				delete batch.renderCache;
				return { handled: true };
			}
			// Swallow clicks on tree rows: the only toggle is the header. Letting
			// the native handler run would solo-render this leader (the batch's
			// aggregated view would vanish).
			return { handled: true };
		},
	};
}

/** Standalone inline call row for one quiet-tool member while Pi's global
 * tool-output expansion (Ctrl+O) is active: every member renders its own
 * `➔ Label <detail>` line instead of hiding inside the batch panel, so the
 * expanded transcript shows each tool call individually. The batch registry
 * stays authoritative — members still register, so collapsing again restores
 * the panel without state loss. */
export function renderStandaloneMemberCall(theme: BoxTheme, label: string, detail: string): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const prefix = bold(theme, formatToolTitlePrefix(theme, label));
			return [
				label === "Read" || label === "List"
					? renderPathRow(theme, `${prefix} `, detail, "text", width)
					: safeTruncateToWidth(`${prefix} ${theme.fg("text", detail)}`, Math.max(1, width), "…"),
			];
		},
	};
}

/**
 * Empty result component for the batch leader. The panel lives in the call
 * component; the result adds nothing. Deliberately NOT the shared member
 * singleton, so the decoration's hideBatchMember (identity-compared to
 * EMPTY_BATCH_COMPONENT) never hides the leader.
 */
export function emptyBatchResult(): Component {
	return {
		invalidate() {},
		render() {
			return [];
		},
	};
}
