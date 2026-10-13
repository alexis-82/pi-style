import { type Component, MouseRegion, Text } from "@earendil-works/pi-tui";
import { visibleWidth } from "../../shared/ansi.js";
import type { BoxTheme } from "../../shared/box.js";
import { formatElapsedMs } from "../../shared/elapsed.js";
import {
	type MergedSegmentStats,
	mergedSummaryText,
	toggleTurnsForMessages,
	turnsOpenForMessages,
} from "../../shared/turn-summary-bridge.js";
import {
	isThoughtGroupExpanded,
	observeThoughtMessage,
	parseThinkingRuns,
	resetAgentThoughtRuns,
	setThoughtGroupOpen,
	type ThoughtGroupPresentation,
	toggleThoughtGroup,
} from "./thought-summary.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
type OscParts = { start: string; body: string; end: string };
type LineAnalysis = {
	visibleWidth: number;
	hasContent: boolean;
	oscEnvelope: OscParts | undefined;
	hasOscStart: boolean;
	leadingMarkers: { head: string; rest: string };
	isBackgroundWrapped: boolean;
	backgroundAnsi: string;
	backgroundBody: string | undefined;
	backgroundBodyWidth: number | undefined;
};
type DecoratedRenderCacheEntry = {
	nativeRef: readonly string[];
	nativeLines: readonly string[];
	result: readonly string[];
};
type ChildrenScanState = { childrenRef: readonly unknown[]; length: number };
type MessageDecorationTestState = {
	decoratePasses: number;
	cacheHits: number;
	cacheMisses: number;
	lineCacheHits: number;
	lineCacheMisses: number;
};

const BG_RESET = "\x1b[49m";
const MAX_RENDER_CACHE_KEYS_PER_INSTANCE = 8;
const MAX_LINE_ANALYSIS_ENTRIES = 4096;

let renderCacheByInstance = new WeakMap<object, Map<string, DecoratedRenderCacheEntry>>();
let lineAnalysisCache = new Map<string, LineAnalysis>();
// Live iterator over the analysis cache's insertion (= recency) order, reused
// across evictions: `keys().next()` allocates a fresh iterator (~1.4µs) each
// call, which dominates the per-insert eviction cost during streaming. A live
// Map iterator skips deleted entries and always hands back the current
// least-recently-used key, so eviction choice is identical to a fresh iterator.
let lineCacheEvictionCursor: Iterator<string, undefined, undefined> | undefined;
// Per-assistant-message guard for the updateContent children scan: skips the
// blank/interim scans when the contentContainer children array is unchanged.
let childrenScanByInstance = new WeakMap<object, ChildrenScanState>();
const messageDecorationTestState: MessageDecorationTestState = {
	decoratePasses: 0,
	cacheHits: 0,
	cacheMisses: 0,
	lineCacheHits: 0,
	lineCacheMisses: 0,
};

function extractOscEnvelope(line: string): OscParts | undefined {
	if (!line.startsWith(OSC133_ZONE_START)) return undefined;
	const bodyEnd = line.indexOf(OSC133_ZONE_END, OSC133_ZONE_START.length);
	if (bodyEnd < 0 || !line.endsWith(OSC133_ZONE_FINAL)) return undefined;
	return { start: OSC133_ZONE_START, body: line.slice(OSC133_ZONE_START.length, bodyEnd), end: line.slice(bodyEnd) };
}

/** Leading zero-width OSC sequences (e.g. OSC133 markers) of a line. */
function splitLeadingMarkers(line: string): { head: string; rest: string } {
	let index = 0;
	while (line.startsWith("\x1b]", index)) {
		const bel = line.indexOf("\x07", index + 2);
		const st = line.indexOf("\x1b\\", index + 2);
		const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
		if (end === -1) break;
		index = end + 1;
	}
	// Strings are immutable: with no markers, `rest` can alias the line itself
	// instead of allocating a full copy on every analyzed line.
	return index === 0 ? { head: "", rest: line } : { head: line.slice(0, index), rest: line.slice(index) };
}

/** Leading SGR escape sequence of a line ("" when none). */
function leadingSgr(line: string): string {
	if (!line.startsWith("\x1b[")) return "";
	let index = 2;
	while (index < line.length) {
		const code = line.charCodeAt(index);
		if (code >= 64 && code <= 126) return line.slice(0, index + 1);
		index++;
	}
	return "";
}

/** Whether an SGR sequence sets/resets the terminal background color (allocation-free `Number`-equivalent parse). */
function isBackgroundSgr(sequence: string): boolean {
	if (!sequence.startsWith("\x1b[") || !sequence.endsWith("m")) return false;
	// Splits on ";" and applies Number() per token: Number("") === 0, all-digit
	// tokens parse as integers, anything else is NaN (matches no range).
	let value = 0;
	let empty = true;
	let valid = true;
	for (let index = 2; index < sequence.length - 1; index++) {
		const code = sequence.charCodeAt(index);
		if (code === 0x3b) {
			if (valid && matchesBackgroundCode(empty ? 0 : value)) return true;
			value = 0;
			empty = true;
			valid = true;
			continue;
		}
		if (code < 0x30 || code > 0x39) {
			valid = false;
			continue;
		}
		value = value * 10 + (code - 0x30);
		empty = false;
	}
	return valid && matchesBackgroundCode(empty ? 0 : value);
}

function matchesBackgroundCode(value: number): boolean {
	return value === 48 || value === 49 || (value >= 40 && value <= 47) || (value >= 100 && value <= 107);
}

/**
 * Width of a string whose visible content is printable ASCII carrying only
 * escapes pi-tui recognizes (CSI ending in m/G/K/H/J, OSC/APC ending in BEL or
 * ST) — computed in one scan, no Intl.Segmenter pass. Returns undefined whenever
 * the string can leave that domain (tabs, controls, non-ASCII, or
 * unrecognized/unterminated escapes); callers then delegate to `visibleWidth`,
 * which makes the result provably identical to pi-tui's while skipping grapheme
 * segmentation for the streaming-hot line shapes. The escape scan mirrors
 * pi-tui's `extractAnsiCode` exactly (including tab-in-sequence handling, since
 * pi-tui replaces tabs before scanning but still consumes the same sequence).
 */
