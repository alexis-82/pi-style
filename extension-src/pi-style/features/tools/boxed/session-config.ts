// Per-session render configuration for boxed tool presentation.
//
// Set once per session by the compatibility coordinator; read inside renderers.
// Kept out of the render path (no filesystem/config reads during render).

import { GLYPHS, type GlyphMode } from "../../../domain/theme.js";

export interface ToolsRenderConfig {
	maxCollapsedLines: number;
	maxExpandedLines: number;
	dimOutput: boolean;
	showElapsed: boolean;
	/** Open-tree glyph for the done batch header (Unicode `●`, ASCII `v`). */
	batchOpenGlyph: string;
	/** @deprecated Accepted for compatibility; always false. */
	nerdFonts: boolean;
	/** Explicit glyph mode shared with the resolved session theme. */
	glyphMode: GlyphMode;
	/** Collapse a completed turn's tool blocks into one summary line (ADR 0007). */
	collapseAfterTurn: boolean;
	/** Also collapse mutating tools (edit/write/…) into the summary; off keeps them visible. */
	collapseMutatingTools: boolean;
	/** Merge sequential same-file read chunks (large-file continuation reads) into
	 *  one expanding inline line instead of one line per chunk (ADR 0010). */
	mergeChunkedReads: boolean;
	/** Mirror of `messages.mergedTurnSummary`: the ended run's `➔` leader line
	 *  defers to the thought-segment labels (`◈ Thought N times · Called M
	 *  tools · …`). Set by the coordinator; read by the dispatcher. */
	mergedTurnSummary: boolean;
	/** Matches the messages-side thought glyph for tools-only merged runs. */
	mergedSummaryGlyph: string;
}

let sessionToolsConfig: ToolsRenderConfig = {
	maxCollapsedLines: 10,
	maxExpandedLines: 50,
	dimOutput: false,
	showElapsed: true,
	batchOpenGlyph: "●",
	nerdFonts: false,
	glyphMode: "unicode",
	collapseAfterTurn: true,
	collapseMutatingTools: false,
	mergeChunkedReads: true,
	mergedTurnSummary: true,
	mergedSummaryGlyph: "◈",
};

export function setToolsRenderConfig(config: Partial<ToolsRenderConfig>): void {
	sessionToolsConfig = { ...sessionToolsConfig, ...config, nerdFonts: false };
}

export function getToolsRenderConfig(): ToolsRenderConfig {
	return sessionToolsConfig;
}

/** Team event states (ADR 0012 §1): fill equals progress — the glyph flips
 *  exactly once, at settlement. */
export type TeamEventState = "running" | "settled" | "failed" | "stopped";

/** Team event glyph from the same explicit mode as the session theme. */
export function teamEventGlyph(state: TeamEventState): string {
	const preset = GLYPHS[getToolsRenderConfig().glyphMode];
	switch (state) {
		case "running":
			return preset.eventRunning;
		case "settled":
			return preset.eventSettled;
		case "failed":
			return preset.eventFailed;
		case "stopped":
			return preset.eventStopped;
	}
}

export function getToolsRenderCacheSignature(): string {
	return [
		sessionToolsConfig.maxCollapsedLines,
		sessionToolsConfig.maxExpandedLines,
		sessionToolsConfig.dimOutput ? 1 : 0,
		sessionToolsConfig.showElapsed ? 1 : 0,
		sessionToolsConfig.batchOpenGlyph,
		sessionToolsConfig.glyphMode,
		sessionToolsConfig.collapseAfterTurn ? 1 : 0,
		sessionToolsConfig.collapseMutatingTools ? 1 : 0,
		sessionToolsConfig.mergeChunkedReads ? 1 : 0,
		sessionToolsConfig.mergedTurnSummary ? 1 : 0,
		sessionToolsConfig.mergedSummaryGlyph,
	].join("|");
}

// Wall-clock elapsed tracking through the renderer context state (no tool
// re-registration, so result.details has no execution timing).
//
// Elapsed is computed live from the recorded start on every read, so a running
// tool keeps growing its displayed time. The value only freezes once the
// execution end is recorded (terminal result), which keeps the completed footer
// stable across later re-renders (expand toggles, terminal resizes).

const STARTED_AT_KEY = "__piStyleStartedAt";
const ENDED_AT_KEY = "__piStyleEndedAt";
const RESULT_SEEN_KEY = "__piStyleResultSeen";
const TICKER_KEY = "__piStyleElapsedTicker";

export function recordExecutionStarted(state: Record<string, unknown> | undefined, executionStarted: boolean): void {
	if (!executionStarted || !state || typeof state !== "object") return;
	if (typeof state[STARTED_AT_KEY] !== "number") state[STARTED_AT_KEY] = performance.now();
}

/** Freeze the elapsed at the first terminal render (idempotent). */
export function recordExecutionEnded(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	if (typeof state[ENDED_AT_KEY] !== "number") state[ENDED_AT_KEY] = performance.now();
}

export function getStateElapsedMs(state: Record<string, unknown> | undefined): number | undefined {
	if (!state || typeof state !== "object") return undefined;
	const started = state[STARTED_AT_KEY];
	if (typeof started !== "number") return undefined;
	const ended = state[ENDED_AT_KEY];
	if (typeof ended === "number") return Math.max(0, ended - started);
	return Math.max(0, performance.now() - started);
}

/** Whether a result renderer already produced a continuation for this call. */
export function isResultSeen(state: Record<string, unknown> | undefined): boolean {
	return Boolean(state && typeof state === "object" && state[RESULT_SEEN_KEY] === true);
}

/** Record that a result renderer ran for this call (streaming or final). */
export function markResultSeen(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	state[RESULT_SEEN_KEY] = true;
}

type TickerHandle = ReturnType<typeof setInterval>;

type ElapsedTickerEntry = {
	invalidate: () => void;
};

/** States currently subscribed to the shared elapsed-render ticker. */
const tickerEntries = new Map<Record<string, unknown>, ElapsedTickerEntry>();
let sharedTickerHandle: TickerHandle | undefined;

function ensureSharedTicker(): void {
	if (sharedTickerHandle !== undefined || tickerEntries.size === 0) return;
	sharedTickerHandle = setInterval(() => {
		for (const { invalidate } of tickerEntries.values()) invalidate();
	}, 1000) as unknown as TickerHandle;
}

function stopSharedTickerIfIdle(): void {
	if (sharedTickerHandle === undefined || tickerEntries.size > 0) return;
	clearInterval(sharedTickerHandle);
	sharedTickerHandle = undefined;
}

/**
 * While a tool is running, re-render once per second so live elapsed labels
 * tick without any output events. Idempotent per state.
 */
export function startElapsedTicker(state: Record<string, unknown> | undefined, invalidate: () => void): void {
	if (!state || typeof state !== "object") return;
	state[TICKER_KEY] = true;
	tickerEntries.set(state, { invalidate });
	ensureSharedTicker();
}

/** Stop a running tool's elapsed ticker (terminal result, error, session end). */
export function stopElapsedTicker(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	delete state[TICKER_KEY];
	tickerEntries.delete(state);
	stopSharedTickerIfIdle();
}

/** Stop every elapsed ticker (session start/shutdown). */
export function stopAllElapsedTickers(): void {
	for (const state of tickerEntries.keys()) delete state[TICKER_KEY];
	tickerEntries.clear();
	stopSharedTickerIfIdle();
}

export function __getElapsedTickerDebugState(): { trackedStates: number; hasSharedTicker: boolean } {
	return { trackedStates: tickerEntries.size, hasSharedTicker: sharedTickerHandle !== undefined };
}
