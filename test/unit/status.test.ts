import { describe, expect, it } from "vitest";
import {
	CachedGitProvider,
	InMemoryContextProvider,
	InMemoryUsageProvider,
	parseGitStatus,
} from "../../extension-src/pi-style/app/providers.js";
import { createSnapshot, replaceSnapshot } from "../../extension-src/pi-style/app/snapshot.js";
import { normalizeConfig } from "../../extension-src/pi-style/domain/config-normalization.js";
import {
	contextPercent,
	contextState,
	createBuiltinSegments,
	type SegmentRenderResult,
	type StatusSegment,
} from "../../extension-src/pi-style/domain/status.js";
import { normalizeStatusLayout } from "../../extension-src/pi-style/domain/status-presets.js";
import { renderStatus } from "../../extension-src/pi-style/domain/status-renderer.js";
import { resolveTheme } from "../../extension-src/pi-style/domain/theme.js";

import { stripAnsi } from "../../extension-src/pi-style/shared/ansi.js";

const theme = resolveTheme(undefined, normalizeConfig({ theme: { nerdFonts: "off" } }));
function segment(
	id: string,
	content: string,
	compactContent?: string,
	priority = 10,
	overflow: StatusSegment["overflow"] = "secondary",
): StatusSegment {
	const result: SegmentRenderResult = { visible: true, content, ...(compactContent ? { compactContent } : {}) };
	return { id, defaultPriority: priority, overflow, render: () => result };
}

describe("status contracts", () => {
	it("normalizes presets, explicit empty groups, and duplicates", () => {
		expect(
			normalizeStatusLayout("default", { left: ["model", "model"], right: [], secondary: ["git", "git"] }),
		).toEqual({
			left: ["model"],
			right: [],
			secondary: ["git"],
		});
		expect(normalizeConfig({ preset: "minimal" }).statusLine.layout.left).toEqual(["path", "git"]);
	});
	it("supports every thinking label and clamps context percentages", () => {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
		for (const level of levels) {
			const result = renderStatus({ left: ["thinking"], right: [], secondary: [] }, { thinkingLevel: level }, 80, {
				segments: createBuiltinSegments(),
				theme,
			});
			// Rainbow levels embed ANSI between characters; compare the visible text.
			const plain = stripAnsi(result.primary);
			expect(plain).toContain(level === "minimal" ? "think:min" : level === "medium" ? "think:med" : `think:${level}`);
		}
		expect(contextPercent({ percent: -10 })).toBe(0);
		expect(contextPercent({ percent: 140 })).toBe(100);
	});

	it("normalizes context thresholds and snapshot status values", () => {
		expect(contextState(49)).toBe("low");
		expect(contextState(90)).toBe("critical");
		expect(contextPercent({ currentTokens: 50, windowTokens: 100 })).toBe(50);
		const initial = createSnapshot(2, 0, { thinkingLevel: "off", context: { percent: 20 } });
		const next = replaceSnapshot(initial, 2, { thinkingLevel: "high", context: { percent: 80 } });
		expect(next.revision).toBe(1);
		expect(next.thinkingLevel).toBe("high");
	});
});