function certifiedAsciiWidth(value: string): number | undefined {
	let width = 0;
	let index = 0;
	const length = value.length;
	while (index < length) {
		const code = value.charCodeAt(index);
		if (code === 0x1b) {
			const next = index + 1 < length ? value.charCodeAt(index + 1) : -1;
			if (next === 0x5b) {
				// CSI: pi-tui consumes through the first m/G/K/H/J byte.
				let scan = index + 2;
				while (scan < length) {
					const terminator = value.charCodeAt(scan);
					if (
						terminator === 0x6d || // m
						terminator === 0x47 || // G
						terminator === 0x4b || // K
						terminator === 0x48 || // H
						terminator === 0x4a // J
					) {
						index = scan + 1;
						break;
					}
					scan++;
				}
				if (scan >= length) return undefined; // unterminated: pi-tui emits the ESC visibly
				continue;
			}
			if (next === 0x5d || next === 0x5f) {
				// OSC/APC: consumed through BEL or ST (ESC \).
				let scan = index + 2;
				let end = -1;
				while (scan < length) {
					const terminator = value.charCodeAt(scan);
					if (terminator === 0x07) {
						end = scan + 1;
						break;
					}
					if (terminator === 0x1b && scan + 1 < length && value.charCodeAt(scan + 1) === 0x5c) {
						end = scan + 2;
						break;
					}
					scan++;
				}
				if (end < 0) return undefined; // unterminated: delegate
				index = end;
				continue;
			}
			return undefined; // any other escape form: delegate
		}
		if (code < 0x20 || code > 0x7e) return undefined; // tab/control/non-ASCII: delegate
		width++;
		index++;
	}
	return width;
}

/** visibleWidth with a single-scan fast path; identical results, cheaper for streaming-hot lines. */
function certifiedVisibleWidth(value: string): number {
	return certifiedAsciiWidth(value) ?? visibleWidth(value);
}

/**
 * Memoized prefix width: the prefix (typically non-ASCII, e.g. "│ ") always
 * delegates to pi-tui's visibleWidth, and the streaming-hot unique lines evict
 * it from pi-tui's internal FIFO width cache, re-segmenting it every pass.
 * visibleWidth is pure, so a one-entry memo is exactly equivalent.
 */
let prefixWidthMemo: { prefix: string; width: number } | undefined;
function prefixWidthOf(prefix: string): number {
	if (prefixWidthMemo?.prefix === prefix) return prefixWidthMemo.width;
	const width = certifiedVisibleWidth(prefix);
	prefixWidthMemo = { prefix, width };
	return width;
}

function contentText(line: string): string {
	// Fast path: every OSC133 marker contains ESC and the strip loop below copies
	// every non-ESC char verbatim — an ESC-free line is its own content text.
	if (!line.includes("\x1b")) return line;
	// Slice-based build: one concatenation per escape span instead of per char.
	let output = "";
	let sliceStart = 0;
	for (let index = 0; index < line.length; index++) {
		if (line.charCodeAt(index) !== 27) continue;
		output += line.slice(sliceStart, index);
		const next = line[index + 1];
		if (next === "]") {
			index += 2;
			while (index < line.length && line.charCodeAt(index) !== 7) index++;
		} else if (next === "[") {
			index += 2;
			while (index < line.length && (line.charCodeAt(index) < 64 || line.charCodeAt(index) > 126)) index++;
		}
		sliceStart = index + 1;
	}
	output += line.slice(sliceStart);
	// The strip above can never leave an ESC in the output (every ESC consumes at
	// least itself, and both escape branches run to their terminator or end of
	// line), so these marker removals are a provably-untaken safety net.
	if (output.includes("\x1b]133;")) {
		return output.replaceAll(OSC133_ZONE_START, "").replaceAll(OSC133_ZONE_END, "").replaceAll(OSC133_ZONE_FINAL, "");
	}
	return output;
}

