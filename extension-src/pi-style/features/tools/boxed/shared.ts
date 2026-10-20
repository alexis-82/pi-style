// Shared context/view types + common helpers for the boxed tool renderers.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import type { BoxTheme } from "../../../shared/box.js";
import {
	boxedToolWidthKey,
	clearCompactBoxedFooter,
	formatBoxedFooter,
	formatBoxedFooterFromValues,
	getTextOutput,
	renderCompactBoxedFooter,
	renderCompactBoxedToolCall,
	resolveRelativePath,
	shortenPath,
	themeCacheKey,
} from "../../../shared/box.js";
import { safeVisibleWidth } from "../../../shared/render-budget.js";
import { compactToolPath } from "./path.js";
import {
	getStateElapsedMs,
	getToolsRenderCacheSignature,
	isResultSeen,
	markResultSeen,
	recordExecutionEnded,
	recordExecutionStarted,
	startElapsedTicker,
	stopElapsedTicker,
} from "./session-config.js";

/** Renderer context delivered by Pi's ToolExecutionComponent (getRenderContext). */
export interface BoxedToolContext {
	readonly args: Record<string, unknown>;
	readonly toolCallId: string;
	readonly invalidate: () => void;
	readonly state: Record<string, unknown>;
	readonly cwd: string;
	readonly executionStarted: boolean;
	readonly argsComplete: boolean;
	readonly isPartial: boolean;
	readonly expanded: boolean;
	readonly showImages: boolean;
	readonly isError: boolean;
	readonly lastComponent?: unknown;
}

/** Result view delivered to result renderers: { content, details }. */
export interface BoxedToolResult {
	readonly content?: readonly unknown[];
	readonly details?: unknown;
}

export type BoxedCallRenderer = (
	args: Record<string, unknown>,
	theme: BoxTheme,
	context: BoxedToolContext,
) => Component;
export type BoxedResultRenderer = (
	result: BoxedToolResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
) => Component;

export interface BoxedToolDefinition {
	readonly call: BoxedCallRenderer;
	readonly result: BoxedResultRenderer;
}

export function pendingFlag(context: BoxedToolContext): boolean {
	return Boolean(context.isPartial);
}

/** Normalized display path: shortens HOME and resolves relative to the session cwd. */
export function displayPath(rawPath: string, context: BoxedToolContext): string {
	const path = String(rawPath ?? "");
	if (!path) return "(unknown)";
	return shortenPath(resolveRelativePath(path, context.cwd));
}

