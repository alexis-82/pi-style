// Boxed grep/search tool renderer.
//
// grep renders a **boxless tree panel**: a summary header
// (`Grep: <pattern> <N> matches · <M> files · in <path>`) followed by one row
// per matching file (`├─ file`) — match content is never rendered; expansion
// (header click or Ctrl+O) only lifts the file-list head limit. Like the quiet-tool batch panel, the whole panel lives in the call
// component and reads a live registry on every render, so the result's match
// data is picked up without cross-component invalidation. grep does not batch
// (each call owns its own panel).
//
// Lifecycle: panels are keyed by toolCallId and cleared on session reset and new
// message boundaries (see resetGrepRegistry wiring in session-coordinator.ts and
// pi/index.ts), mirroring the batch registry.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import { type BoxTheme, dimLine, getTextOutput, shortenPath } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import {
	type GrepMatch,
	groupMatchesByFile,
	parseGrepOutput,
	pluralForm,
	renderGrepFilesTree,
	TREE_INDENT,
} from "./output-tree.js";
import { compactToolPath } from "./path.js";
import { type BoxedToolDefinition, noteExecutionStart } from "./shared.js";

const GREP_FILE_HEAD_LIMIT = 6;
const GREP_ERROR_LINES = 2;

interface GrepPanelState {
	pattern: string;
	pathLabel: string;
	/** `undefined` until the result arrives; an empty array means zero matches. */
	matches: GrepMatch[] | undefined;
	isError: boolean;
	errorText: string | undefined;
	isPartial: boolean;
	/** User click-open: the header row was clicked, so the file list renders
	 *  uncut (same view Ctrl+O expansion gives every other tool). */
	open: boolean;
}

const grepPanels = new Map<string, GrepPanelState>();

/** Reset all grep panel state (session start/shutdown). */
export function resetGrepRegistry(): void {
	grepPanels.clear();
}

function pathLabel(rawPath: string): string {
	const displayPath = String(rawPath ?? ".");
	return displayPath === "." || displayPath === "" ? "current directory" : compactToolPath(shortenPath(displayPath));
}

function registerGrepCall(toolCallId: string, pattern: string, label: string): void {
	const existing = grepPanels.get(toolCallId);
	if (existing) {
		existing.pattern = pattern;
		existing.pathLabel = label;
		return;
	}
	grepPanels.set(toolCallId, {
		pattern,
		pathLabel: label,
		matches: undefined,
		isError: false,
		errorText: undefined,
		isPartial: true,
		open: false,
	});
}

function registerGrepResult(
	toolCallId: string,
	data: { matches: GrepMatch[]; isError: boolean; errorText: string | undefined; isPartial: boolean },
): void {
	const state = grepPanels.get(toolCallId);
	if (!state) return;
	state.matches = data.matches;
	state.isError = data.isError;
	state.errorText = data.errorText;
	state.isPartial = data.isPartial;
}

function bold(theme: BoxTheme, text: string): string {
	return typeof theme?.bold === "function" ? theme.bold(text) : text;
}

/** `Grep: <pattern> <N> matches · <M> files · in <path>` (done) /
 *  `Grep: <pattern> · in <path>` (pending). */
function formatGrepHeader(theme: BoxTheme, state: GrepPanelState): string {
	const label = bold(theme, "Grep:");
	const patternPart = state.pattern ? ` ${theme.fg("text", state.pattern)}` : "";
	const pathPart = state.pathLabel ? theme.fg("dim", ` · in ${state.pathLabel}`) : "";
	if (state.isError) {
		return `${theme.fg("error", bold(theme, "✗ Grep:"))}${state.pattern ? ` ${theme.fg("error", state.pattern)}` : ""}${pathPart}`;
	}
	if (state.matches === undefined) {
		return `${label}${patternPart}${pathPart}`;
	}
	const matchCount = state.matches.length;
	const fileCount = groupMatchesByFile(state.matches).length;
	const matchesPart = theme.fg("accent", `${matchCount} ${pluralForm("match", matchCount)}`);
	const filesPart = theme.fg("dim", ` · ${fileCount} ${pluralForm("file", fileCount)}`);
	return `${label}${patternPart} ${matchesPart}${filesPart}${pathPart}`;
}