/** Whether a BMP code unit is whitespace with exact `\s` regex semantics (ECMAScript WhiteSpace + LineTerminator). */
function isWhitespaceCode(code: number): boolean {
	// Fast path: ASCII whitespace — space, \t, \n, \v, \f, \r.
	if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
	if (code < 0x80) return false;
	// The non-ASCII members of \s (no surrogates or astral code points are whitespace).
	return (
		code === 0x00a0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

/** Whether the line carries any non-whitespace content, in one ANSI-skipping scan (no content string built, no code-point array, no per-char regex). */
function hasContent(line: string): boolean {
	const length = line.length;
	let index = 0;
	while (index < length) {
		const code = line.charCodeAt(index);
		if (code === 0x1b) {
			// Skip exactly the spans contentText strips: OSC through BEL, CSI through
			// its final byte; a lone ESC drops just itself.
			const next = index + 1 < length ? line.charCodeAt(index + 1) : -1;
			if (next === 0x5d) {
				index += 2;
				while (index < length && line.charCodeAt(index) !== 0x07) index++;
			} else if (next === 0x5b) {
				index += 2;
				while (index < length) {
					const inner = line.charCodeAt(index);
					if (inner >= 64 && inner <= 126) break;
					index++;
				}
			}
			index++;
			continue;
		}
		// Surrogate halves never match \s: an astral code point (or a lone surrogate)
		// always counts as content, equivalent to the previous per-code-point regex.
		if (code >= 0xd800 && code <= 0xdfff) return true;
		if (!isWhitespaceCode(code)) return true;
		index++;
	}
	return false;
}

function getLineAnalysis(line: string): LineAnalysis {
	const cached = lineAnalysisCache.get(line);
	if (cached) {
		messageDecorationTestState.lineCacheHits++;
		// True LRU: re-insert on hit so recency is refreshed; the eviction below then
		// drops the least recently used entry instead of the oldest inserted one.
		lineAnalysisCache.delete(line);
		lineAnalysisCache.set(line, cached);
		return cached;
	}
	messageDecorationTestState.lineCacheMisses++;
	const leadingMarkers = splitLeadingMarkers(line);
	const backgroundAnsi = leadingSgr(leadingMarkers.rest);
	const isBackgroundWrapped =
		backgroundAnsi !== "" && isBackgroundSgr(backgroundAnsi) && leadingMarkers.rest.endsWith(BG_RESET);
	const backgroundBody = isBackgroundWrapped
		? leadingMarkers.rest.slice(backgroundAnsi.length, leadingMarkers.rest.length - BG_RESET.length)
		: undefined;
	const hasOscStart = line.startsWith(OSC133_ZONE_START);
	const analysis: LineAnalysis = {
		visibleWidth: certifiedVisibleWidth(line),
		hasContent: hasContent(line),
		oscEnvelope: hasOscStart ? extractOscEnvelope(line) : undefined,
		hasOscStart,
		leadingMarkers,
		isBackgroundWrapped,
		backgroundAnsi,
		backgroundBody,
		backgroundBodyWidth: backgroundBody === undefined ? undefined : certifiedVisibleWidth(backgroundBody),
	};
	lineAnalysisCache.set(line, analysis);
	if (lineAnalysisCache.size > MAX_LINE_ANALYSIS_ENTRIES) {
		let cursor = lineCacheEvictionCursor;
		if (cursor === undefined) cursor = lineAnalysisCache.keys();
		let oldest = cursor.next();
		if (oldest.done) {
			// Every not-yet-visited entry was refreshed past the cursor; restart from the true LRU head.
			cursor = lineAnalysisCache.keys();
			oldest = cursor.next();
		}
		lineCacheEvictionCursor = cursor;
		if (!oldest.done && oldest.value !== undefined) lineAnalysisCache.delete(oldest.value);
	}
	return analysis;
}

function rebuildAtWidth(
	line: string,
	width: number,
	lead: string,
	leadWidth: number,
	analysis = getLineAnalysis(line),
): string {
	if (
		analysis.isBackgroundWrapped &&
		analysis.backgroundBody !== undefined &&
		analysis.backgroundBodyWidth !== undefined
	) {
		const pad = " ".repeat(Math.max(0, width - leadWidth - analysis.backgroundBodyWidth));
		return `${analysis.leadingMarkers.head}${analysis.backgroundAnsi}${lead}${analysis.backgroundBody}${pad}${BG_RESET}`;
	}
	const pad = " ".repeat(Math.max(0, width - leadWidth - analysis.visibleWidth));
	return `${lead}${line}${pad}`;
}

function decorateMessageLine(
	line: string,
	index: number,
	lastIndex: number,
	contentIndex: number,
	width: number,
	options: {
		firstEnvelope: OscParts | undefined;
		firstHasStart: boolean;
		multilineEnvelope: boolean;
		prefix: string;
		prefixWidth: number;
		continuationLead: string;
		/** Rail range (inclusive): lines of an expanded leading thinking region
		 *  that render with the role-prefix rail instead of no lead. */
		railStart: number | undefined;
		railEnd: number | undefined;
	},
	analysis = getLineAnalysis(line),
): string {
	const { firstEnvelope, firstHasStart, multilineEnvelope, prefix, prefixWidth, continuationLead, railStart, railEnd } =
		options;
	const railed = railStart !== undefined && railEnd !== undefined && index >= railStart && index <= railEnd;
	const lead = railed ? prefix : index === contentIndex ? prefix : index > contentIndex ? continuationLead : "";
	const leadWidth = railed || index >= contentIndex ? prefixWidth : 0;
	if (index === contentIndex && firstEnvelope)
		return `${firstEnvelope.start}${rebuildAtWidth(firstEnvelope.body, width, prefix, prefixWidth)}${firstEnvelope.end}`;
	if (index === contentIndex && firstHasStart)
		return `${OSC133_ZONE_START}${rebuildAtWidth(line.slice(OSC133_ZONE_START.length), width, prefix, prefixWidth)}`;
	if (index === lastIndex && multilineEnvelope && index !== contentIndex)
		return `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${rebuildAtWidth(
			line.slice((OSC133_ZONE_END + OSC133_ZONE_FINAL).length),
			width,
			lead,
			leadWidth,
		)}`;
	if (
		index === contentIndex &&
		index === lastIndex &&
		multilineEnvelope &&
		line.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)
	)
		return `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${rebuildAtWidth(
			line.slice((OSC133_ZONE_END + OSC133_ZONE_FINAL).length),
			width,
			prefix,
			prefixWidth,
		)}`;
	return rebuildAtWidth(line, width, lead, leadWidth, analysis);
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function cacheKey(width: number, prefix: string, skip: number | undefined): string {
	return `${width}\u0000${prefix}\u0000${skip ?? ""}`;
}

function getRenderCache(instance: object): Map<string, DecoratedRenderCacheEntry> {
	let cache = renderCacheByInstance.get(instance);
	if (!cache) {
		cache = new Map();
		renderCacheByInstance.set(instance, cache);
	}
	return cache;
}

function storeRenderCache(
	instance: object,
	width: number,
	prefix: string,
	native: readonly string[],
	result: readonly string[],
	skip: number | undefined,
): void {
	const cache = getRenderCache(instance);
	const key = cacheKey(width, prefix, skip);
	if (cache.has(key)) cache.delete(key);
	cache.set(key, { nativeRef: native, nativeLines: [...native], result: [...result] });
	while (cache.size > MAX_RENDER_CACHE_KEYS_PER_INSTANCE) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) break;
		cache.delete(oldestKey);
	}
}

/** Whether a rendered line's visible text is a thought-summary row (collapsed
 *  label or expanded header). Such rows carry their own `▸`/`∨` (or ASCII
 *  `>`/`v`) state glyph, so the assistant-role prefix skips them: the glyph
 *  marks the row, `│ ` keeps marking the message's first real content line. */
function isThoughtSummaryRenderLine(line: string, glyph: string): boolean {
	const text = contentText(line).trim();
	if (text.startsWith(`${glyph} Thought`)) return true;
	if (!text.startsWith(`${glyph} `)) return false;
	const suffix = text.slice(glyph.length + 1);
	const separator = suffix.indexOf(" ");
	if (separator <= 0) return false;
	const count = suffix.slice(0, separator);
	const noun = suffix.slice(separator + 1);
	return /^\d+$/.test(count) && (noun === "thought" || noun.startsWith("thought ·") || noun.startsWith("thoughts"));
}

/** Leading thought-region children (top spacer, label/header rows, expanded
 *  thinking content, trailing spacer) of instances whose message STARTS with
 *  an expanded thinking run. At render time their line count tells the prefix
 *  decoration exactly where the first answer line begins, so thinking content
 *  never receives the `│ ` role prefix. */
