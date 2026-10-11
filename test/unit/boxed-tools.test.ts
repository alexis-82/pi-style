import { resolve } from "node:path";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	initTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSpecialBlockTheme } from "../../extension-src/pi-style/features/messages/special-blocks.js";
import { EMPTY_BATCH_COMPONENT } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import {
	renderBoxedToolCall as dispatchCall,
	renderBoxedToolResult as dispatchResult,
} from "../../extension-src/pi-style/features/tools/boxed/index.js";
import {
	getStateElapsedMs,
	recordExecutionEnded,
	recordExecutionStarted,
	setToolsRenderConfig,
	stopAllElapsedTickers,
} from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import {
	beginAgentRun,
	finishAgentRun,
	registerTurnFromMessage,
	resetTurnRegistry,
} from "../../extension-src/pi-style/features/tools/boxed/turn-summary.js";
import { createToolDecorationOwner } from "../../extension-src/pi-style/features/tools/index.js";
import {
	type CompatibilityProbeReport,
	disposePiCompatibilityProbe,
	probePiCompatibility,
} from "../../extension-src/pi-style/pi/compatibility-probe.js";
import { stripAnsi, visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";
import {
	boxBorder,
	boxInnerWidth,
	boxLine,
	boxLineWithRight,
	boxWidth,
	formatBoxedFooterFromValues,
	formatToolName,
	renderBoxedToolCall,
	renderBoxedToolResult,
} from "../../extension-src/pi-style/shared/box.js";
import {
	annotateToolResultMetrics,
	formatElapsedMs,
	formatOutputChars,
	formatToolMetricsFromValues,
} from "../../extension-src/pi-style/shared/elapsed.js";
import {
	boxedResultRenderBudget,
	clampRenderLine,
	safeTruncateToWidth,
	safeVisibleWidth,
	safeWrapTextWithAnsi,
	truncateAtCodePointBoundary,
} from "../../extension-src/pi-style/shared/render-budget.js";
import { resetThemeExtrasCache } from "../../extension-src/pi-style/shared/theme-extras.js";
import { createFakeTheme } from "../helpers/fake-theme.js";

const theme = createFakeTheme();
const widths = [0, 1, 12, 20, 40, 60, 80, 120, 160];

function toolCall(id: string, name = "read"): { type: "toolCall"; id: string; name: string; arguments: object } {
	return { type: "toolCall", id, name, arguments: {} };
}

function result(id: string, isError = false): { toolCallId: string; isError: boolean } {
	return { toolCallId: id, isError };
}

function message(calls: readonly ReturnType<typeof toolCall>[]) {
	return { role: "assistant", content: calls };
}

function context(overrides: Partial<BoxedToolContext> = {}): BoxedToolContext {
	return {
		args: {},
		toolCallId: "fixture-call",
		invalidate: () => {},
		state: {},
		cwd: "/fake",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		lastComponent: undefined,
		...overrides,
	};
}

function assertFit(lines: readonly string[], width: number): void {
	for (const line of lines) {
		expect(visibleWidth(line), `line must fit ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
	}
}

afterEach(() => {
	setSpecialBlockTheme(undefined);
	resetThemeExtrasCache();
	if (activeReport) {
		disposePiCompatibilityProbe(activeReport);
		activeReport = undefined;
	}
});

beforeEach(() => {
	initTheme("dark", false);
});

let activeReport: CompatibilityProbeReport | undefined;

/** Install the certified boxed adapters for the special message blocks. */
function installSpecialBlockAdapters(): void {
	activeReport = probePiCompatibility("0.83.0");
}

describe("box primitives", () => {
	it("sizes boxes and builds width-safe lines at every width", () => {
		for (const width of widths) {
			expect(boxWidth(width)).toBeGreaterThanOrEqual(12);
			expect(boxInnerWidth(width)).toBeGreaterThanOrEqual(1);
			const line = boxLine(theme, "a very long content string that must truncate cleanly", width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(12, width));
			const bordered = boxBorder(theme, "╭", "╮", width);
			assertFit([bordered], Math.max(12, width));
			const right = boxLineWithRight(theme, "left content", "right", width);
			assertFit([right], Math.max(12, width));
		}
	});

	it("formats tool names and footer metrics", () => {
		expect(formatToolName("quick_edit")).toBe("Quick Edit");
		expect(formatToolName("substitute-edit")).toBe("Substitute Edit");
		expect(formatToolName("target_edit")).toBe("Target Edit");
		expect(formatToolName("read")).toBe("Read");
		expect(formatElapsedMs(500)).toBe("500ms");
		expect(formatElapsedMs(2500)).toBe("2.5s");
		expect(formatElapsedMs(12000)).toBe("12s");
		expect(formatOutputChars(950)).toBe("950 chars");
		expect(formatOutputChars(2400)).toBe("2.4k chars");
		expect(formatToolMetricsFromValues(2500, 2400)).toBe("2.5s · 2.4k chars");
		const footer = formatBoxedFooterFromValues(theme, 1500, "some output text");
		expect(footer).toContain("1.50s");
		expect(footer).toContain("words");
		expect(footer).not.toContain("◷");
	});

	it("annotates metrics into result details only when absent", () => {
		const result: { content: unknown[]; details: Record<string, unknown> } = {
			content: [{ type: "text", text: "hello" }],
			details: {},
		};
		annotateToolResultMetrics(result, 123);
		expect(result.details.__elapsedMs).toBe(123);
		expect(result.details.__outputChars).toBe(5);
		annotateToolResultMetrics(result, 999);
		expect(result.details.__elapsedMs).toBe(123);
	});
});

describe("render budget", () => {
	it("measures widths and truncates ANSI strings safely", () => {
		const colored = theme.fg("toolOutput", "hello");
		expect(safeVisibleWidth(colored)).toBe(5);
		const truncated = safeTruncateToWidth(colored, 3, "…");
		expect(safeVisibleWidth(truncated)).toBe(3);
		expect(safeTruncateToWidth("abc", 0)).toBe("");
		const wrapped = safeWrapTextWithAnsi("one two three four", 7);
		expect(wrapped.every((line) => safeVisibleWidth(line) <= 7)).toBe(true);
	});

	it("clamps long lines without splitting surrogate pairs", () => {
		// Emoji (U+1F600) is a surrogate pair; a plain slice at an odd boundary
		// would produce a lone surrogate that renders as �.
		const emoji = "😀";
		const line = `${"a".repeat(1999)}${emoji}tail`;
		const clamped = clampRenderLine(line, 2000);
		expect(clamped).not.toContain("\uFFFD");
		expect(clamped).toContain("(truncated)");
		expect(clamped.length).toBeLessThanOrEqual(2000 + "… (truncated)".length);
		const cut = truncateAtCodePointBoundary(`${"x".repeat(2000)}${emoji}`, 2000);
		expect(cut).not.toContain("\uFFFD");
	});

	it("computes bounded head/tail budgets", () => {
		const budget = boxedResultRenderBudget(10);
		expect(budget.headLines).toBeGreaterThanOrEqual(1);
		expect(budget.tailLines).toBeGreaterThanOrEqual(1);
		expect(budget.maxRenderedLines).toBeGreaterThanOrEqual(budget.headLines + budget.tailLines);
	});
});

describe("boxed tool renderers", () => {
	beforeEach(() => {
		setToolsRenderConfig({ maxCollapsedLines: 10, maxExpandedLines: 50, dimOutput: false, showElapsed: true });
	});

	it("renders a read call as a boxless inline line", () => {
		const ctx = context({ args: { path: "/fake/src/index.ts" } });
		const call = dispatchCall("read", { path: "/fake/src/index.ts" }, theme, ctx);
		for (const width of [40, 80, 120]) {
			const lines = call.render(width);
			expect(lines[0]).toContain("➔ Read");
			expect(lines[0]).toContain("index.ts");
			expect(lines[0]).not.toContain("(1)");
			expect(lines.join("\n")).not.toContain("╭");
			assertFit(lines, Math.max(12, width));
		}
		const result = dispatchResult(
			"read",
			{ content: [{ type: "text", text: "hello" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		// The batch panel lives in the call component; the result adds nothing.
		expect(result.render(80)).toEqual([]);
		const refreshedCall = dispatchCall("read", { path: "/fake/src/index.ts" }, theme, ctx).render(80);
		expect(refreshedCall.join("\n")).toContain("index.ts");
		assertFit(refreshedCall, 80);
	});

	it("renders an expanded bash result with output tail and truncation hint", () => {
		const output = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
		const ctx = context({ args: { command: "printf 'x'", timeout: 30 } });
		const call = dispatchCall("bash", { command: "printf 'x'", timeout: 30 }, theme, ctx);
		const callLines = call.render(80);
		expect(callLines.join("\n")).toContain("Bash");
		assertFit(callLines, 80);
		const result = dispatchResult(
			"bash",
			{ content: [{ type: "text", text: output }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const lines = result.render(80);
		expect(lines.join("\n")).toContain("line-39");
		expect(lines.join("\n")).toContain("Ctrl+O for more");
		assertFit(lines, 80);
	});

	it("renders an expanded edit result with an adaptive diff and stats", () => {
		const diff = "- 1 old line\n+ 1 new line";
		const ctx = context({ args: { path: "/fake/src/a.ts" } });
		const result = dispatchResult(
			"edit",
			{ content: [], details: { diff, path: "/fake/src/a.ts" } },
			{ expanded: true, isPartial: false },
			theme,
			ctx,
		);
		const lines = result.render(120);
		// Short corresponding change at a wide width: split side-by-side layout.
		// Stats live in the box header (`Edit ✓ · path · +N -M`) — the result
		// body carries no `Diff` divider, and the footer does not repeat them.
		const header = stripAnsi(dispatchCall("edit", ctx.args, theme, ctx).render(120)[0]);
		expect(header).toContain("Edit ✓ · src/a.ts · +1 -1");
		expect(stripAnsi(lines.join("\n"))).not.toContain("Diff · ");
		expect(stripAnsi(lines.join("\n"))).not.toContain("file"); // a single file is implied
		expect(stripAnsi(lines.join("\n"))).toContain("old"); // split column header
		assertFit(lines, 120);
	});

	it("renders additions-only edit diffs as unified and collapses unchanged context", () => {
		const diff = [
			" 1 # Changelog",
			" 2",
			" 3 ## 0.1.0 - Unreleased",
			" 4",
			"+ 5 - **Fixed: boxed tool/message surfaces now survive session switches",
			"+ 6 - **Fixed: single-line replies keep their `|` prefix**",
			" 7",
			" 8 - Added the boxed **tool presentation**",
			" 9",
			" 10",
			" 11",
			" 12",
			" 13",
			" 14",
			" 15",
			" 16",
		].join("\n");
		const ctx = context({ args: { path: "/fake/CHANGELOG.md" } });
		const result = dispatchResult(
			"edit",
			{ content: [], details: { diff, path: "/fake/CHANGELOG.md" } },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const lines = result.render(120);
		const text = stripAnsi(lines.join("\n"));
		// Additions-only: unified layout, stats in the box header, no progress meter.
		const header = stripAnsi(dispatchCall("edit", ctx.args, theme, ctx).render(120)[0]);
		expect(header).toContain("CHANGELOG.md · +2 -0");
		expect(text).not.toContain("Diff · ");
		expect(text).not.toContain("file"); // a single file is implied
		expect(text).not.toContain("━━");
		// Long trailing context is collapsed into a single row.
		expect(text).toContain("⋯ 8 unchanged lines hidden");
		expect(text).toContain("- **Fixed: boxed tool/message surfaces");
		assertFit(lines, 120);
	});

	it("forces unified diff on narrow terminals even for paired changes", () => {
		const diff = "- 14 const timeout = 300;\n+ 14 const timeout = 60;";
		const ctx = context({ args: { path: "/fake/src/config.ts" } });
		for (const width of [40, 80]) {
			const lines = dispatchResult(
				"edit",
				{ content: [], details: { diff, path: "/fake/src/config.ts" } },
				{ expanded: false, isPartial: false },
				theme,
				ctx,
			).render(width);
			const text = stripAnsi(lines.join("\n"));
			expect(text).toContain("const timeout = 300;");
			expect(text).toContain("const timeout = 60;");
			assertFit(lines, Math.max(12, width));
		}
		// The header still carries the stats (resolved lazily from shared state).
		expect(stripAnsi(dispatchCall("edit", ctx.args, theme, ctx).render(80)[0])).toContain("+1 -1");
	});

	it("picks diff stats up in the call header on the same paint", () => {
		// Pi's updateDisplay rebuilds the call component on every pass — the pass
		// that delivers the result builds a fresh call component AFTER the result
		// renderer will have stored the stats (result renderers run later in the
		// same pass), and its headerDetail resolves lazily at render time.
		const ctx = context({ args: { path: "/fake/src/a.ts" } });
		expect(stripAnsi(dispatchCall("edit", ctx.args, theme, ctx).render(80)[0])).not.toContain("+1 -0");
		dispatchResult(
			"edit",
			{ content: [], details: { diff: "+ 1 added", path: "/fake/src/a.ts" } },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		// The re-dispatched call (the settled updateDisplay pass) shows the stats.
		expect(stripAnsi(dispatchCall("edit", ctx.args, theme, ctx).render(80)[0])).toContain("Edit ✓ · src/a.ts · +1 -0");
	});

	it("shows a Ctrl+O omission hint when a huge diff exceeds the row budget", () => {
		const pairs = Array.from({ length: 45 }, (_, i) => `- ${i + 1} line ${i + 1}\n+ ${i + 1} line ${i + 1} EDITED`);
		const diff = pairs.join("\n");
		const ctx = context({ args: { path: "/fake/huge.txt" } });
		const lines = dispatchResult(
			"edit",
			{ content: [], details: { diff, path: "/fake/huge.txt" } },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(120);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("lines omitted · Ctrl+O to show full diff");
		expect(text).toContain("Ctrl+O more"); // divider-right expand hint
		expect(text).not.toContain("rendered output truncated");
		assertFit(lines, 120);
	});

	it("puts the edit path in the header instead of a body line", () => {
		const ctx = context({ args: { path: "/fake/src/a.ts" } });
		const lines = dispatchCall("edit", { path: "/fake/src/a.ts" }, theme, ctx).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("Edit ✓ · src/a.ts");
		expect(text).not.toContain("Path:");
		assertFit(lines, 80);
	});

	it("renders a quick-edit call with its label", () => {
		const ctx = context({ args: { path: "/fake/src/b.ts" } });
		const lines = dispatchCall("quick_edit", { path: "/fake/src/b.ts" }, theme, ctx).render(80);
		expect(lines.join("\n")).toContain("Quick Edit");
		assertFit(lines, 80);
	});

	it("renders a write call as a numbered content preview box", () => {
		// The renderer state is shared across updateDisplay passes (like Pi's
		// ToolExecutionComponent): the result renderer stores the metrics footer
		// into it, and the re-invoked call renderer closes the box with it.
		const state: Record<string, unknown> = {};
		const args = { path: "/tmp/pi-write-test.md", content: "a\nb\nc\n" };

		// Pending (args streaming / execution started, no result yet): the running
		// card shows `Write ◌` and a `◌ Running` footer, not a ✓.
		const pending = dispatchCall("write", args, theme, context({ args, state, isPartial: true })).render(80);
		const pendingText = stripAnsi(pending.join("\n"));
		expect(pendingText).toContain("Write ◌ · Path: ../tmp/pi-write-test.md");
		expect(pendingText).toContain("1 a");
		expect(pendingText).toContain("2 b");
		expect(pendingText).toContain("3 c");
		expect(pendingText).toContain("4 "); // trailing empty line from the final newline
		expect(pendingText).toContain("◌ Running");
		expect(pendingText).not.toContain("Waiting for output");
		expect(pendingText).not.toContain("✓");
		assertFit(pending, 80);

		// Settled: the result stores the footer into the shared state; the call
		// re-renders with the footer in the bottom border (elapsed · words).
		dispatchResult(
			"write",
			{ content: [{ type: "text", text: "Successfully wrote 6 bytes to /tmp/pi-write-test.md" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			context({ args, state }),
		);
		const settled = dispatchCall("write", args, theme, context({ args, state })).render(80);
		const settledText = stripAnsi(settled.join("\n"));
		expect(settledText).toContain("1 a");
		expect(settledText).toContain("4 ");
		expect(settledText).toMatch(/\d+\.\d\ds · ~\d+ words/);
		expect(settledText).not.toContain("Waiting for output");
		assertFit(settled, 80);
	});

	it("shows a Ctrl+O for more hint when the write preview is truncated", () => {
		const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
		const ctx = context({ args: { path: "/tmp/big.md", content } });
		const call = dispatchCall("write", ctx.args, theme, ctx);
		dispatchResult(
			"write",
			{ content: [{ type: "text", text: "Successfully wrote 100 bytes to /tmp/big.md" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const lines = call.render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("10 line 10");
		expect(text).not.toContain("11 line 11");
		expect(text).toContain("… 2 more lines");
		expect(text).toContain("Ctrl+O for more");
		assertFit(lines, 80);
	});

	it("expands the write preview to the expanded line budget", () => {
		const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
		const ctx = context({ args: { path: "/tmp/big.md", content }, expanded: true });
		const call = dispatchCall("write", ctx.args, theme, ctx);
		dispatchResult(
			"write",
			{ content: [{ type: "text", text: "Successfully wrote 100 bytes to /tmp/big.md" }], details: {} },
			{ expanded: true, isPartial: false },
			theme,
			ctx,
		);
		const lines = call.render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("12 line 12");
		expect(text).not.toContain("Ctrl+O for more");
		expect(text).not.toContain("more lines");
		assertFit(lines, 80);
	});

	it("keeps a blank body for empty write content", () => {
		const ctx = context({ args: { path: "/tmp/empty.md", content: "" } });
		const lines = dispatchCall("write", ctx.args, theme, ctx).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).not.toMatch(/^\s*\d+ /m); // no numbered rows
		assertFit(lines, 80);
	});

	it("renders write errors in the boxed error result without a preview body", () => {
		const ctx = context({ args: { path: "/tmp/x.md", content: "a" }, isError: true });
		const call = dispatchCall("write", ctx.args, theme, ctx).render(80);
		expect(stripAnsi(call.join("\n"))).toContain("Write ✗");
		expect(stripAnsi(call.join("\n"))).not.toContain("1 a");
		assertFit(call, 80);
		const result = dispatchResult(
			"write",
			{ content: [{ type: "text", text: "EACCES: permission denied" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(80);
		expect(stripAnsi(result.join("\n"))).toContain("EACCES: permission denied");
		assertFit(result, 80);
	});

	it.each(["TaskCreate", "TaskUpdate", "TaskList", "TaskDelete", "custom_tool_xyz", "run_tests", "submit_patch"])(
		"boxes every non-registered tool through the generic fallback: %s",
		(toolName) => {
			const ctx = context({ args: { key: "value" } });
			const call = dispatchCall(toolName, { key: "value" }, theme, ctx).render(80);
			expect(call.join("\n")).toContain("╭");
			expect(call.join("\n")).toContain("➔");
			assertFit(call, 80);
			const result = dispatchResult(
				toolName,
				{ content: [{ type: "text", text: "generic output" }], details: {} },
				{ expanded: false, isPartial: false },
				theme,
				ctx,
			).render(80);
			expect(result.join("\n")).toContain("generic output");
			assertFit(result, 80);
		},
	);

	it("falls back to a boxed generic renderer for unknown tools", () => {
		const ctx = context({ args: { value: "x" } });
		const call = dispatchCall("some_custom_tool", { value: "x" }, theme, ctx).render(80);
		expect(call.join("\n")).toContain("Some Custom Tool");
		assertFit(call, 80);
		const result = dispatchResult(
			"some_custom_tool",
			{ content: [{ type: "text", text: "custom output line" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(80);
		expect(result.join("\n")).toContain("custom output line");
		assertFit(result, 80);
	});

	it("keeps every renderer width-safe from narrow to wide", () => {
		for (const width of widths) {
			if (width === 0) continue;
			const ctx = context({ args: { path: "/fake/src/index.ts", command: "npm test" } });
			for (const [name, args] of [
				["read", { path: "/fake/src/index.ts" }],
				["write", { path: "/fake/src/out.ts", content: "x" }],
				["edit", { path: "/fake/src/edit.ts" }],
				["ls", { path: "/fake" }],
				["find", { pattern: "*.ts", path: "/fake" }],
				["grep", { pattern: "test", path: "/fake" }],
				["bash", { command: "echo hi", timeout: 30 }],
				["unknown", { anything: "x" }],
			] as const) {
				const callLines = dispatchCall(name, args as Record<string, unknown>, theme, ctx).render(width);
				assertFit(callLines, Math.max(12, width));
				const resultLines = dispatchResult(
					name,
					{ content: [{ type: "text", text: "some output" }], details: {} },
					{ expanded: true, isPartial: false },
					theme,
					ctx,
				).render(width);
				assertFit(resultLines, Math.max(12, width));
			}
		}
	});
});

describe("bash execution states", () => {
	function textResult(text: string): { content: { type: string; text: string }[]; details: Record<string, never> } {
		return { content: [{ type: "text", text }], details: {} };
	}

	afterEach(() => {
		stopAllElapsedTickers();
		vi.useRealTimers();
	});

	it("renders a queued bash call as a closed waiting card without a status glyph", () => {
		const ctx = context({
			toolCallId: "b-queued",
			args: { command: "echo hi", timeout: 30 },
			executionStarted: false,
			isPartial: true,
		});
		const text = stripAnsi(dispatchCall("bash", { command: "echo hi", timeout: 30 }, theme, ctx).render(80).join("\n"));
		expect(text).toContain("➔ Bash");
		expect(text).not.toContain("✓");
		expect(text).not.toContain("◌");
		expect(text).toContain("Waiting for output");
		expect(text).not.toContain("No output received yet");
		expect(text).not.toContain("Response");
	});

	it("renders a running bash call as a single card with elapsed and no Response frame", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-running",
			args: { command: "cd src && npm test", timeout: 300 },
			state,
			isPartial: true,
		});
		recordExecutionStarted(state, true);
		const lines = dispatchCall("bash", { command: "cd src && npm test", timeout: 300 }, theme, ctx).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("Bash ◌");
		expect(text).toContain("$ cd src && npm test");
		expect(text).toContain("No output received yet");
		expect(text).toContain("◌ Running");
		expect(text).not.toContain("Response");
		expect(text).not.toContain("✓");
		expect(text).not.toContain("∅");
		assertFit(lines, 80);
	});

	it("renders nothing for the first partial result so the running card stands alone", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-first-partial",
			args: { command: "echo hi", timeout: 30 },
			state,
			isPartial: true,
		});
		dispatchCall("bash", { command: "echo hi", timeout: 30 }, theme, ctx);
		const first = dispatchResult("bash", textResult("line1"), { expanded: false, isPartial: true }, theme, ctx);
		expect(first.render(80)).toEqual([]);
	});

	it("streams later partial output into the open card with an Output divider, no Response", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-stream",
			args: { command: "echo hi", timeout: 30 },
			state,
			isPartial: true,
		});
		dispatchCall("bash", { command: "echo hi", timeout: 30 }, theme, ctx);
		dispatchResult("bash", textResult(""), { expanded: false, isPartial: true }, theme, ctx); // first partial: empty
		const lines = dispatchResult(
			"bash",
			textResult("line1\nline2"),
			{ expanded: false, isPartial: true },
			theme,
			ctx,
		).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("line2");
		expect(text).toContain("Output");
		expect(text).toContain("◌ Running");
		expect(text).not.toContain("Response");
		expect(text).not.toContain("No output received yet");
		assertFit(lines, 80);
	});

	it("keeps saying No output received yet while an empty stream runs", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-stream-empty",
			args: { command: "sleep 5", timeout: 30 },
			state,
			isPartial: true,
		});
		dispatchCall("bash", { command: "sleep 5", timeout: 30 }, theme, ctx);
		dispatchResult("bash", textResult(""), { expanded: false, isPartial: true }, theme, ctx);
		const lines = dispatchResult("bash", textResult(""), { expanded: false, isPartial: true }, theme, ctx).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("No output received yet");
		expect(text).toContain("◌ Running");
		expect(text).not.toContain("├"); // no divider while there is nothing to show
		expect(text).not.toContain("Response");
		expect(text).not.toContain("∅");
		assertFit(lines, 80);
	});

	it("hints that a silent interactive command may be waiting for terminal input", () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const state: Record<string, unknown> = {};
		recordExecutionStarted(state, true);
		vi.advanceTimersByTime(1500);
		const ctx = context({
			toolCallId: "b-interactive",
			args: { command: "pi", timeout: 300 },
			state,
			isPartial: true,
		});
		dispatchCall("bash", { command: "pi", timeout: 300 }, theme, ctx);
		dispatchResult("bash", textResult(""), { expanded: false, isPartial: true }, theme, ctx);
		const lines = dispatchResult("bash", textResult(""), { expanded: false, isPartial: true }, theme, ctx).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("The process may be waiting for terminal input");
		assertFit(lines, 80);
	});

	it("renders a settled empty result with Exit 0 and a state-specific empty text", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-empty-done",
			args: { command: "true", timeout: 30 },
			state,
		});
		recordExecutionStarted(state, true);
		const lines = dispatchResult("bash", textResult(""), { expanded: false, isPartial: false }, theme, ctx).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("Response");
		expect(text).toContain("Exit 0");
		expect(text).toContain("Command completed without producing output");
		expect(text).not.toContain("∅");
		assertFit(lines, 80);
	});

	it("shows the parsed exit code in the footer instead of the status suffix", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-exit2",
			args: { command: "false", timeout: 30 },
			state,
			isError: true,
		});
		recordExecutionStarted(state, true);
		const lines = dispatchResult(
			"bash",
			textResult("boom\n\nCommand exited with code 2"),
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("✗ Error");
		expect(text).toContain("Exit 2");
		expect(text).toContain("boom");
		expect(text).not.toContain("Command exited with code"); // status parsed into the footer
		assertFit(lines, 80);
	});

	it("renders a timed-out result with a dedicated label and termination footer", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-timeout",
			args: { command: "sleep 400", timeout: 300 },
			state,
			isError: true,
		});
		recordExecutionStarted(state, true);
		const lines = dispatchResult(
			"bash",
			textResult("Command timed out after 300 seconds"),
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("✗ Timed out");
		expect(text).toContain("Terminated after 300.0s");
		expect(text).toContain("No output was received before the timeout");
		expect(text).not.toContain("∅");
		expect(text).not.toContain("Command timed out after"); // status parsed into the footer
		assertFit(lines, 80);
	});

	it("renders a cancelled result with partial output preserved", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-cancelled",
			args: { command: "tail -f /dev/null", timeout: 30 },
			state,
			isError: true,
		});
		recordExecutionStarted(state, true);
		const lines = dispatchResult(
			"bash",
			textResult("watched line\n\nCommand aborted"),
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("✗ Cancelled");
		expect(text).toContain("Cancelled");
		expect(text).toContain("watched line");
		expect(text).not.toContain("Command aborted");
		assertFit(lines, 80);
	});

	it("recognizes a bare agent-abort message as cancelled", () => {
		const state: Record<string, unknown> = {};
		const ctx = context({
			toolCallId: "b-abort-msg",
			args: { command: "npm run watch", timeout: 30 },
			state,
			isError: true,
		});
		recordExecutionStarted(state, true);
		const lines = dispatchResult(
			"bash",
			textResult("Operation aborted"),
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("✗ Cancelled");
		expect(text).toContain("Cancelled");
		assertFit(lines, 80);
	});

	it("reports live elapsed while running and freezes it at the end", () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		try {
			const state: Record<string, unknown> = {};
			recordExecutionStarted(state, true);
			vi.advanceTimersByTime(1250);
			const live = getStateElapsedMs(state);
			expect(live).toBeGreaterThanOrEqual(1250);
			recordExecutionEnded(state);
			const frozen = getStateElapsedMs(state);
			vi.advanceTimersByTime(5000);
			expect(getStateElapsedMs(state)).toBe(frozen);
			expect(frozen).toBeGreaterThanOrEqual(1250);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("boxed tool decoration owner", () => {
	it("always neutralizes the native container fill; boxes tint themselves", () => {
		const owner = createToolDecorationOwner({ style: "compact-box" });
		const native = () => undefined;
		const makeContainer = () => {
			const c = {
				paddingX: 1,
				paddingY: 1,
				setBgFnCalls: 0,
				setBgFn(_fn: (text: string) => string) {
					c.setBgFnCalls++;
				},
			};
			return c;
		};
		// Boxed (TaskUpdate fallback) and boxless (read) dispatches alike: the
		// container fill is always removed — rendered components own the tint.
		for (const toolName of ["read", "TaskUpdate"]) {
			const container = makeContainer();
			const renderer = owner.decorateToolRendererSelection(
				"tool-call-renderer",
				native,
				{ toolName, contentBox: container },
				[],
			);
			(renderer as (a: unknown, t: unknown, c: unknown) => unknown)({ path: "/fake/a.ts" }, theme, context());
			expect(container.setBgFnCalls).toBe(1);
			expect(container.paddingX).toBe(0);
			expect(container.paddingY).toBe(0);
		}
	});

	it("tints rendered boxes but not boxless surfaces (box => background)", () => {
		const tinted = createFakeTheme({
			backgrounds: { toolPendingBg: "#20222a", toolSuccessBg: "#203020", toolErrorBg: "#3a2020" },
		});
		const isTinted = (line: string) => line.startsWith("\x1b[48;2;");

		// Full call box (edit) — every line wrapped in the status fill.
		const editCall = dispatchCall(
			"edit",
			{ path: "/fake/src/a.ts" },
			tinted,
			context({ args: { path: "/fake/src/a.ts" } }),
		).render(80);
		expect(editCall.length).toBeGreaterThan(0);
		for (const line of editCall) expect(isTinted(line)).toBe(true);

		// Compact framed box (write preview) — tinted via its opt-in.
		const writeCall = dispatchCall(
			"write",
			{ path: "/tmp/x.md", content: "hello" },
			tinted,
			context({ args: { path: "/tmp/x.md", content: "hello" } }),
		).render(80);
		for (const line of writeCall) expect(isTinted(line)).toBe(true);

		// Boxed result (edit diff frame) — tinted.
		const res = dispatchResult(
			"edit",
			{ content: [], details: { diff: "+ 1 x", path: "/fake/src/a.ts" } },
			{ expanded: false, isPartial: false },
			tinted,
			context({ args: { path: "/fake/src/a.ts" } }),
		).render(80);
		for (const line of res) expect(isTinted(line)).toBe(true);

		// Boxless quiet-tool row (read) — transparent.
		const readCall = dispatchCall(
			"read",
			{ path: "/fake/src/a.ts" },
			tinted,
			context({ args: { path: "/fake/src/a.ts" } }),
		).render(80);
		expect(readCall.join("\n")).not.toContain("\x1b[48;");
	});

	it("renders failed boxes with an error-colored frame", () => {
		const redError = createFakeTheme({ colors: { error: "#ff0000" } });
		const ERROR_RED = "\x1b[38;2;255;0;0m";

		// Failed call box: the top border carries the error color around the
		// already error-colored `➔ Name ✗` title.
		const call = dispatchCall(
			"bash",
			{ command: "tsc" },
			redError,
			context({ args: { command: "tsc" }, isError: true }),
		);
		const callLines = call.render(80);
		expect(callLines[0]).toContain(ERROR_RED);
		expect(stripAnsi(callLines[0])).toContain("➔ Bash ✗");

		// Failed result: every frame line (divider, body side bars, bottom
		// border) renders in the error color; content colors stay untouched.
		const lines = dispatchResult(
			"bash",
			{ content: [{ type: "text", text: "error TS2304: Cannot find name" }], details: {} },
			{ expanded: false, isPartial: false },
			redError,
			context({ args: { command: "tsc" }, isError: true }),
		).render(80);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line).toContain(ERROR_RED);
		const plain = stripAnsi(lines.join("\n"));
		expect(plain).toContain("Response");
		expect(plain).toContain("error TS2304");
	});
	it("provides a boxed fallback renderer when the tool has no native renderer", () => {
		const owner = createToolDecorationOwner({ style: "compact-box" });
		// Extension tools (e.g. TaskUpdate) register no renderCall/renderResult:
		// getCallRenderer returns undefined and updateDisplay would fall back to a
		// plain Text. The decoration owner must substitute a boxed fallback renderer.
		const native = () => undefined;
		const instance = { toolName: "TaskUpdate" };
		const callRenderer = owner.decorateToolRendererSelection("tool-call-renderer", native, instance, []);
		expect(typeof callRenderer).toBe("function");
		const ctx = context({ args: { taskId: "2" } });
		const callLines = (callRenderer as (a: unknown, t: unknown, c: unknown) => { render(w: number): string[] })(
			{ taskId: "2" },
			theme,
			ctx,
		).render(80);
		expect(callLines.join("\n")).toContain("Task Update");
		assertFit(callLines, 80);

		const resultRenderer = owner.decorateToolRendererSelection("tool-result-renderer", native, instance, []);
		expect(typeof resultRenderer).toBe("function");
		const resultLines = (
			resultRenderer as (r: unknown, o: unknown, t: unknown, c: unknown) => { render(w: number): string[] }
		)(
			{ content: [{ type: "text", text: "Updated task #2 status" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		).render(80);
		expect(resultLines.join("\n")).toContain("Updated task #2 status");
		assertFit(resultLines, 80);
	});

	it("dispatches compact-box renderers with boxed borders", () => {
		const owner = createToolDecorationOwner({ style: "compact-box" });
		const native = () => (args: Record<string, unknown>) => ({
			invalidate() {},
			render() {
				return [`native ${args.path ?? ""}`];
			},
		});
		const instance = { toolName: "read" };
		const wrapped = owner.decorateToolRendererSelection("tool-call-renderer", native, instance, []);
		expect(typeof wrapped).toBe("function");
		const component = (wrapped as (args: unknown, theme: unknown, context: unknown) => { render(w: number): string[] })(
			{ path: "/fake/a.ts" },
			theme,
			context(),
		);
		const lines = component.render(80);
		expect(lines[0]).toContain("➔ Read");
		expect(lines[0]).toContain("a.ts");
		expect(lines[0]).not.toContain("(1)");
		expect(lines.join("\n")).not.toContain("╭");
		assertFit(lines, 80);
	});

	it("hides collapsed turn members that render through the no-native-renderer fallback", () => {
		// Extension tools (TaskCreate/TaskUpdate/ask_user_question) have no
		// renderCall/renderResult; their collapsed turn members must still be
		// hidden — otherwise Pi leaves a stray native placeholder row per block
		// after the turn collapse.
		try {
			setToolsRenderConfig({ collapseAfterTurn: true, collapseMutatingTools: false });
			const owner = createToolDecorationOwner({ style: "compact-box" });
			const native = () => undefined;
			const instance = { toolName: "TaskUpdate" };
			const callRenderer = owner.decorateToolRendererSelection("tool-call-renderer", native, instance, []);
			const resultRenderer = owner.decorateToolRendererSelection("tool-result-renderer", native, instance, []);
			expect(typeof callRenderer).toBe("function");
			expect(typeof resultRenderer).toBe("function");

			beginAgentRun();
			registerTurnFromMessage(message([toolCall("t1", "TaskUpdate"), toolCall("t2", "TaskUpdate")]), [
				result("t1"),
				result("t2"),
			]);
			finishAgentRun();

			// The leader renders the summary; the other member collapses to the
			// hidden batch singleton.
			const leaderComponent = (callRenderer as (a: unknown, t: unknown, c: unknown) => { render(w: number): string[] })(
				{ taskId: "2" },
				theme,
				context({ toolCallId: "t1" }),
			);
			expect(leaderComponent).not.toBe(EMPTY_BATCH_COMPONENT);
			expect(stripAnsi(leaderComponent.render(80).join("\n"))).toContain("◈ Thought 0 times · Called 2 tools");

			const callComponent = (callRenderer as (a: unknown, t: unknown, c: unknown) => { render(w: number): string[] })(
				{ taskId: "3" },
				theme,
				context({ toolCallId: "t2" }),
			);
			expect(callComponent).toBe(EMPTY_BATCH_COMPONENT);
			expect((instance as { hideComponent?: boolean }).hideComponent).toBe(true);

			const resultComponent = (
				resultRenderer as (r: unknown, o: unknown, t: unknown, c: unknown) => { render(w: number): string[] }
			)(
				{ content: [{ type: "text", text: "ok" }], details: {} },
				{ expanded: false, isPartial: false },
				theme,
				context({ toolCallId: "t2" }),
			);
			expect(resultComponent).toBe(EMPTY_BATCH_COMPONENT);
			expect((instance as { hideComponent?: boolean }).hideComponent).toBe(true);
		} finally {
			resetTurnRegistry();
		}
	});
});

describe("special message blocks", () => {
	it("renders compact skills and boxed compaction, branch, and custom blocks with a theme", () => {
		installSpecialBlockAdapters();
		setSpecialBlockTheme(theme);
		const skillBlock = parseSkillBlock('<skill name="fixture" location="/fake">\ncontent **rich**\n</skill>');
		if (!skillBlock) throw new Error("skill fixture failed to parse");
		const components = [
			new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: "summary **rich**",
				tokensBefore: 1234,
				timestamp: 1,
			}),
			new BranchSummaryMessageComponent({
				role: "branchSummary",
				summary: "branch **rich**",
				fromId: "id",
				timestamp: 1,
			}),
			new SkillInvocationMessageComponent(skillBlock),
			new CustomMessageComponent(
				{ role: "custom", customType: "mcp_tool", content: "custom **rich**", display: true, timestamp: 1 },
				undefined,
			),
		];
		const expectations = ["Compaction", "Branch", "[fixture]", "mcp_tool"];
		for (const [index, component] of components.entries()) {
			const lines = component.render(80);
			expect(lines.join("\n").includes("╭")).toBe(index !== 2);
			expect(lines.join("\n")).toContain(expectations[index] ?? "");
			assertFit(lines, 80);
		}
	});

	it("compaction block defaults to expanded and collapses through setExpanded", () => {
		installSpecialBlockAdapters();
		setSpecialBlockTheme(theme);
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "## Goal\n\n- the record of the conversation\n\n## Progress\n\nSecond section remains expanded-only.",
			tokensBefore: 4321,
			timestamp: 1,
		});
		// The boxed compaction block starts expanded: the summary is the only
		// in-transcript record of the compacted conversation.
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("Compaction");
		expect(expanded).toContain("the record of the conversation");
		expect(expanded).toContain("Second section remains expanded-only.");
		expect(expanded).toContain("▾ Compaction");
		// An explicit collapse (Ctrl+O / click) shows one real preview and the hint.
		component.setExpanded(false);
		const collapsed = stripAnsi(component.render(80).join("\n"));
		expect(collapsed).toContain("Compaction");
		expect(collapsed).toContain("the record of the conversation");
		expect(collapsed).not.toContain("Second section remains expanded-only.");
		expect(collapsed).toContain("▸ Compaction");
		const shell = component
			.render(80)
			.map(stripAnsi)
			.filter((line) => line.trim());
		expect(shell).toHaveLength(3);
		expect(shell[1]?.trim()).toMatch(/^│\s+the record of the conversation\s+│$/u);
	});

	it("uses a neutral background and restores the native background on teardown", () => {
		installSpecialBlockAdapters();
		const rich = createFakeTheme({ backgrounds: { userMessageBg: "#0f1216", customMessageBg: "#2a3038" } });
		setSpecialBlockTheme(rich);
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 1234,
			timestamp: 1,
		});
		expect(component.render(80).join("\n")).toContain("\x1b[48;2;15;18;22m");
		expect(component.render(80).join("\n")).not.toContain("\x1b[48;2;42;48;56m");
		setSpecialBlockTheme(undefined);
		component.invalidate();
		expect(component.render(80).join("\n")).toContain("\x1b[48;2;42;48;56m");
		expect(component.render(80).join("\n")).not.toContain("╭");
	});

	it("restores native fill when compatibility patches are disabled, without clearing the cached theme", () => {
		installSpecialBlockAdapters();
		const rich = createFakeTheme({ backgrounds: { userMessageBg: "#0f1216", customMessageBg: "#2a3038" } });
		setSpecialBlockTheme(rich);
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 1234,
			timestamp: 1,
		});
		expect(component.render(80).join("\n")).toContain("\x1b[48;2;15;18;22m");
		if (!activeReport) throw new Error("missing compatibility report");
		expect(disposePiCompatibilityProbe(activeReport).complete).toBe(true);
		component.invalidate();
		expect(component.render(80).join("\n")).toContain("\x1b[48;2;42;48;56m");
		expect(component.render(80).join("\n")).not.toContain("╭");
	});

	it.each(["truecolor", "256color"])("resolves titanium's compactionBgColor extra in %s", (mode) => {
		installSpecialBlockAdapters();
		const rich = createFakeTheme();
		Object.assign(rich, { sourcePath: resolve("themes/titanium.json"), getColorMode: () => mode });
		setSpecialBlockTheme(rich);
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 1234,
			timestamp: 1,
		});
		expect(component.render(80).join("\n")).toContain(mode === "truecolor" ? "\x1b[48;2;15;18;22m" : "\x1b[48;5;");
	});

	it("fits Unicode previews at narrow widths and has no empty body for an empty summary", () => {
		installSpecialBlockAdapters();
		setSpecialBlockTheme(theme);
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: `## Goal\n\n- ${"Sửa giao diện 界 🚀 ".repeat(20)}\n\nSecond paragraph.`,
			tokensBefore: 1234,
			timestamp: 1,
		});
		component.setExpanded(false);
		for (const width of [20, 40, 80, 120]) {
			const lines = component.render(width);
			assertFit(lines, width);
			expect(lines.map(stripAnsi).filter((line) => line.trim())).toHaveLength(3);
			expect(stripAnsi(lines.join("\n"))).not.toContain("Second paragraph.");
		}
		const empty = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "",
			tokensBefore: 1234,
			timestamp: 1,
		});
		empty.setExpanded(false);
		expect(
			empty
				.render(80)
				.map(stripAnsi)
				.filter((line) => line.trim()),
		).toHaveLength(2);
	});

	it("keeps click-to-toggle behavior for the dense compaction card", () => {
		installSpecialBlockAdapters();
		setSpecialBlockTheme(theme);
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "preview\n\nexpanded-only",
			tokensBefore: 1234,
			timestamp: 1,
		});
		component.render(80);
		const event = { type: "click", button: "left", x: 2, y: 1, width: 80, height: 10 } as const;
		expect(component.handleMouse(event as never)?.handled).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("expanded-only");
		expect(component.handleMouse(event as never)?.handled).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("expanded-only");
	});

	it("falls back to native layout without a session theme", () => {
		installSpecialBlockAdapters();
		const skillBlock = parseSkillBlock('<skill name="fixture" location="/fake">\ncontent\n</skill>');
		if (!skillBlock) throw new Error("skill fixture failed to parse");
		const component = new SkillInvocationMessageComponent(skillBlock);
		const native = component.render(80);
		expect(native.join("\n")).not.toContain("╭");
	});

	it("keeps a custom renderer when provided", () => {
		installSpecialBlockAdapters();
		setSpecialBlockTheme(theme);
		const component = new CustomMessageComponent(
			{ role: "custom", customType: "mcp_tool", content: "ignored", display: true, timestamp: 1 },
			(message: { content?: unknown }) =>
				({ render: () => [`renderer:${String(message.content)}`], invalidate() {} }) as never,
		);
		const lines = component.render(80);
		expect(lines.join("\n")).toContain("╭");
		expect(lines.join("\n")).toContain("renderer:ignored");
		assertFit(lines, 80);
	});
});