describe("responsive status renderer", () => {
	it("renders the pipe-delimited context block with compact fallback", () => {
		const full = renderStatus(
			{ left: ["context_bar"], right: [], secondary: [] },
			{ context: { percent: 47, currentTokens: 470_000, windowTokens: 1_000_000 } },
			80,
			{ segments: createBuiltinSegments(), theme },
		);
		const plain = stripAnsi(full.primary);
		expect(plain).toMatch(/^\[█{5}░{5}\] \| 47% used \| 470K\/1\.0M$/);
		expect(plain).toContain("47%");
		// Without token counts the block drops only the totals part.
		const percentOnly = renderStatus(
			{ left: ["context_bar"], right: [], secondary: [] },
			{ context: { percent: 47, windowTokens: 1_000_000 } },
			80,
			{ segments: createBuiltinSegments(), theme },
		);
		expect(stripAnsi(percentOnly.primary)).toMatch(/^\[█{5}░{5}\] \| 47% used$/);
		// Zero percent renders an empty bar with a zero total; compact form drops the block.
		const empty = renderStatus(
			{ left: ["context_bar"], right: [], secondary: [] },
			{ context: { percent: 0, currentTokens: 0, windowTokens: 1_000_000 } },
			80,
			{ segments: createBuiltinSegments(), theme },
		);
		expect(stripAnsi(empty.primary)).toMatch(/^\[░{10}\] \| 0% used \| 0\/1\.0M$/);
		const hidden = renderStatus({ left: ["context_bar"], right: [], secondary: [] }, { context: {} }, 80, {
			segments: createBuiltinSegments(),
			theme,
		});
		expect(hidden.lines).toEqual([]);
	});

	it("colors the context bar green under 50%, yellow 50-70%, red above 70%", () => {
		const colored = resolveTheme(
			undefined,
			normalizeConfig({
				theme: { nerdFonts: "off", colors: { success: "#00ff00", warning: "#ffff00", error: "#ff0000" } },
			}),
		);
		const render = (percent: number) =>
			renderStatus({ left: ["context_bar"], right: [], secondary: [] }, { context: { percent } }, 80, {
				segments: createBuiltinSegments(),
				theme: colored,
			}).primary;
		expect(render(49)).toContain("\x1b[38;2;0;255;0m");
		expect(render(60)).toContain("\x1b[38;2;255;255;0m");
		expect(render(71)).toContain("\x1b[38;2;255;0;0m");
	});

	it("renders model_effort right-aligned with provider and effort level", () => {
		const result = renderStatus(
			{ left: [], right: ["model_effort"], secondary: [] },
			{ model: "deepseek-v4-flash", provider: "deepseek", thinkingLevel: "high", reasoning: true },
			80,
			{ segments: createBuiltinSegments(), theme },
		);
		const plain = stripAnsi(result.primary);
		expect(plain.endsWith("(deepseek) deepseek-v4-flash • high")).toBe(true);
		expect(plain).toHaveLength(80);
		// Non-reasoning model with no active level shows just the model.
		const bare = renderStatus(
			{ left: [], right: ["model_effort"], secondary: [] },
			{ model: "claude-sonnet-4-5" },
			80,
			{ segments: createBuiltinSegments(), theme },
		);
		expect(stripAnsi(bare.primary).trim()).toBe("claude-sonnet-4-5");
	});

	it.each([0, 1, 2])("preserves fitted right-aligned content with %i spare columns", (spare) => {
		const segments = new Map([
			["left", segment("left", theme.apply("muted", "L"))],
			["right", segment("right", theme.apply("muted", "右"))],
		]);
		const result = renderStatus({ left: ["left"], right: ["right"], secondary: [] }, {}, 6 + spare, {
			segments,
			theme,
		});
		expect(stripAnsi(result.primary)).toBe(`L | ${" ".repeat(spare)}右`);
	});

	it.each([0, 1, 2])("preserves a right-only segment with %i spare columns", (spare) => {
		const segments = new Map([["right", segment("right", "右")]]);
		const result = renderStatus({ left: [], right: ["right"], secondary: [] }, {}, 2 + spare, {
			segments,
			theme,
		});
		expect(stripAnsi(result.primary)).toBe(`${" ".repeat(spare)}右`);
	});

	it("renders extension statuses as sorted values only (native footer format)", () => {
		const result = renderStatus(
			{ left: ["extension_statuses"], right: [], secondary: [] },
			{
				extensionStatuses: [
					{ key: "pi-rules", value: "pi-rules: 0 rules ✓" },
					{ key: "MCP", value: "🔌 MCP: 1 server enabled" },
				],
			},
			80,
			{ segments: createBuiltinSegments(), theme },
		);
		expect(stripAnsi(result.primary)).toBe("🔌 MCP: 1 server enabled pi-rules: 0 rules ✓");
	});

	it("renders the default layout with a right-aligned model row", () => {
		const config = normalizeConfig({ theme: { nerdFonts: "off" } });
		const result = renderStatus(
			config.statusLine.layout,
			{
				model: "deepseek-v4-flash",
				provider: "deepseek",
				reasoning: true,
				thinkingLevel: "high",
				cwd: "/Users/quannv.dev/Workspace/Personal/pi-dev/pi-style",
				git: { available: true, branch: "main", staged: 0, unstaged: 36, untracked: 9, refreshing: false },
				context: { percent: 47, windowTokens: 1_000_000 },
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					cost: 0.015,
					streaming: false,
				},
			},
			120,
			{ separator: "│", segments: createBuiltinSegments(), theme },
		);
		const plain = stripAnsi(result.primary);
		expect(plain).toMatch(
			/^pi-style │ ⎇ main \*36 \?9 │ \[█{5}░{5}\] \| 47% used │ \$0\.015 │\s+\(deepseek\) deepseek-v4-flash • high$/,
		);
		expect(plain).toHaveLength(120);
	});

	it("fits every documented width without exceeding it", () => {
		const segments = new Map([
			["model", segment("model", "model-name", "m", 1, "primary")],
			["path", segment("path", "/very/long/path", "~/path", 3)],
			["git", segment("git", "main +2", "main", 4)],
			["extension_statuses", segment("extension_statuses", "extension status", "status", 20)],
		]);
		for (const width of [1, 20, 40, 60, 80, 120, 160]) {
			const result = renderStatus(
				{ left: ["model", "path", "git"], right: [], secondary: ["extension_statuses"] },
				{ model: "model-name" },
				width,
				{ segments, theme, separator: "|" },
			);
			expect(result.lines.every((line) => [...line].length <= width)).toBe(true);
		}
	});

	it("drops disabled, unknown, throwing, and duplicate segments safely", () => {
		const throwing: StatusSegment = {
			id: "bad",
			defaultPriority: 1,
			render: () => {
				throw new Error("bad");
			},
		};
		const result = renderStatus(
			{ left: ["model", "model", "unknown", "bad"], right: [], secondary: [] },
			{ model: "model" },
			20,
			{
				segments: new Map([
					["model", segment("model", "model", undefined, 100, "primary")],
					["bad", throwing],
				]),
				theme,
				options: { model: { disabled: true } },
			},
		);
		expect(result.lines).toEqual([]);
	});
});