type ThoughtLeadingSkip = { children: readonly object[] };

let thoughtLeadingSkipByInstance = new WeakMap<object, ThoughtLeadingSkip>();

/** Render-time line accounting over the recorded leading children; `undefined`
 *  when the state is absent or a child cannot be rendered (fall back to the
 *  content scan). Children render deterministically and pi-tui caches renders
 *  by width, so the accounting re-uses the upcoming full-render work. */
function leadingSkipLineCount(instance: object, width: number): number | undefined {
	const state = thoughtLeadingSkipByInstance.get(instance);
	if (!state || state.children.length === 0) return undefined;
	let count = 0;
	for (const child of state.children) {
		const render = (child as { render?: unknown }).render;
		if (typeof render !== "function") return undefined;
		const lines = (render as (width: number) => unknown).call(child, width);
		if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return undefined;
		count += lines.length;
	}
	return count;
}

function prefixNative(
	lines: unknown,
	width: number,
	prefix: string,
	thoughtGlyph: string | undefined,
	/** Structural first-content override: when an expanded thinking block leads
	 *  the message, the prefix must land on the answer's first line, not on the
	 *  thinking content — computed by child accounting in decorateMessageRender. */
	forcedFirstContentIndex: number | undefined,
): string[] | undefined {
	if (!Array.isArray(lines) || lines.length === 0 || !lines.every((line) => typeof line === "string")) return undefined;
	messageDecorationTestState.decoratePasses++;
	const nativeLines = lines as string[];
	const prefixWidth = prefixWidthOf(prefix);
	if (width <= prefixWidth) return undefined;
	const bodyWidth = width - prefixWidth;
	// One cache lookup per line per pass; every later consumer reuses this array
	// instead of re-requesting analysis (and re-churning LRU recency) per line.
	const analyses = nativeLines.map((line) => getLineAnalysis(line));
	const last = nativeLines.at(-1) ?? "";
	const lastAnalysis = analyses[analyses.length - 1] ?? getLineAnalysis(last);
	const multilineEnvelope = nativeLines.length > 1 && last.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL);
	// The last line is a content-start candidate only when the envelope is
	// single-line, or when no earlier line carries content. Assistant messages
	// with a single content line render as a multiline envelope whose only body
	// sits on the final line ([OSC133_A, OSC133_END+FINAL+body]); excluding it
	// would drop the prefix for every short assistant reply.
	let firstContentIndex = -1;
	let scanForFirstContent = true;
	if (forcedFirstContentIndex !== undefined) {
		if (forcedFirstContentIndex > nativeLines.length) return nativeLines;
		// A leading expanded thinking region may consume the entire assistant
		// component (thinking + tool call, with the tool rendered separately). Keep
		// its structural end index so the thought rail can still be decorated even
		// though there is no answer line on which to land the role prefix.
		if (forcedFirstContentIndex === nativeLines.length) {
			firstContentIndex = forcedFirstContentIndex;
			scanForFirstContent = false;
		} else {
			const forcedAnalysis =
				analyses[forcedFirstContentIndex] ?? getLineAnalysis(nativeLines[forcedFirstContentIndex] ?? "");
			if (forcedAnalysis.hasContent) {
				firstContentIndex = forcedFirstContentIndex;
				scanForFirstContent = false;
			}
		}
	}
	if (scanForFirstContent)
		for (let index = 0; index < nativeLines.length; index++) {
			const analysis = analyses[index] ?? getLineAnalysis(nativeLines[index] ?? "");
			if (index !== nativeLines.length - 1 || !multilineEnvelope) {
				if (analysis.hasContent) {
					// Thought-summary rows render with their own state glyph and take the
					// continuation indent instead of the role prefix.
					if (thoughtGlyph && isThoughtSummaryRenderLine(nativeLines[index] ?? "", thoughtGlyph)) continue;
					firstContentIndex = index;
					break;
				}
				continue;
			}
			let earlierHasContent = false;
			for (let earlier = 0; earlier < index; earlier++) {
				const earlierAnalysis = analyses[earlier] ?? getLineAnalysis(nativeLines[earlier] ?? "");
				// Thought-summary rows are content-start candidates themselves, so they do
				// not count as "earlier content" either — otherwise the skipped row would
				// suppress the prefix on the first real content line.
				if (
					earlierAnalysis.hasContent &&
					!(thoughtGlyph && isThoughtSummaryRenderLine(nativeLines[earlier] ?? "", thoughtGlyph))
				) {
					earlierHasContent = true;
					break;
				}
			}
			if (
				!earlierHasContent &&
				lastAnalysis.hasContent &&
				!(thoughtGlyph && isThoughtSummaryRenderLine(last, thoughtGlyph))
			) {
				firstContentIndex = index;
			}
			break;
		}
	if (firstContentIndex < 0) return nativeLines;
	const firstAnalysis = analyses[0] ?? getLineAnalysis(nativeLines[0] ?? "");
	const firstEnvelope = firstContentIndex === 0 ? firstAnalysis.oscEnvelope : undefined;
	const firstHasStart = firstContentIndex === 0 && firstAnalysis.hasOscStart;
	const continuationLead = " ".repeat(prefixWidth);
	// Rail range: when a leading expanded thinking block precedes the first
	// content line, its content lines (after the summary header, up to the
	// region's last content line — blank lines inside keep the rail for a
	// continuous quote bar, trailing blanks do not) render with the `│ ` rail.
	let railStart: number | undefined;
	let railEnd: number | undefined;
	if (forcedFirstContentIndex !== undefined && forcedFirstContentIndex > 0) {
		let headerIndex = -1;
		let lastContent = -1;
		for (let regionIndex = 0; regionIndex < forcedFirstContentIndex; regionIndex++) {
			const regionLine = nativeLines[regionIndex] ?? "";
			const regionAnalysis = analyses[regionIndex] ?? getLineAnalysis(regionLine);
			if (!regionAnalysis.hasContent) continue;
			if (headerIndex < 0 && thoughtGlyph && isThoughtSummaryRenderLine(regionLine, thoughtGlyph)) {
				headerIndex = regionIndex;
				continue;
			}
			lastContent = regionIndex;
		}
		if (lastContent >= 0) {
			// Aggregate headers exist only on the segment leader. Later assistant
			// messages in the same expanded segment still render as one continuous
			// thought quote, beginning at their first substantive region line.
			railStart =
				headerIndex >= 0
					? headerIndex + 1
					: nativeLines.findIndex((line, index) => {
							if (index >= forcedFirstContentIndex) return false;
							return (analyses[index] ?? getLineAnalysis(line)).hasContent;
						});
			if (railStart >= 0) railEnd = lastContent;
			else railStart = undefined;
		}
	}
	const decorated = nativeLines.map((line, index) =>
		decorateMessageLine(
			line,
			index,
			nativeLines.length - 1,
			firstContentIndex,
			width,
			{
				firstEnvelope,
				firstHasStart,
				multilineEnvelope,
				prefix,
				prefixWidth,
				continuationLead,
				railStart,
				railEnd,
			},
			analyses[index],
		),
	);
	if (!decorated.every((line) => certifiedVisibleWidth(line) <= width)) return undefined;
	if (!analyses.every((analysis) => analysis.visibleWidth <= bodyWidth)) return undefined;
	return decorated;
}

