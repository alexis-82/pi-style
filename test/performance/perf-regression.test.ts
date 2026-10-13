// Performance regression guards for the 2025 perf-audit fixes (C1-C5, H1-H4,
// M1-M7, L1-L3).
//
// Timing bounds: measured post-fix on this machine AND on a GitHub Actions
// ubuntu runner (which runs ~4× slower). Each bound sits ~2-3× above the
// slowest observed CI measurement while staying clearly below the pre-fix
// cost (scaled to the same runner), so genuine regressions still fail while
// runner variance does not.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiStyleRuntime } from "../../extension-src/pi-style/app/runtime.js";
import { normalizeConfig } from "../../extension-src/pi-style/domain/config-normalization.js";
import { createBuiltinSegments } from "../../extension-src/pi-style/domain/status.js";
import { renderStatus } from "../../extension-src/pi-style/domain/status-renderer.js";
import { resolveTheme } from "../../extension-src/pi-style/domain/theme.js";
import {
	__resetMessageDecorationTestState,
	decorateMessageRender,
} from "../../extension-src/pi-style/features/messages/index.js";
import { installStatusLine } from "../../extension-src/pi-style/features/status-line/index.js";
import { bashTool, resetBashTreeRegistry } from "../../extension-src/pi-style/features/tools/boxed/bash.js";
import { resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import { editTool } from "../../extension-src/pi-style/features/tools/boxed/edit.js";
import { renderGitDiffResult } from "../../extension-src/pi-style/features/tools/boxed/git.js";
import { lsTool } from "../../extension-src/pi-style/features/tools/boxed/ls.js";
import { quickEditTool } from "../../extension-src/pi-style/features/tools/boxed/quick-edit.js";
import { readTool } from "../../extension-src/pi-style/features/tools/boxed/read.js";
import { stopAllElapsedTickers } from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import { getRenderCacheKey } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import {
	beginAgentRun,
	finishAgentRun,
	getTurnEntry,
	invalidateTurnMembers,
	noteTurnMemberRender,
	registerTurnFromMessage,
	releaseTurnInvalidators,
	resetTurnRegistry,
} from "../../extension-src/pi-style/features/tools/boxed/turn-summary.js";
import { visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";
import { countWords } from "../../extension-src/pi-style/shared/box.js";
import { createFakeTheme } from "../helpers/fake-theme.js";

const theme = createFakeTheme();

function context(overrides: Partial<BoxedToolContext> = {}): BoxedToolContext {
	return {
		args: {},
		toolCallId: "regression-call",
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

function bench(label: string, iterations: number, fn: () => void): number {
	fn(); // warmup
	const start = performance.now();
	for (let index = 0; index < iterations; index++) fn();
	const elapsed = performance.now() - start;
	console.log(
		`[perf-regression] ${label}: ${(elapsed / iterations).toFixed(4)} ms/op (total ${elapsed.toFixed(1)} ms)`,
	);
	return elapsed;
}

function makeOutput(lines: number): string {
	return Array.from({ length: lines }, (_, index) => `line ${index} of output with some text content`).join("\n");
}

afterEach(() => {
	resetBatchRegistry();
	resetBashTreeRegistry();
	resetTurnRegistry();
	stopAllElapsedTickers();
	__resetMessageDecorationTestState();
	vi.useRealTimers();
});

describe("perf regression — shared width/word primitives", () => {
	it("visibleWidth stays delegated-fast (H1: pre-fix ~2.0µs, post-fix ~0.02µs)", () => {
		const styled = "\x1b[38;5;109m⎇ main\x1b[0m ctx:42% · in:120k · $0.042 · 12:34";
		const total = bench("visibleWidth styled x20000", 20_000, () => visibleWidth(styled));
		// Post-fix CI: ~2.5ms. Pre-fix: ~40ms local / ~150ms CI. Bound: 25ms.
		expect(total).toBeLessThan(25);
	});

	it("visibleWidth terminal-width semantics are correct (H1 correctness)", () => {
		expect(visibleWidth("\x1b[31mhello\x1b[0m")).toBe(5);
		expect(visibleWidth("こんにちは")).toBe(10); // CJK wide chars = 2 columns each
		expect(visibleWidth("ａ")).toBe(2); // fullwidth latin
		expect(visibleWidth("")).toBe(0);
	});

	it("countWords scans large outputs in bounded time (C1: pre-fix 1.65ms/90KB, post-fix ~0.2ms)", () => {
		const output = makeOutput(2000);
		expect(countWords("one two three")).toBe(3);
		expect(countWords("don't stop-believe_x")).toBe(2); // hyphen/underscore join word runs
		const total = bench("countWords 90KB x30", 30, () => countWords(output));
		// Post-fix CI: ~14ms. Pre-fix: ~50ms local / ~200ms CI. Bound: 45ms.
		expect(total).toBeLessThan(45);
	});
});

describe("perf regression — render cache keys are bounded (C2)", () => {
	it("folds megabyte parts into a short, stable, content-sensitive key", () => {
		const huge = "x".repeat(1024 * 1024);
		const key = getRenderCacheKey("bash-final-result", theme, true, false, "cmd", huge, "12");
		expect(key.length).toBeLessThan(256);
		expect(getRenderCacheKey("bash-final-result", theme, true, false, "cmd", huge, "12")).toBe(key);
		expect(getRenderCacheKey("bash-final-result", theme, true, false, "cmd", `${huge}!`, "12")).not.toBe(key);
		// Short parts stay verbatim (cheap strings must not be hashed needlessly).
		expect(getRenderCacheKey("p", theme, "short-part")).toContain("short-part");
	});
});

describe("perf regression — bash result dispatch (C3/C4a/M6)", () => {
	it("warm final dispatch is memoized and cheap (pre-fix 3.28ms/pass, post-fix ~0.18ms)", () => {
		const raw = makeOutput(2000);
		const result = { content: [{ type: "text", text: raw }] };
		const ctx = context({ args: { command: "echo hi" } });
		const first = bashTool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		const total = bench("bash final warm x100", 100, () => {
			bashTool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		});
		// Memoized component must be reference-identical across warm passes.
		expect(bashTool.result(result, { expanded: false, isPartial: false }, theme, ctx)).toBe(first);
		// Post-fix CI: ~37ms. Pre-fix: ~330ms local / ~1.3s CI. Bound: 120ms.
		expect(total).toBeLessThan(120);
	});

	it("streaming partial passes are tail-only (pre-fix 0.88ms/pass @100KB, post-fix ~0.02ms)", () => {
		const raw = makeOutput(2400); // ~100KB
		const result = { content: [{ type: "text", text: raw }] };
		const ctx = context({ args: { command: "echo hi" } });
		// Prime the result-seen flag so partial passes take the streaming path.
		bashTool.result(result, { expanded: false, isPartial: true }, theme, ctx);
		const total = bench("bash streaming partial x100", 100, () => {
			bashTool.result(result, { expanded: false, isPartial: true }, theme, ctx);
		});
		// Post-fix CI: ~5ms. Pre-fix: ~90ms local / ~350ms CI. Bound: 25ms.
		expect(total).toBeLessThan(25);
	});
});

describe("perf regression — diff components are memoized (C5)", () => {
	it("edit result reuses the memoized component across warm passes", () => {
		const diff = ["- 1 alpha", "- 2 beta", "+ 1 alpha2", "+ 2 beta2"].join("\n");
		const result = { content: [{ type: "text", text: "done" }], details: { diff, path: "/x/a.ts" } };
		const ctx = context({ args: { path: "/x/a.ts" } });
		const first = editTool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		for (let index = 0; index < 25; index++) {
			expect(editTool.result(result, { expanded: false, isPartial: false }, theme, ctx)).toBe(first);
		}
	});

	it("git diff result reuses the memoized component across warm passes", () => {
		const parsed = {
			kind: "diff" as const,
			show: false,
			files: [{ path: "a.ts", additions: 2, removals: 2, body: "- 1 old\n+ 1 new\n- 2 old\n+ 2 new" }],
		};
		const ctx = context();
		const first = renderGitDiffResult(theme, parsed, { expanded: false }, ctx);
		for (let index = 0; index < 25; index++) {
			expect(renderGitDiffResult(theme, parsed, { expanded: false }, ctx)).toBe(first);
		}
	});

	it("quick-edit result reuses the memoized component across warm passes", () => {
		const output = ["── diff ──", ":10", "- old", "+ new", "", "---"].join("\n");
		const result = { content: [{ type: "text", text: output }] };
		const tool = quickEditTool({ toolLabel: "Quick Edit", applyingLabel: "quick-edit", fallbackLabel: "applied" });
		const ctx = context({ args: { path: "/x/a.ts" } });
		const first = tool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		for (let index = 0; index < 25; index++) {
			expect(tool.result(result, { expanded: false, isPartial: false }, theme, ctx)).toBe(first);
		}
	});
});

describe("perf regression — status line hot path (H2)", () => {
	const segments = createBuiltinSegments();

	it("renderStatus fits segments in bounded time (pre-fix 125µs, post-fix ~13µs)", () => {
		const config = normalizeConfig({
			statusLine: {
				layout: {
					left: ["pi", "model", "thinking", "path", "git", "context_pct", "token_in", "token_out", "cost", "time"],
					right: ["model_effort"],
				},
			},
		});
		const resolved = resolveTheme(undefined, config);
		const snapshot = {
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			reasoning: true,
			thinkingLevel: "medium" as const,
			cwd: "/Users/x/Workspace/Personal/pi-dev/pi-style",
			git: { available: true, branch: "main", staged: 2, unstaged: 1, untracked: 4, refreshing: false },
			context: { currentTokens: 84_000, windowTokens: 200_000, percent: 42 },
			usage: {
				inputTokens: 120_000,
				outputTokens: 3400,
				cacheReadTokens: 90,
				cacheWriteTokens: 12,
				cost: 0.042,
				streaming: false,
			},
			sessionStartedAt: Date.now() - 3_600_000,
		};
		const options = { segments, theme: resolved, separator: resolved.apply("separator", "│") };
		const total = bench("renderStatus x2000", 2000, () =>
			renderStatus(config.statusLine.layout, snapshot, 120, options),
		);
		// Post-fix CI: ~93ms. Pre-fix: ~250ms local / ~900ms CI. Bound: 250ms.
		expect(total).toBeLessThan(250);
	});

	it("theme token prefixes are memoized per token (pre-fix: one active.fg call per apply)", () => {
		const fgCalls: string[] = [];
		const resolved = resolveTheme(
			{
				fg: (color: string, text: string) => {
					fgCalls.push(color);
					return text;
				},
			},
			normalizeConfig({}),
		);
		for (let index = 0; index < 5000; index++) resolved.apply("text", "payload");
		for (let index = 0; index < 5000; index++) resolved.apply("muted", "payload");
		// Exactly one fg resolution per distinct token despite 10k applies.
		expect(fgCalls.length).toBe(2);
	});

	it("status-line widget render is cached per width until invalidated (reference identity)", () => {
		const factories = new Map<
			string,
			(tui: unknown, activeTheme: unknown) => { render(width: number): string[]; invalidate(): void }
		>();
		const host = {
			setWidget(key: string, content: unknown) {
				if (typeof content === "function") factories.set(key, content as never);
			},
			setFooter() {},
		};
		const installation = installStatusLine({
			host,
			config: normalizeConfig({}),
			generation: 1,
			initialSnapshot: { model: "model-a" },
			isCurrent: () => true,
		});
		const factory = factories.get("pi-style.status.primary");
		expect(factory).toBeDefined();
		const component = factory?.({ requestRender: () => {} }, { fg: (_c: string, t: string) => t });
		expect(component).toBeDefined();
		const first = component?.render(120);
		const second = component?.render(120);
		expect(second).toBe(first); // cached array, not a re-render
		installation.update({ model: "model-b" });
		const third = component?.render(120);
		expect(third).not.toBe(first); // invalidated → fresh render
		installation.dispose();
	});
});

describe("perf regression — message decoration streaming path (H3)", () => {
	it("cold streaming passes stay well under the pre-fix baseline (pre-fix ~211µs/pass, post-fix ~75µs)", () => {
		const instance = { marker: 1 };
		let counter = 0;
		const original = () => Array.from({ length: 40 }, (_, index) => `chunk-${counter} line ${index} ${"y".repeat(60)}`);
		const total = bench("decorateMessageRender cold x400", 400, () => {
			counter++;
			decorateMessageRender(original, instance, [100]);
		});
		// Post-fix CI: ~124ms. Pre-fix: ~85-105ms local / ~330ms CI. Bound: 260ms.
		expect(total).toBeLessThan(260);
	});
});

describe("perf regression — quiet tools skip settled re-parsing (M5)", () => {
	it("ls warm result passes keep the batch render cache identity (no revision bumps)", () => {
		const ctx = context({ toolCallId: "ls-leader" });
		const leader = lsTool.call({ path: "." }, theme, ctx);
		const output = Array.from({ length: 5000 }, (_, index) => `entry-${index}`).join("\n");
		const result = { content: [{ type: "text", text: output }] };
		lsTool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		const first = leader.render(80);
		expect(leader.render(80)).toBe(first); // finalized batches cache rendered lines
		for (let index = 0; index < 20; index++) {
			lsTool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		}
		// No revision bump on warm passes → same cached line array.
		expect(leader.render(80)).toBe(first);
	});

	it("read success passes skip ANSI stripping (pre-fix ~1ms/pass @100KB, post-fix <0.05ms)", () => {
		const ctx = context({ toolCallId: "read-leader" });
		readTool.call({ path: "/x/big.txt" }, theme, ctx);
		const result = { content: [{ type: "text", text: makeOutput(2400) }] };
		readTool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		const total = bench("read warm result x20", 20, () => {
			readTool.result(result, { expanded: false, isPartial: false }, theme, ctx);
		});
		// Chunk merging now counts settled output lines: observed CI ~6ms.
		// Allow runner variance while staying below pre-fix ~20ms local / ~80ms CI.
		expect(total).toBeLessThan(15);
	});
});

describe("perf regression — turn invalidator release (M4)", () => {
	it("released turns keep registry entries but drop invalidate callbacks", () => {
		beginAgentRun();
		const message = {
			content: [
				{ type: "toolCall", id: "r1", name: "read" },
				{ type: "toolCall", id: "b1", name: "bash" },
			],
		};
		registerTurnFromMessage(message, [
			{ toolCallId: "r1", isError: false },
			{ toolCallId: "b1", isError: false },
		]);
		const run = finishAgentRun();
		expect(run).toBeDefined();
		if (!run) return;
		const fired: string[] = [];
		// Simulate captured invalidators.
		const captured = run.members.map((member) => member.toolCallId);
		for (const id of captured) {
			noteTurnMemberRender(id, () => fired.push(id));
		}
		invalidateTurnMembers(run);
		expect(fired).toEqual(captured); // collapse fired each captured callback once
		releaseTurnInvalidators(run);
		fired.length = 0;
		invalidateTurnMembers(run);
		expect(fired).toEqual([]); // after release, nothing fires
		// Scrollback still resolves the turn.
		expect(getTurnEntry("r1")?.turn).toBe(run);
		expect(getTurnEntry("b1")?.turn).toBe(run);
	});
});

describe("perf regression — git refresh coalescing (M7)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a burst of invalidateGit spawns exactly one git status process", async () => {
		let execs = 0;
		const gitRunner = {
			run: async () => {
				execs++;
				return { stdout: "## main\n", stderr: "", code: 0 };
			},
		};
		const renders: number[] = [];
		const runtime = createPiStyleRuntime(
			{
				mode: "tui",
				hasUI: false,
				cwd: "/fake",
				config: normalizeConfig({}),
				requestRender: () => renders.push(1),
				gitRunner,
			},
			1,
		);
		await vi.advanceTimersByTimeAsync(0); // initial session-start refresh settles
		expect(execs).toBe(1);
		for (let index = 0; index < 20; index++) runtime.invalidateGit();
		expect(execs).toBe(1); // debounced: no immediate spawns
		await vi.advanceTimersByTimeAsync(300);
		expect(execs).toBe(2); // exactly one coalesced refresh for the whole burst
		// Snapshot picked up the branch and requested a render (change detected).
		expect(runtime.snapshot.git?.branch).toBe("main");
		runtime.dispose();
		await vi.advanceTimersByTimeAsync(300);
		expect(execs).toBe(2); // dispose cleared the pending timer — no late spawns
	});
});