/** Match Pi 1.3 read ranges without depending on its new renderer export. */
export function parseReadLineNumber(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pathRangeDetail(rawPath: string, offset: unknown, limit: unknown, context: BoxedToolContext): string {
	const path = displayPath(rawPath, context);
	if (offset == null && limit == null) return path;
	const start = offset == null ? 1 : parseReadLineNumber(offset);
	if (start === undefined) return path;
	if (limit == null) return `${path}:${start}`;
	const count = parseReadLineNumber(limit);
	if (count === undefined) return path;
	const end = start + count - 1;
	return `${path}:${start}${end ? `-${end}` : ""}`;
}

/** Compact boxed call header for summary-style tools (read/write/ls/find/grep). */
export function compactCall(
	theme: BoxTheme,
	toolName: string,
	detailLine: string,
	options: { detailKey: string; context: BoxedToolContext; headerDetail?: (availableWidth: number) => string },
): Component {
	return renderCompactBoxedToolCall(theme, toolName, detailLine, {
		widthKey: boxedToolWidthKey(toolName, options.detailKey),
		...(options.headerDetail ? { headerDetail: options.headerDetail } : {}),
		state: options.context.state,
		isError: Boolean(options.context.isError),
		isPartial: Boolean(options.context.isPartial),
		isPending: pendingFlag(options.context),
		running: Boolean(options.context.executionStarted),
	});
}

/** Record wall-clock start when execution begins (first render with executionStarted). */
export function noteExecutionStart(context: BoxedToolContext): void {
	recordExecutionStarted(context.state, context.executionStarted);
}

/**
 * Keep running/ended execution state in sync from a call renderer pass. While
 * the tool runs, a 1s re-render ticker keeps live elapsed labels current; once
 * the call renders in its terminal form the elapsed freezes.
 */
export function noteBoxedCallState(context: BoxedToolContext): void {
	if (!context.executionStarted) return;
	if (context.isPartial) startElapsedTicker(context.state, context.invalidate);
	else {
		recordExecutionEnded(context.state);
		stopElapsedTicker(context.state);
	}
}

/**
 * Record a result renderer pass and keep the ticker/ended state in sync.
 * Returns whether this is the first result pass for the call, so renderers can
 * render nothing while the pending/running call card stands alone.
 */
export function noteBoxedResultPhase(context: BoxedToolContext, isPartial: boolean): boolean {
	const firstResultPass = !isResultSeen(context.state);
	markResultSeen(context.state);
	if (isPartial) startElapsedTicker(context.state, context.invalidate);
	else {
		recordExecutionEnded(context.state);
		stopElapsedTicker(context.state);
	}
	return firstResultPass;
}

export function stateElapsedMs(context: BoxedToolContext): number | undefined {
	return getStateElapsedMs(context.state);
}

/** State slot a diff result renderer publishes its stats into so the call
 *  renderer can append them to the box header (`path · +3 -0`) on the same
 *  paint. One slot suffices: renderer state is per tool call, and a call never
 *  renders two diffs. */
const DIFF_HEADER_STATS_KEY = "__piStyleDiffHeaderStats";

/** Publish diff stats for the call header (called by settled result renderers). */
export function noteDiffHeaderStats(context: BoxedToolContext, stats: { additions: number; removals: number }): void {
	context.state[DIFF_HEADER_STATS_KEY] = { additions: stats.additions, removals: stats.removals };
}

/** Drop published diff stats (error / no-diff results keep the header clean). */
export function clearDiffHeaderStats(context: BoxedToolContext): void {
	delete context.state[DIFF_HEADER_STATS_KEY];
}

/** Colored `+N -M` diff stats pair: diff colors when nonzero, dim zeros. */
export function formatDiffStatsPair(theme: BoxTheme, additions: number, removals: number): string {
	const plus = additions > 0 ? theme.fg("toolDiffAdded", `+${additions}`) : theme.fg("dim", "+0");
	const minus = removals > 0 ? theme.fg("toolDiffRemoved", `-${removals}`) : theme.fg("dim", "-0");
	return `${plus} ${minus}`;
}

/** ` · +3 -0` header suffix with diff colors, or "" while no stats are
 *  published (pending call / error result). */
export function diffHeaderStatsSuffix(theme: BoxTheme, context: BoxedToolContext): string {
	const stats = context.state[DIFF_HEADER_STATS_KEY] as { additions?: unknown; removals?: unknown } | undefined;
	if (!stats || typeof stats !== "object") return "";
	const additions = Number(stats.additions);
	const removals = Number(stats.removals);
	if (!Number.isFinite(additions) || !Number.isFinite(removals)) return "";
	return ` · ${formatDiffStatsPair(theme, additions, removals)}`;
}

/** Footer parts with state-based elapsed when result.details lacks timing. */
export function boxedFooterWithState(
	theme: BoxTheme,
	result: BoxedToolResult | undefined,
	context: BoxedToolContext,
	extraParts: string[] = [],
): string {
	return formatBoxedFooterFromValues(theme, stateElapsedMs(context), getTextOutput(result), extraParts);
}

export function compactFooterWithState(
	theme: BoxTheme,
	result: BoxedToolResult,
	context: BoxedToolContext,
	options: { isError?: boolean; isPartial?: boolean } = {},
): Component {
	const elapsedMs = stateElapsedMs(context);
	return renderCompactBoxedFooter(theme, result, {
		state: context.state,
		isError: Boolean(options.isError ?? context.isError),
		isPartial: Boolean(options.isPartial ?? context.isPartial),
		...(elapsedMs === undefined ? {} : { elapsedMs }),
	});
}

export function resultFooterLines(
	theme: BoxTheme,
	result: BoxedToolResult,
	context: BoxedToolContext,
	extraParts: string[] = [],
): string[] {
	return [formatBoxedFooter(theme, result, extraParts, stateElapsedMs(context))];
}

type StateComponentCacheEntry = {
	key: string;
	component: Component;
};

/** Cache-key string parts at or below this length join verbatim; longer ones
 *  collapse to `length:hash` so the joined key length stays bounded regardless
 *  of raw output size. */
const CACHE_KEY_LONG_PART_THRESHOLD = 64;

/** 32-bit FNV-1a hash of a string as 8 lowercase hex digits. Local mirror of the
 *  compatibility probe's fingerprint hashing (the pi/ layer stays unreachable
 *  from features): deterministic, collision-safe for cache identity. */
function fnv1aHex(text: string): string {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** Fold one join part: strings longer than CACHE_KEY_LONG_PART_THRESHOLD
 *  collapse to `length:hash`; numbers/booleans pass through unchanged. */
function boundedCacheKeyPart(part: string | number | boolean): string | number | boolean {
	if (typeof part !== "string" || part.length <= CACHE_KEY_LONG_PART_THRESHOLD) return part;
	return `${part.length}:${fnv1aHex(part)}`;
}

export function getRenderCacheKey(prefix: string, theme: BoxTheme, ...parts: Array<string | number | boolean>): string {
	const pieces: Array<string | number | boolean> = [prefix, themeCacheKey(theme), getToolsRenderCacheSignature()];
	for (const part of parts) pieces.push(boundedCacheKeyPart(part));
	return pieces.join("|");
}

export function memoizedStateComponent(
	state: Record<string, unknown> | undefined,
	slot: string,
	key: string,
	build: () => Component,
): Component {
	if (!state || typeof state !== "object") return build();
	const cached = state[slot] as StateComponentCacheEntry | undefined;
	if (cached && cached.key === key) return cached.component;
	const component = build();
	state[slot] = { key, component } satisfies StateComponentCacheEntry;
	return component;
}

export function clearFooterState(context: BoxedToolContext): void {
	clearCompactBoxedFooter(context.state);
}

/** Result-details truncation line count when the native tool truncated output. */
export function truncationOutputLines(result: BoxedToolResult | undefined): number | undefined {
	if (!result) return undefined;
	const details = result.details as { truncation?: { outputLines?: number } } | undefined;
	const value = details?.truncation?.outputLines;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Result-details grep match-limit reached counter. */
export function matchLimitReached(result: BoxedToolResult | undefined): number | undefined {
	if (!result) return undefined;
	const details = result.details as { matchLimitReached?: number } | undefined;
	const value = details?.matchLimitReached;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ── Team transcript helpers (ADR 0012 §2) ─────────────────────────────────

/** `2m 03s`-style duration from producer milliseconds. Invalid or absent input
 *  yields undefined so callers omit the segment silently — never fabricated. */
export function formatDuration(ms: unknown): string | undefined {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad2 = (value: number): string => String(value).padStart(2, "0");
	if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
	if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
	return `${seconds}s`;
}

/** `↓146.5k`-style token count. Invalid or absent input yields undefined so
 *  callers omit the segment silently — never fabricated. */
export function formatTokens(tokens: unknown): string | undefined {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
	const compact = (value: number, suffix: string): string => {
		const rounded = Math.round(value * 10) / 10;
		return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}${suffix}`;
	};
	if (tokens >= 1e9) return `↓${compact(tokens / 1e9, "B")}`;
	if (tokens >= 1e6) return `↓${compact(tokens / 1e6, "M")}`;
	if (tokens >= 1e3) return `↓${compact(tokens / 1e3, "k")}`;
	return `↓${Math.round(tokens)}`;
}

/** Model label tail after `/` (ADR 0012 §6): collapsed contexts show the short
 *  id; expanded/full-detail contexts keep the canonical full ref. */
export function normalizeModelLabel(modelRef: unknown): string {
	if (typeof modelRef !== "string") return "";
	const value = modelRef.trim();
	const slash = value.lastIndexOf("/");
	return slash >= 0 ? value.slice(slash + 1) || value : value;
}

export interface NormalizePreviewOptions {
	/** Record-shape field keys dropped entirely (`Type`, `Teammate`, …). */
	dropFields?: readonly string[];
	/** Visible-width budget for middle-clipping long path tokens (default 48). */
	pathWidth?: number;
}

/** Default visible-width budget for path tokens inside collapsed previews. */
const PREVIEW_PATH_WIDTH = 48;

/** Filesystem-looking tokens only (`/…`, `~/…`, `./…`, `../…`); URLs keep their shape. */
const PREVIEW_PATH_PATTERN = /(^|[\s(\\"'])((?:~|\.{1,2})?\/[^\s"')\]]*)/g;

/** Middle-clip long path tokens inside one preview line via compactToolPath. */
function clipPreviewPaths(line: string, width: number): string {
	return line.replace(PREVIEW_PATH_PATTERN, (_match, lead: string, token: string) =>
		safeVisibleWidth(token) > width ? `${lead}${compactToolPath(token, width)}` : `${lead}${token}`,
	);
}

/** Strip inline markdown markers, keeping the text (ADR 0012 §2). Heading
 *  lines are dropped earlier: a heading-only line is a section title, not
 *  content. */
function stripInlineMarkdown(line: string): string {
	return line.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/`+/g, "");
}

/** `Key: value` shape of one record segment (pipe segments are split first). */
const LABELED_FIELD = /^([A-Za-z][A-Za-z0-9 ._-]{0,30}):\s?(.*)$/;

/** Parse one cleaned line as `Key: value` record noise: pipe-separated segments
 *  count as separate fields, `dropFields` keys disappear, and a ` — ` tail
 *  becomes the prose candidate (ADR 0012 §2, §8). */
function parseLabeledLine(line: string, drop: ReadonlySet<string>): { field?: string; proseTail?: string } | undefined {
	const dashIndex = line.indexOf(" — ");
	const headPart = dashIndex >= 0 ? line.slice(0, dashIndex).trim() : line.trim();
	const proseTail = dashIndex >= 0 ? line.slice(dashIndex + 3).trim() || undefined : undefined;
	// The line is a labeled record only when its first pipe segment carries a key.
	if (!LABELED_FIELD.test(headPart.split("|")[0] ?? "")) return undefined;
	const fields: string[] = [];
	for (const segment of headPart.split("|")) {
		const part = segment.trim();
		if (!part) continue;
		const segmentMatch = LABELED_FIELD.exec(part);
		if (segmentMatch && drop.has((segmentMatch[1] ?? "").trim().toLowerCase())) continue;
		fields.push(part);
	}
	const field = fields.length > 0 ? fields.join(" · ") : undefined;
	return { ...(field !== undefined ? { field } : {}), ...(proseTail !== undefined ? { proseTail } : {}) };
}

/** One shared collapse rule for EVERY team preview (ADR 0012 §2): notification
 *  preview, `get_subagent_result` body, `tasks_output` result, partial results,
 *  mail bodies. Strips markdown markers, drops empty lines, compacts leading
 *  `Key: value` labeled lines with ` · `, appends the first prose line after
 *  `— `, and bounds the result with `… +N lines`. Malformed input falls back
 *  to cleaned verbatim lines. */
export function normalizePreview(raw: unknown, options: NormalizePreviewOptions = {}): string {
	if (typeof raw !== "string") return "";
	const drop = new Set((options.dropFields ?? []).map((field) => field.toLowerCase()));
	const pathWidth = options.pathWidth ?? PREVIEW_PATH_WIDTH;
	const contentLines = raw
		.split(/\r\n|\r|\n/)
		.map((line) =>
			stripAnsi(line)
				.replace(/\p{Cc}/gu, " ")
				.trim(),
		)
		// Drop empty and heading-only lines (ADR 0012 §2): section titles are
		// structure, not content, and must not surface as preview prose.
		.filter((line) => line.length > 0 && !/^\s{0,3}#{1,6}(\s|$)/.test(line))
		.map((line) => stripInlineMarkdown(line).trim())
		.filter((line) => line.length > 0)
		.map((line) => clipPreviewPaths(line, pathWidth));
	if (contentLines.length === 0) return "";
	const fields: string[] = [];
	let prose: string | undefined;
	let consumed = 0;
	while (consumed < contentLines.length) {
		const parsed = parseLabeledLine(contentLines[consumed] ?? "", drop);
		if (!parsed) break;
		if (parsed.field) fields.push(parsed.field);
		if (parsed.proseTail) {
			prose = parsed.proseTail;
			consumed++;
			break;
		}
		consumed++;
	}
	if (prose === undefined && consumed < contentLines.length) {
		prose = contentLines[consumed];
		consumed++;
	}
	const head = fields.join(" · ");
	const body = prose === undefined ? head : head ? `${head} — ${prose}` : prose;
	const omitted = contentLines.length - consumed;
	return omitted > 0 ? `${body} … +${omitted} lines` : body;
}

export { boxedToolWidthKey, getTextOutput, resolveRelativePath, shortenPath };