export type MessageDecorationSnapshot = Readonly<{
	assistantPrefix: string;
	assistantEnabled: boolean;
	/** Drop the hidden-thinking label row and its trailing spacer (zero-trace collapse). */
	collapseHiddenThinking: boolean;
	/** Replace per-run labels with one clickable `<glyph> N thoughts · <time>`
	 *  aggregate per contiguous segment after the agent run completes. Visible
	 *  assistant text splits segments; active runs keep zero-trace. */
	thoughtSummary?: boolean;
	/** Interleaved run-progress labels: after the agent run completes, every
	 *  segment leader renders `◈ Thought N times · Called M tools · …` with the
	 *  CUMULATIVE totals through its segment (the last label carries the run
	 *  totals), and the run's `➔` leader line hides when every message of the
	 *  run belongs to an ended segment (`messages.mergedTurnSummary`). */
	mergedTurnSummary?: boolean;
	/** Glyph for the thought summary row — one glyph for both states (the
	 *  content below an expanded header is what distinguishes them). Unicode
	 *  `◈` by default (`>` in ASCII mode; U+23F5 ⏵ was rejected for spotty
	 *  monospace-font coverage — swap here if a variant is ever wanted). */
	thoughtGlyph?: string;
}>;

export function __getMessageDecorationTestState(): Readonly<MessageDecorationTestState> {
	return { ...messageDecorationTestState };
}

export function __resetMessageDecorationTestState(): void {
	messageDecorationTestState.decoratePasses = 0;
	messageDecorationTestState.cacheHits = 0;
	messageDecorationTestState.cacheMisses = 0;
	messageDecorationTestState.lineCacheHits = 0;
	messageDecorationTestState.lineCacheMisses = 0;
	renderCacheByInstance = new WeakMap<object, Map<string, DecoratedRenderCacheEntry>>();
	lineAnalysisCache = new Map<string, LineAnalysis>();
	lineCacheEvictionCursor = undefined;
	thoughtTimingByInstance = new WeakMap<object, ThoughtTimingState>();
	thoughtDurationsBySignature.clear();
	resetAgentThoughtRuns();
	thoughtLeadingSkipByInstance = new WeakMap<object, ThoughtLeadingSkip>();
	sessionThoughtTheme = undefined;
	childrenScanByInstance = new WeakMap<object, ChildrenScanState>();
}

export function decorateMessageRender(
	original: unknown,
	instance: object,
	args: unknown[],
	snapshot: MessageDecorationSnapshot = {
		assistantPrefix: "│ ",
		assistantEnabled: true,
		collapseHiddenThinking: false,
		mergedTurnSummary: false,
	},
): unknown {
	if (typeof original !== "function") return undefined;
	const width = typeof args[0] === "number" ? args[0] : 0;
	const prefix = snapshot.assistantPrefix;
	if (!snapshot.assistantEnabled) return Reflect.apply(original, instance, args);
	const prefixWidth = prefixWidthOf(prefix);
	if (width <= prefixWidth) return Reflect.apply(original, instance, args);
	// Exactly one native invocation. If the reduced render cannot be certified, the
	// already-obtained result is the only safe fallback; retrying can mutate state.
	const reducedWidth = width - prefixWidth;
	const native = Reflect.apply(original, instance, [reducedWidth, ...args.slice(1)]);
	if (!Array.isArray(native) || !native.every((line) => typeof line === "string")) return native;
	// One accounting per pass (children render deterministically; pi-tui caches
	// renders by width, so the accounting re-uses the full-render work).
	const leadingSkip = leadingSkipLineCount(instance, reducedWidth);
	const finished = (instance as { isStreaming?: unknown }).isStreaming !== true;
	const cached = finished ? getRenderCache(instance).get(cacheKey(width, prefix, leadingSkip)) : undefined;
	if (cached && (cached.nativeRef === native || sameLines(cached.nativeLines, native))) {
		messageDecorationTestState.cacheHits++;
		return [...cached.result];
	}
	messageDecorationTestState.cacheMisses++;
	const decorated = prefixNative(native, width, prefix, snapshot.thoughtGlyph, leadingSkip) ?? native;
	if (finished) storeRenderCache(instance, width, prefix, native, decorated, leadingSkip);
	return decorated;
}

/** Spacer-like: renders empty lines and exposes only setLines among these surfaces. */
function isSpacerChild(child: unknown): boolean {
	return typeof (child as { setLines?: unknown } | undefined)?.setLines === "function";
}

/**
 * The hidden-thinking placeholder: a Text (setCustomBgFn) whose ANSI-stripped
 * rendered content is empty. Duck-typed on the public shape because
 * pi-coding-agent may resolve its own nested pi-tui copy, so `instanceof`
 * across that module boundary is unreliable.
 *
 * Pi 0.85.0 wraps every thinking-run component (the hidden label Text or the
 * visible thinking Markdown) in a `MouseRegion` for click-to-toggle visibility.
 * `MouseRegion` is render-transparent, so the placeholder check unwraps it first
 * (duck-typed: a `handleMouse` function plus a `child`), keeping the same
 * Text detection for the pre-0.85 bare-Text layout.
 */