describe("cached providers", () => {
	it("parses git porcelain counts", () => {
		const value = parseGitStatus("## main...origin/main [ahead 2]\nM  staged.ts\n M work.ts\n?? new.ts\n");
		expect(value).toMatchObject({ available: true, branch: "main", staged: 1, unstaged: 1, untracked: 1, ahead: 2 });
	});
	it("deduplicates cached git refreshes and finalizes usage once", async () => {
		let calls = 0;
		const provider = new CachedGitProvider(
			{
				run: async () => {
					calls++;
					return { stdout: "## main\n", stderr: "", code: 0 };
				},
			},
			1000,
		);
		await Promise.all([provider.get("/repo"), provider.get("/repo")]);
		expect(calls).toBe(1);
		const usage = new InMemoryUsageProvider();
		usage.record("s", { inputTokens: 2, outputTokens: 3, streaming: true }, { eventId: "e" });
		usage.record("s", { inputTokens: 20, outputTokens: 4 }, { eventId: "e", finalized: true });
		usage.record("s", { inputTokens: 99 }, { eventId: "e" });
		expect(usage.get("s").inputTokens).toBe(20);
		expect(usage.get("s").streaming).toBe(false);
		const context = new InMemoryContextProvider();
		context.set("s", { percent: 40 });
		expect(context.get("s")?.percent).toBe(40);
	});
});