describe("renderBoxedToolCall/renderBoxedToolResult direct primitives", () => {
	it("colors the whole tool title with the error color on failure", () => {
		const rich = createFakeTheme({
			colors: { border: "#888888", error: "#ff4444", success: "#22dd44", bashMode: "#ffcc66" },
		});
		const ok = renderBoxedToolCall(rich, "Tool", ["detail"], {}).render(40)[0];
		const err = renderBoxedToolCall(rich, "Tool", ["detail"], { isError: true }).render(40)[0];
		// Success: the tool keeps its identity color and only the ✓ is success-colored.
		expect(ok ?? "").toContain("\x1b[38;2;255;204;102m➔ Tool");
		expect(ok ?? "").toContain("\x1b[38;2;34;221;68m✓");
		expect(ok ?? "").not.toContain("\x1b[38;2;255;68;68m");
		// Error: the whole "➔ Tool ✗" span is wrapped in the error color.
		expect(err ?? "").toContain("\x1b[38;2;255;68;68m➔ Tool ✗");
	});

	it("keeps every border glyph dim-styled around embedded labels", () => {
		// Embedded labels (title/divider/footer) wrap their text in foreground
		// escapes that end with \x1b[39m (reset to the terminal default). The border
		// must re-apply its color per segment, otherwise every dash after a label
		// renders in the default foreground and the box looks faint/bold in parts.
		const theme = createFakeTheme({});
		const dimPrefix = "\x1b[2m";
		const call = renderBoxedToolCall(theme, "Tool", ["detail"], {}).render(40);
		expect(call[0] ?? "").toContain(`${dimPrefix}╭`);
		expect(call[0] ?? "").toContain(`${dimPrefix}╮`);
		const result = renderBoxedToolResult(theme, () => ["out"], { footerLines: ["0.00s · ~2 words"] }).render(40);
		expect(result[0] ?? "").toContain(`${dimPrefix}├`);
		expect(result[0] ?? "").toContain(`${dimPrefix}┤`);
		const bottom = result[result.length - 1] ?? "";
		expect(bottom).toContain(`${dimPrefix}╰`);
		expect(bottom).toContain(`${dimPrefix}╯`);
	});

	it("renders pending and error states", () => {
		const pending = renderBoxedToolCall(theme, "Tool", ["detail"], { isPending: true }).render(80);
		expect(pending.join("\n")).toContain("Waiting for output");
		const error = renderBoxedToolResult(theme, () => ["boom"], { isError: true }).render(80);
		expect(error.join("\n")).toContain("✗ Error");
		assertFit(pending, 80);
		assertFit(error, 80);
	});
});