function unwrapMouseRegion(child: unknown): unknown {
	const candidate = child as { handleMouse?: unknown; child?: unknown } | undefined;
	if (typeof candidate?.handleMouse !== "function" || candidate.child === undefined) return child;
	return candidate.child;
}

function isBlankTextChild(child: unknown): boolean {
	const candidate = unwrapMouseRegion(child) as
		| { setCustomBgFn?: unknown; render?: (width: number) => string[]; text?: unknown }
		| undefined;
	if (typeof candidate?.setCustomBgFn !== "function" || typeof candidate.render !== "function") return false;
	// pi-tui's Text exposes its raw source text as a plain `.text` property (kept in
	// sync by the constructor and setText). render(0) only wraps/pads that text with
	// spaces and ANSI (both blank under contentText+trim), so the property check is
	// equivalent — and avoids a full Text render per child on every updateContent pass
	// (which would also pollute Text's own width-keyed render cache with width 0).
	if (typeof candidate.text === "string") return contentText(candidate.text).trim() === "";
	return contentText(candidate.render(0).join("\n")).trim() === "";
}

/**
 * Skip the post-update children scans when nothing could have changed:
 * `AssistantMessageComponent.updateContent` starts every pass with
 * `contentContainer.clear()`, and pi-tui's `Container.clear()` assigns a fresh
 * `children` array (children are REPLACED, never mutated in place across passes).
 * An unchanged reference (and length) therefore means the native layout did not
 * rebuild since this instance was last scanned, so the previous scan's collapse
 * is still in effect. Kept per-instance via WeakMap so messages are GC-able.
 */
function childrenUnchangedSinceScan(instance: object, children: readonly unknown[]): boolean {
	const state = childrenScanByInstance.get(instance);
	return state !== undefined && state.childrenRef === children && state.length === children.length;
}

function markChildrenScanned(instance: object, children: readonly unknown[]): void {
	childrenScanByInstance.set(instance, { childrenRef: children, length: children.length });
}

/**
 * Per-instance thinking-run timing for the thought summary label. `startedAt`
 * is the first updateContent pass that observed the run, `endedAt` the first
 * pass that observed it complete, and `streamed` whether a pass ever saw the
 * run mid-stream. Durations are only shown for runs the extension watched
 * stream live: messages restored from history (resume/scroll-back rebuilds)
 * are first observed already complete, so their group falls back to a
 * duration-less `N thoughts` aggregate instead of a fabricated number.
 */
interface ThoughtRunTiming {
	startedAt: number;
	endedAt: number | undefined;
	streamed: boolean;
}
type ThoughtTimingState = { runs: Map<number, ThoughtRunTiming> };

let thoughtTimingByInstance = new WeakMap<object, ThoughtTimingState>();

/**
 * Completed-run durations keyed by thinking-content signature. Pi's `agent_end`
 * removes the streaming AssistantMessageComponent and the history re-render
 * rebuilds every message as a fresh component, so per-instance timing never
 * reaches the component the user actually sees. A finalized run's duration is
 * therefore also recorded under a content signature (length + head/tail of the
 * run's thinking text), and a replacement component first observing the run
 * already complete looks the duration up instead of falling back to the
 * duration-less label. Insertion-order LRU, bounded: real reasoning text never
 * repeats across messages, so a collision would require identical content
 * (harmless — identical content earns the same duration). The bounded map is
 * process-scoped through `Symbol.for`: extension/session module reloads recover
 * live measurements, while a genuinely new Pi process still starts empty and
 * keeps the duration-less fallback by design.
 */
const THOUGHT_DURATION_REGISTRY_LIMIT = 256;
const THOUGHT_DURATION_PROCESS_KEY = Symbol.for("@quandev104/pi-style/thought-durations/v1");
const processState = globalThis as unknown as Record<PropertyKey, unknown>;
const existingThoughtDurations = processState[THOUGHT_DURATION_PROCESS_KEY];
const thoughtDurationsBySignature =
	existingThoughtDurations instanceof Map
		? (existingThoughtDurations as Map<string, number>)
		: new Map<string, number>();
if (!(existingThoughtDurations instanceof Map))
	processState[THOUGHT_DURATION_PROCESS_KEY] = thoughtDurationsBySignature;

function thoughtDurationKey(runIndex: number, text: string): string {
	const head = text.slice(0, 64);
	const tail = text.length > 64 ? text.slice(-64) : "";
	return `#${runIndex}:${text.length}:${head}⋮${tail}`;
}

function recordThoughtDuration(key: string, durationMs: number): void {
	if (thoughtDurationsBySignature.has(key)) thoughtDurationsBySignature.delete(key);
	thoughtDurationsBySignature.set(key, durationMs);
	if (thoughtDurationsBySignature.size > THOUGHT_DURATION_REGISTRY_LIMIT) {
		const oldest = thoughtDurationsBySignature.keys().next().value;
		if (oldest !== undefined) thoughtDurationsBySignature.delete(oldest);
	}
}

/** Session theme for the thought summary label, cached per session by the
 *  session coordinator (never read during render). No theme → zero-trace. */
let sessionThoughtTheme: BoxTheme | undefined;

export function setThoughtLabelTheme(theme: BoxTheme | undefined): void {
	sessionThoughtTheme = theme;
}

/** Fold one observed pass into the timing state. Returns per-run durations:
 *  a live-streamed run carries its measured duration (also recorded in the
 *  content-signature registry), and a replacement component first observing a
 *  run already complete recovers the recorded duration from the registry —
 *  only truly unknown runs (new process / resume) stay `undefined`. */