function renderErrorLines(theme: BoxTheme, errorText: string, width: number): string[] {
	const raw = stripAnsi(errorText)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (raw.length === 0) return [];
	const prefix = `${TREE_INDENT}${dimLine("└─")} `;
	const out = raw
		.slice(0, GREP_ERROR_LINES)
		.map((line) => safeTruncateToWidth(`${prefix}${theme.fg("error", line)}`, Math.max(1, width), "…"));
	if (raw.length > GREP_ERROR_LINES)
		out.push(safeTruncateToWidth(`${prefix}${theme.fg("error", "…")}`, Math.max(1, width), "…"));
	return out;
}

function renderGrepPanelLines(theme: BoxTheme, state: GrepPanelState, width: number, expanded: boolean): string[] {
	const safeWidth = Math.max(1, width);
	const header = safeTruncateToWidth(formatGrepHeader(theme, state), safeWidth, "…");
	if (state.isError) {
		return [header, ...(state.errorText ? renderErrorLines(theme, state.errorText, width) : [])];
	}
	if (state.matches === undefined) return [header];
	// Files-only tree, always — match content is never rendered. Header click
	// (state.open) or Pi's global Ctrl+O expansion (the same contract
	// read/ls/find/bash honor) lifts the file-list head limit instead.
	return renderGrepFilesTree(theme, header, state.matches, safeWidth, {
		headLimit: state.open || expanded ? Number.POSITIVE_INFINITY : GREP_FILE_HEAD_LIMIT,
	});
}

/** Live panel component reading the registry on every render pass. The state
 *  reference is captured at creation (like the batch panel): a registry clear
 *  on session reset/resume must not blank already-rendered panels — the result
 *  renderer mutates this same object, so live updates still flow. Clicking the
 *  header row toggles the uncut file list; the handler consumes the click
 *  before Pi's native per-box toggle (which would re-render this panel with the
 *  global expanded flag — the same view, so both paths agree anyway). */
function renderGrepPanel(theme: BoxTheme, toolCallId: string, expanded: boolean): Component {
	const state = grepPanels.get(toolCallId);
	return {
		invalidate() {},
		render(width: number): string[] {
			if (!state) return [safeTruncateToWidth(bold(theme, "Grep:"), Math.max(1, width), "…")];
			return renderGrepPanelLines(theme, state, width, expanded);
		},
		handleMouse(event) {
			if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
			if (!state || state.matches === undefined || state.isError) return undefined;
			state.open = !state.open;
			return { handled: true };
		},
	};
}

/** Empty result component — the panel lives in the call component, which
 *  re-renders when the result arrives (Pi re-renders the tool execution
 *  component on tool_execution_end), picking up the stored matches. */
const EMPTY_GREP_RESULT: Component = {
	invalidate() {},
	render() {
		return [];
	},
};

export const grepTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const pattern = String(args?.pattern ?? "");
		registerGrepCall(context.toolCallId, pattern, pathLabel(String(args?.path ?? ".")));
		return renderGrepPanel(theme, context.toolCallId, Boolean(context.expanded));
	},
	result(result, options, _theme, context) {
		const isError = Boolean(context.isError);
		const isPartial = Boolean(options.isPartial);
		// Result renderers re-fire on every repaint/scroll; once final matches
		// are registered the registry is already final — skip stripping/parsing.
		const state = grepPanels.get(context.toolCallId);
		if (!isPartial && !isError && state !== undefined && state.matches !== undefined && !state.isPartial) {
			return EMPTY_GREP_RESULT;
		}
		const output = stripAnsi(getTextOutput(result)).trimEnd();
		const matches = isError ? [] : parseGrepOutput(output);
		registerGrepResult(context.toolCallId, {
			matches,
			isError,
			errorText: isError ? output || undefined : undefined,
			isPartial,
		});
		return EMPTY_GREP_RESULT;
	},
};