function updateThoughtTiming(
	instance: object,
	runs: { count: number; complete: boolean[]; texts: string[] },
): (number | undefined)[] {
	let state = thoughtTimingByInstance.get(instance);
	if (!state) {
		state = { runs: new Map() };
		thoughtTimingByInstance.set(instance, state);
	}
	const now = Date.now();
	const durations: (number | undefined)[] = [];
	for (let index = 0; index < runs.count; index++) {
		const complete = runs.complete[index] === true;
		const key = thoughtDurationKey(index, runs.texts[index] ?? "");
		const entry = state.runs.get(index);
		if (!entry) {
			state.runs.set(index, { startedAt: now, endedAt: undefined, streamed: !complete });
			// First observation already complete (history rebuild / replacement
			// component): recover the recorded duration, if any.
			if (complete) durations[index] = thoughtDurationsBySignature.get(key);
			continue;
		}
		if (!complete) {
			entry.streamed = true;
			continue;
		}
		if (entry.endedAt === undefined) entry.endedAt = now;
		if (entry.streamed) {
			const duration = entry.endedAt - entry.startedAt;
			recordThoughtDuration(key, duration);
			durations[index] = duration;
		} else {
			// This instance never saw the run stream, but a predecessor may have.
			durations[index] = thoughtDurationsBySignature.get(key);
		}
	}
	return durations;
}

function thoughtLabelText(
	glyph: string,
	count: number,
	durationMs: number | undefined,
	stats: MergedSegmentStats | undefined = undefined,
	merged = false,
): string {
	if (merged) return mergedSummaryText(glyph, count, stats ?? { calls: 0, failed: 0 });
	const noun = count === 1 ? "thought" : "thoughts";
	const label = `${glyph} ${count} ${noun}`;
	return durationMs === undefined ? label : `${label} · ${formatElapsedMs(durationMs)}`;
}

function styleThoughtText(text: string): string {
	if (!sessionThoughtTheme) return text;
	const colored = sessionThoughtTheme.fg("thinkingText", text);
	return sessionThoughtTheme.italic ? sessionThoughtTheme.italic(colored) : colored;
}

/** Messages whose tool blocks flip together with a merged run-leader label
 *  (`◈ … · Called N tools`): clicking it opens the run's tool view too, not
 *  just the thinking. Plain thought labels keep their thinking-only contract. */
function mergedRunToolMessages(
	mergedSummary: boolean,
	group: ThoughtGroupPresentation | undefined,
): readonly object[] | undefined {
	if (!mergedSummary || group?.runTotalThoughts === undefined) return undefined;
	// Every interleaved run-progress label toggles the whole run; only labels
	// that actually carry tool stats open the tool view as well.
	return group.stats !== undefined || group.runStats !== undefined ? group.messages : undefined;
}

function thoughtToggleRegion(
	child: Component,
	instance: object,
	runIndex: number,
	toolMessages?: readonly object[],
	wholeRun = false,
): MouseRegion {
	return new MouseRegion(child, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (toolMessages === undefined) {
			return toggleThoughtGroup(instance, runIndex, wholeRun) ? { handled: true } : undefined;
		}
		// One desired state for both disclosures, not two independent toggles.
		// A leaf click/Ctrl+O may already have opened tools while thoughts remain
		// hidden; clicking the aggregate must then close everything together.
		const expand = !(isThoughtGroupExpanded(instance, runIndex, true) || turnsOpenForMessages(toolMessages));
		const thought = setThoughtGroupOpen(instance, runIndex, expand, true);
		const tools = toggleTurnsForMessages(toolMessages, expand);
		return thought || tools ? { handled: true } : undefined;
	});
}

/** Whether an (unwrapped) child is a Text-like component (the hidden label / error rows). */
function isTextComponent(child: unknown): boolean {
	return typeof (child as { setCustomBgFn?: unknown } | undefined)?.setCustomBgFn === "function";
}

/**
 * Collapse Pi's hidden-thinking placeholder row to zero trace, and — once an
 * agent run completes — surface one clickable aggregate (`◈ N thoughts · <time>`)
 * per contiguous thought segment (`messages.thoughtSummary`). Visible assistant
 * text splits segments; tool-only cycles remain grouped.
 *
 * Native `AssistantMessageComponent.updateContent` renders the thinking block as
 * `Text(theme.italic(theme.fg("thinkingText", label)), outputPad, 0)` plus a
 * trailing `Spacer(1)` — wrapped in a render-transparent `MouseRegion` since
 * Pi 0.85.0. An empty label is still wrapped in ANSI SGR codes, so
 * `Text.render` cannot treat it as empty (its check is `text.trim() === ""`,
 * and trim does not strip escape sequences) and emits one full-width invisible
 * line. That invisible row plus the surrounding spacers is the "gap" left when
 * the label is hidden. This wrapper runs the native layout, then:
 *
 * - a run still streaming (thinking is the trailing content and the message is
 *   not finalized) keeps the zero-trace collapse: the invisible label row and
 *   the spacer after it are dropped, leaving the same single top padding as a
 *   text-only message (the streaming block is the chat's trailing row);
 * - while the agent run is active, completed intermediate runs remain zero-trace;
 * - once the run ends, each segment leader keeps one row (merged mode: a
 *   cumulative run-progress line whose click toggles the whole run; plain
 *   mode: a thinking-only toggle for that segment);
 * - expanded segments get the same single aggregate header, while every member's
 *   content keeps the continuous quote rail.
 *
 * Runs first observed already complete by a NEW process (resume, restart) never
 * carried measured durations, so the aggregate omits time instead of fabricating
 * it. Same-process history/component rebuilds and extension reloads recover the
 * measurements from the process-scoped content-signature registry.
 */
export function decorateMessageUpdate(
	original: unknown,
	instance: object,
	args: unknown[],
	snapshot: MessageDecorationSnapshot = {
		assistantPrefix: "│ ",
		assistantEnabled: true,
		collapseHiddenThinking: false,
		mergedTurnSummary: false,
	},
): unknown {
	if (typeof original !== "function") return undefined;
	const result = Reflect.apply(original, instance, args);
	const target = instance as {
		hiddenThinkingLabel?: string;
		isStreaming?: boolean;
		outputPad?: number;
		contentContainer?: { children?: unknown[] };
	};
	const children = target.contentContainer?.children;
	if (children && !childrenUnchangedSinceScan(instance, children)) {
		// Only mutate runs while this certified patch owns Pi's blank hidden label.
		// `hideThinkingBlock` is merely the default visibility: Pi 0.85+ can expose
		// runs through per-run click overrides, and the global toggle can make every
		// run visible. Both expanded paths still need structural line accounting;
		// finalized groups additionally receive their aggregate header. Neither path
		// may be gated on the default visibility being `true`.
		if (snapshot.collapseHiddenThinking && target.hiddenThinkingLabel === "") {
			// `updateContent` stores the effective streaming flag on the instance
			// (explicit arg or its own default), so it is current after the native call.
			const runs = parseThinkingRuns(args[0], target.isStreaming !== false);
			const durations = updateThoughtTiming(instance, runs);
			const groups = observeThoughtMessage(instance, args[0], runs, durations);
			const summary = Boolean(snapshot.thoughtSummary) && sessionThoughtTheme !== undefined;
			const glyph = snapshot.thoughtGlyph ?? "◈";
			// Interleaved run merge (`messages.mergedTurnSummary`): every segment
			// leader renders its own line right before its segment's commentary,
			// carrying the CUMULATIVE run totals through that segment — progress
			// markers between the run's texts, the last one carrying the totals.
			const mergedSummary = snapshot.mergedTurnSummary === true;
			const labelValues = (group: {
				count: number;
				stats: MergedSegmentStats | undefined;
				runStats: MergedSegmentStats | undefined;
				runTotalThoughts: number | undefined;
			}) =>
				mergedSummary && group.runTotalThoughts !== undefined
					? { count: group.runTotalThoughts, stats: group.runStats, visible: true }
					: { count: group.count, stats: group.stats, visible: true };
			// Children are laid out in content order, thinking runs (hidden label or
			// expanded Markdown, each in a MouseRegion) in run order; walking backward
			// keeps splice/insert indices valid and assigns runs from the last.
			let runCursor = runs.count - 1;
			let expandedRunSeen = false;
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index];
				if (isSpacerChild(child)) continue;
				const region = unwrapMouseRegion(child) !== child ? (child as { child: unknown }) : undefined;
				const inner = region?.child;
				if (isBlankTextChild(child)) {
					// Hidden thinking-run label (MouseRegion-wrapped blank Text). Only
					// each segment's first run becomes its aggregate; non-leader
					// per-message/per-run labels stay zero-trace.
					const run = runCursor--;
					if (run < 0) continue;
					const group = groups[run];
					const values = group ? labelValues(group) : undefined;
					const aggregateVisible = summary && group?.ended === true && (values?.visible ?? true);
					if (aggregateVisible && group.leader) {
						const aggregateText = thoughtLabelText(
							glyph,
							values?.count ?? group.count,
							group.durationMs,
							values?.stats ?? group.stats,
							mergedSummary,
						);
						const textComponent = (inner ?? child) as Component & { setText?: (text: string) => void };
						textComponent.setText?.(styleThoughtText(aggregateText));
						if (region)
							children[index] = thoughtToggleRegion(
								textComponent,
								instance,
								run,
								mergedRunToolMessages(mergedSummary, group),
								mergedSummary,
							);
						continue;
					}
					children.splice(index, 1);
					// Drop the Spacer(1) the native layout appends after the thinking run when
					// another visible block follows; the message keeps only its shared top padding.
					if (isSpacerChild(children[index])) children.splice(index, 1);
				} else if (
					region &&
					inner !== undefined &&
					typeof (inner as { render?: unknown }).render === "function" &&
					!isTextComponent(inner)
				) {
					// Finalized segments use their aggregate click handler. Only each
					// segment leader receives a header.
					const run = runCursor--;
					expandedRunSeen = true;
					const group = groups[run];
					const values = group ? labelValues(group) : undefined;
					const aggregateVisible = summary && group?.ended === true && (values?.visible ?? true);
					if (aggregateVisible)
						children[index] = thoughtToggleRegion(
							inner as Component,
							instance,
							run,
							mergedRunToolMessages(mergedSummary, group),
							mergedSummary,
						);
					if (aggregateVisible && group.leader) {
						const aggregateText = thoughtLabelText(
							glyph,
							values?.count ?? group.count,
							group.durationMs,
							values?.stats ?? group.stats,
							mergedSummary,
						);
						const marker = new Text(
							styleThoughtText(aggregateText),
							typeof target.outputPad === "number" ? target.outputPad : 1,
							0,
						);
						children.splice(
							index,
							0,
							thoughtToggleRegion(marker, instance, run, mergedRunToolMessages(mergedSummary, group), mergedSummary),
						);
					}
				}
			}
			// When expanded thinking leads the message, the role prefix must land on
			// the answer's first line (not the thinking content). Record the region
			// even for nonleaders, which intentionally have no aggregate header but
			// still need a continuous quote rail.
			if (expandedRunSeen) {
				const leading: object[] = [];
				for (const rawChild of children) {
					const child = rawChild as object;
					if (isSpacerChild(child)) {
						leading.push(child);
						continue;
					}
					const region = unwrapMouseRegion(child) !== child ? (child as { child?: unknown }) : undefined;
					const inner = region?.child;
					if (
						region &&
						inner !== undefined &&
						typeof (inner as { render?: unknown }).render === "function" &&
						!isTextComponent(inner)
					) {
						// Expanded thinking content (MouseRegion-wrapped Markdown).
						leading.push(child);
						continue;
					}
					if (region && isTextComponent(inner)) {
						// Collapsed label row (MouseRegion-wrapped Text).
						leading.push(child);
						continue;
					}
					if (!region && isTextComponent(child)) {
						// Pre-MouseRegion header/label compatibility.
						leading.push(child);
						continue;
					}
					break; // First answer Markdown (or anything unexpected) ends the region.
				}
				thoughtLeadingSkipByInstance.set(instance, { children: leading });
			} else {
				thoughtLeadingSkipByInstance.delete(instance);
			}
			// Zero-line collapse for fully hidden messages. When every content
			// block of a FINALIZED message is hidden — thinking runs collapsed,
			// no assistant text, no error/truncation rows, no aggregate label
			// kept — the message's native top Spacer(1) is the only child left:
			// one blank line per tool-cycle message that stacks into the large
			// blank gaps between the run's summary rows (models that think before
			// every tool batch produce dozens per turn). Tool blocks carry their
			// own leading spacer, so removing the pad never glues neighbors; the
			// streaming message keeps its pad (it is the chat's trailing block).
			if (target.isStreaming !== true && !children.some((child) => !isSpacerChild(child))) {
				children.splice(0, children.length);
			}
		}
		markChildrenScanned(instance, children);
	}
	return result;
}

// Special private layouts are intentionally not installed; their prototypes remain native.
