import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeActiveBatch,
	resetBatchRegistry,
	resetReadChunkCandidates,
} from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import {
	renderBoxedToolCall as dispatchCall,
	renderBoxedToolResult as dispatchResult,
} from "../../extension-src/pi-style/features/tools/boxed/index.js";
import { setToolsRenderConfig } from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import { stripAnsi } from "../../extension-src/pi-style/shared/ansi.js";
import { createFakeTheme } from "../helpers/fake-theme.js";
import { expectLinesFit } from "../helpers/render-assertions.js";

const theme = createFakeTheme();

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

function textResult(text: string) {
	return { content: [{ type: "text", text }], details: {} };
}

function readCall(path: string, id: string, extra: Partial<BoxedToolContext> = {}) {
	const ctx = context({ toolCallId: id, args: { path }, cwd: "/fake", ...extra });
	return { ctx, component: dispatchCall("read", { path }, theme, ctx) };
}

/** Sequential same-file chunk read (offset+limit) — the large-file pattern. */
function chunkCall(path: string, id: string, offset?: number, limit?: number, extra: Partial<BoxedToolContext> = {}) {
	const args: Record<string, unknown> = {
		path,
		...(offset !== undefined ? { offset } : {}),
		...(limit !== undefined ? { limit } : {}),
	};
	const ctx = context({ toolCallId: id, args, cwd: "/fake", ...extra });
	return { ctx, component: dispatchCall("read", args, theme, ctx) };
}

/** Settled read result with truncation details (actual output line count). */
function chunkResult(id: string, path: string, outputLines: number, extra: Partial<BoxedToolContext> = {}) {
	const ctx = context({ toolCallId: id, args: { path }, cwd: "/fake", ...extra });
	return {
		ctx,
		component: dispatchResult(
			"read",
			{ content: [{ type: "text", text: "line\n".repeat(outputLines) }], details: { truncation: { outputLines } } },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		),
	};
}

function readResult(id: string, path: string, text: string, extra: Partial<BoxedToolContext> = {}) {
	const ctx = context({ toolCallId: id, args: { path }, cwd: "/fake", ...extra });
	return {
		ctx,
		component: dispatchResult("read", textResult(text), { expanded: false, isPartial: false }, theme, ctx),
	};
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripAnsi(line));
}

afterEach(() => {
	resetBatchRegistry();
});

describe("batch grouping for quiet tools", () => {
	it("groups consecutive reads into one panel; members render zero lines", () => {
		const r1 = readCall("a.ts", "r1");
		const r2 = readCall("b.ts", "r2");

		// Non-leader member renders nothing at all widths.
		for (const width of [40, 80, 120]) {
			expect(r2.component.render(width)).toEqual([]);
		}

		const lines = r1.component.render(80);
		const joined = plain(lines).join("\n");
		expect(joined).toContain("Read (2)");
		expect(joined).toContain("a.ts");
		expect(joined).toContain("b.ts");
		expectLinesFit(lines, 80);
	});

	it("a lone read renders a single inline line", () => {
		const r1 = readCall("a.ts", "r1");
		const pending = plain(r1.component.render(80)).join("\n");
		expect(pending).toContain("➔ Read ◌ a.ts");
		expect(pending).not.toContain("(1)");
		expect(pending).not.toContain("└─");
		expect(pending).not.toContain("╭");
		expect(pending).not.toContain("Path:");
		// After the result: done inline line, still boxless.
		readResult("r1", "a.ts", "hello world");
		const done = plain(r1.component.render(80)).join("\n");
		expect(done).toContain("➔ Read a.ts");
		expect(done).not.toContain("└─");
		expect(done).not.toContain("╭");
	});

	it("tracks progress and completes with a ✓ summary and word totals", () => {
		const r1 = readCall("a.ts", "r1");
		readCall("b.ts", "r2");

		// Leader result arrives first: running state with progress.
		const r1Result = readResult("r1", "a.ts", "hello world");
		expect(r1Result.component.render(80)).toEqual([]); // panel lives in the call component
		let joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("Read (2)");
		expect(joined).toContain("1/2");
		expect(joined).toContain("a.ts");
		expect(joined).toContain("b.ts");

		// Second member completes: done state, tree stays open.
		readResult("r2", "b.ts", "some more words here");
		joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("● Read (2)");
		// Elapsed is real wall time (performance.now), so only the format is asserted.
		expect(joined).toMatch(/● Read \(2\) · \d+\.\d{2}s/);
		expect(joined).toContain("├─ a.ts"); // tree kept open after completion
		expect(joined).toContain("└─ b.ts");
	});

	it("keeps the tree open in every state (no collapsed summary)", () => {
		const r1 = readCall("a.ts", "r1");
		readCall("b.ts", "r2");
		readResult("r1", "one");
		readResult("r2", "two");
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("● Read (2)");
		expect(joined).toContain("├─ a.ts");
		expect(joined).toContain("└─ b.ts");
	});

	it("renders the member tree with no word-count metadata", () => {
		const r1 = readCall("a.ts", "r1");
		readCall("b.ts", "r2");
		readResult("r1", "a.ts", "hello world");
		readResult("r2", "b.ts", "short");
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("● Read (2)");
		expect(joined).toContain("├─ a.ts");
		expect(joined).toContain("└─ b.ts");
		expect(joined).not.toContain("words");
	});

	it("colors successful reads with the primary (accent) color and failures red", () => {
		const rich = createFakeTheme({ colors: { accent: "#8abeb7", error: "#ff4444" } });
		const c1 = context({ toolCallId: "r1", args: { path: "a.ts" }, cwd: "/fake" });
		const leader = dispatchCall("read", { path: "a.ts" }, rich, c1);
		dispatchCall("read", { path: "b.ts" }, rich, context({ toolCallId: "r2", args: { path: "b.ts" }, cwd: "/fake" }));
		dispatchResult(
			"read",
			textResult("ok"),
			{ expanded: false, isPartial: false },
			rich,
			context({ toolCallId: "r1", args: { path: "a.ts" }, cwd: "/fake" }),
		);
		dispatchResult(
			"read",
			textResult("denied"),
			{ expanded: false, isPartial: false },
			rich,
			context({ toolCallId: "r2", args: { path: "b.ts" }, cwd: "/fake", isError: true }),
		);
		const raw = leader.render(80).join("\n");
		expect(raw).toContain("\x1b[38;2;138;190;183m"); // accent = primary for the ok file
		expect(raw).toContain("\x1b[38;2;255;68;68m"); // error red for the failed file
	});

	it("caps the tree at 5 members with a 'N more' line", () => {
		const first = readCall("f1.ts", "r1");
		for (let i = 2; i <= 7; i++) readCall(`f${i}.ts`, `r${i}`);
		const joined = plain(first.component.render(80)).join("\n");
		expect(joined).toContain("Read (7)");
		expect(joined.match(/├─|└─/g) ?? []).toHaveLength(6); // 5 members + "2 more"
		expect(joined).toContain("2 more");
		expect(joined).not.toContain("f6.ts");
	});

	it("keeps failed members visible with their error text, even collapsed", () => {
		const r1 = readCall("a.ts", "r1");
		readCall("b.ts", "r2");
		readResult("r1", "a.ts", "ok words here");
		const failed = readResult("r2", "b.ts", "Permission denied", { isError: true });

		// Leader result for the failed member is the batch panel leader rendering nothing.
		expect(failed.component.render(80)).toEqual([]);
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("✗ Read (2) · 1 failed");
		expect(joined).toContain("✗ b.ts");
		expect(joined).toContain("Permission denied");
		expect(joined).toContain("1 failed");
		expectLinesFit(r1.component.render(80), 80);
	});

	it("renders the success header for a batch where all members settled", () => {
		const r1 = readCall("a.ts", "r1");
		readCall("b.ts", "r2");
		readResult("r1", "a.ts", "x");
		readResult("r2", "b.ts", "y");
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toMatch(/● Read \(2\) · \d+\.\d{2}s/);
	});

	it("a non-batchable tool dispatch closes the batch", () => {
		readCall("a.ts", "r1");
		readCall("b.ts", "r2");
		dispatchCall("bash", { command: "ls" }, theme, context({ toolCallId: "bash1" }));
		// A later read starts a fresh single-member batch (own inline line).
		const r3 = readCall("c.ts", "r3");
		const lines = plain(r3.component.render(80)).join("\n");
		expect(lines).toContain("➔ Read ◌ c.ts");
		expect(lines).not.toContain("(1)");
	});

	it("closeActiveBatch prevents further joins but keeps the panel rendering", () => {
		const r1 = readCall("a.ts", "r1");
		readCall("b.ts", "r2");
		closeActiveBatch();
		readCall("c.ts", "r3");
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("Read (2)");
		expect(joined).not.toContain("c.ts");
	});

	it("groups consecutive ls calls under the List label", () => {
		const l1 = context({ toolCallId: "l1", args: { path: "src" }, cwd: "/fake", expanded: false });
		const l2 = context({ toolCallId: "l2", args: { path: "test" }, cwd: "/fake", expanded: false });
		const leaderCall = dispatchCall("ls", { path: "src" }, theme, l1);
		dispatchCall("ls", { path: "test" }, theme, l2);
		dispatchResult("ls", textResult("index.ts\nmain.ts"), { expanded: false, isPartial: false }, theme, l1);
		dispatchResult("ls", textResult("spec.ts"), { expanded: false, isPartial: false }, theme, l2);
		const joined = plain(leaderCall.render(80)).join("\n");
		expect(joined).toContain("● List (2)");
		expect(joined).toContain("src");
		expect(joined).toContain("test");
	});

	it("mixes different batchable tools into separate batches", () => {
		const r1 = readCall("a.ts", "r1");
		const l1 = context({ toolCallId: "l1", args: { path: "src" }, cwd: "/fake" });
		const lsCall = dispatchCall("ls", { path: "src" }, theme, l1);
		const r2 = readCall("b.ts", "r2");
		// The read between/before ls forms its own single batch; the ls is separate.
		const joinedLs = plain(lsCall.component?.render?.(80) ?? lsCall.render(80)).join("\n");
		expect(joinedLs).toContain("List");
		const joinedR1 = plain(r1.component.render(80)).join("\n");
		expect(joinedR1).not.toContain("List");
		expect(plain(r2.component.render(80)).join("\n")).toContain("b.ts");
	});
});

describe("chunk-merge for sequential same-file reads (ADR 0010)", () => {
	it.each([
		[null, null, ""],
		[undefined, undefined, ""],
		[null, "5", ":1-5"],
		["10", null, ":10"],
		["10", "5", ":10-14"],
		["bad", 5, ""],
		[10, "", ""],
		[10, Number.POSITIVE_INFINITY, ""],
		[false, 5, ""],
	] as const)("formats Pi 1.3 optional read arguments (%s, %s)", (offset, limit, range) => {
		const args = { path: "a.ts", offset, limit };
		const ctx = context({ args, expanded: true });
		const call = dispatchCall("read", args, theme, ctx);
		expect(plain(call.render(80)).join("\n")).toContain(`a.ts${range}`);
		if (!range) expect(plain(call.render(80)).join("\n")).not.toContain("a.ts:");
	});

	it("uses numeric-string coordinates when merging read chunks", () => {
		const args = { path: "a.ts", offset: "10", limit: "5" };
		const ctx = context({ toolCallId: "r1", args });
		const first = dispatchCall("read", args, theme, ctx);
		chunkResult("r1", "a.ts", 5);
		closeActiveBatch();
		const second = chunkCall("a.ts", "r2", 15, 5);
		expect(second.component.render(80)).toEqual([]);
		chunkResult("r2", "a.ts", 5);
		expect(plain(first.render(80)).join("\n")).toContain("a.ts:10-19");
		expect(plain(first.render(80)).join("\n")).toContain("2 chunks");
	});

	it("merges continuation chunks across message boundaries into one expanding line", () => {
		const r1 = chunkCall("chat.ts", "r1", 525, 180);
		chunkResult("r1", "chat.ts", 180);
		// New assistant message: the active batch closes, but the next chunk of
		// the same file still merges into the leader's expanding line.
		closeActiveBatch();
		const r2 = chunkCall("chat.ts", "r2", 705, 180);
		expect(r2.component.render(80)).toEqual([]); // member renders zero lines

		let joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("➔ Read ◌ chat.ts:525-884 · 1/2");
		expect(joined).not.toContain("└─");

		chunkResult("r2", "chat.ts", 180);
		joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toMatch(/➔ Read chat\.ts:525-884 · 2 chunks( · \d+\.\d{2}s)?/);
		expect(joined).not.toContain("├─");
		expectLinesFit(r1.component.render(80), 80);
	});

	it("refines chunk ends from truncation output lines (byte-capped reads)", () => {
		// Requested 500 lines, but the byte cap truncated the output to 180.
		const r1 = chunkCall("a.ts", "r1", 525, 500);
		chunkResult("r1", "a.ts", 180);
		closeActiveBatch();
		// The model continues from the ACTUAL end (704), not the requested one.
		chunkCall("a.ts", "r2", 705, 100);
		chunkResult("r2", "a.ts", 100);
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("a.ts:525-804");
	});

	it("merges offset-only continuation reads and counts complete-read lines", () => {
		// First chunk: no offset/limit (read from the top), truncated at 2000.
		const r1 = chunkCall("a.ts", "r1");
		chunkResult("r1", "a.ts", 2000);
		closeActiveBatch();
		// Continuation without limit; result is complete (no truncation details)
		// with 300 text lines and no continuation notice.
		chunkCall("a.ts", "r2", 2001);
		const ctx = context({ toolCallId: "r2", args: { path: "a.ts", offset: 2001 }, cwd: "/fake" });
		dispatchResult(
			"read",
			{ content: [{ type: "text", text: "line\n".repeat(300).trimEnd() }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("a.ts:1-2300");
		expect(joined).toContain("2 chunks");
	});

	it("a non-contiguous re-read of the same file stays its own line", () => {
		const r1 = chunkCall("a.ts", "r1", 1, 50);
		chunkResult("r1", "a.ts", 50);
		closeActiveBatch();
		const r2 = chunkCall("a.ts", "r2", 200, 50);
		const r2Lines = plain(r2.component.render(80)).join("\n");
		expect(r2Lines).toContain("➔ Read ◌ a.ts:200-249");
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("➔ Read a.ts:1-50");
		expect(joined).not.toContain("chunk");
	});

	it("a non-read tool between chunks does not break the merge", () => {
		const r1 = chunkCall("a.ts", "r1", 1, 100);
		chunkResult("r1", "a.ts", 100);
		dispatchCall("bash", { command: "wc -l a.ts" }, theme, context({ toolCallId: "bash1" }));
		const r2 = chunkCall("a.ts", "r2", 101, 100);
		chunkResult("r2", "a.ts", 100);
		expect(r2.component.render(80)).toEqual([]);
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("a.ts:1-200 · 2 chunks");
	});

	it("a mixed-path batch loses chunk candidacy for its files", () => {
		// Same-message reads of two files form a standard panel (not chunked).
		const r1 = readCall("a.ts", "r1");
		readCall("b.ts", "r2");
		closeActiveBatch();
		// A later continuation of a.ts cannot merge into the mixed batch.
		const r3 = chunkCall("a.ts", "r3", 1, 100);
		const r3Lines = plain(r3.component.render(80)).join("\n");
		expect(r3Lines).toContain("➔ Read ◌ a.ts:1-100");
		const joined = plain(r1.component.render(80)).join("\n");
		expect(joined).toContain("Read (2)");
		expect(joined).not.toContain("chunk");
	});

	it("keeps a failed chunk visible with its error text in the merged line", () => {
		const r1 = chunkCall("a.ts", "r1", 1, 100);
		chunkResult("r1", "a.ts", 100);
		closeActiveBatch();
		chunkCall("a.ts", "r2", 101, 100);
		const ctx = context({ toolCallId: "r2", args: { path: "a.ts" }, cwd: "/fake", isError: true });
		dispatchResult(
			"read",
			{ content: [{ type: "text", text: "Permission denied" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const joined = plain(r1.component.render(120)).join("\n");
		expect(joined).toContain("➔ Read ✗ a.ts:1-200 · 2 chunks · 1 failure");
		expect(joined).toContain("Permission denied");
	});

	it("resetReadChunkCandidates breaks sequences across agent runs", () => {
		chunkCall("a.ts", "r1", 1, 100);
		chunkResult("r1", "a.ts", 100);
		resetReadChunkCandidates(); // new agent run
		const r2 = chunkCall("a.ts", "r2", 101, 100);
		const r2Lines = plain(r2.component.render(80)).join("\n");
		expect(r2Lines).toContain("➔ Read ◌ a.ts:101-200");
	});

	it("tools.mergeChunkedReads: off disables merging", () => {
		setToolsRenderConfig({ mergeChunkedReads: false });
		try {
			const r1 = chunkCall("a.ts", "r1", 1, 100);
			chunkResult("r1", "a.ts", 100);
			closeActiveBatch();
			const r2 = chunkCall("a.ts", "r2", 101, 100);
			const r2Lines = plain(r2.component.render(80)).join("\n");
			expect(r2Lines).toContain("➔ Read ◌ a.ts:101-200");
			expect(plain(r1.component.render(80)).join("\n")).not.toContain("chunk");
		} finally {
			setToolsRenderConfig({ mergeChunkedReads: true });
		}
	});
});

describe("Ctrl+O expansion bypasses the batch panel", () => {
	it("every member renders its own standalone line with full output when expanded", () => {
		const r1 = readCall("a.ts", "r1", { expanded: true });
		const r2 = readCall("b.ts", "r2", { expanded: true });

		// Both members render one visible row each — no zero-height members.
		const l1 = plain(r1.component.render(80)).join("\n");
		const l2 = plain(r2.component.render(80)).join("\n");
		expect(l1).toContain("Read");
		expect(l1).toContain("a.ts");
		expect(l2).toContain("Read");
		expect(l2).toContain("b.ts");

		// Result pass while expanded renders the full output per member.
		const out1 = dispatchResult("read", textResult("alpha\nbeta"), { expanded: true, isPartial: false }, theme, r1.ctx);
		const out2 = dispatchResult("read", textResult("gamma"), { expanded: true, isPartial: false }, theme, r2.ctx);
		const o1 = plain(out1.render(80)).join("\n");
		const o2 = plain(out2.render(80)).join("\n");
		expect(o1).toContain("alpha");
		expect(o1).toContain("beta");
		expect(o2).toContain("gamma");
	});

	it("collapsing again restores the shared batch panel", () => {
		const r1 = readCall("a.ts", "r1", { expanded: true });
		const r2 = readCall("b.ts", "r2", { expanded: true });
		dispatchResult("read", textResult("alpha"), { expanded: true, isPartial: false }, theme, r1.ctx);
		dispatchResult("read", textResult("beta"), { expanded: true, isPartial: false }, theme, r2.ctx);

		// Re-render with expansion off: members hide, the leader shows the panel.
		const collapsed1 = dispatchCall(
			"read",
			{ path: "a.ts" },
			theme,
			context({ toolCallId: "r1", args: { path: "a.ts" } }),
		);
		const collapsed2 = dispatchCall(
			"read",
			{ path: "b.ts" },
			theme,
			context({ toolCallId: "r2", args: { path: "b.ts" } }),
		);
		expect((collapsed2 as Component).render(80)).toEqual([]);
		const panel = plain((collapsed1 as Component).render(80)).join("\n");
		expect(panel).toContain("Read (2)");
		expect(panel).toContain("a.ts");
		expect(panel).toContain("b.ts");
	});

	it("expanded ls members render their listings instead of hiding", () => {
		const l1 = context({ toolCallId: "x1", args: { path: "src" }, cwd: "/fake", expanded: true });
		const l2 = context({ toolCallId: "x2", args: { path: "test" }, cwd: "/fake", expanded: true });
		const c1 = dispatchCall("ls", { path: "src" }, theme, l1);
		const c2 = dispatchCall("ls", { path: "test" }, theme, l2);
		expect(plain((c2 as Component).render(80)).join("\n")).toContain("test");
		const out = dispatchResult("ls", textResult("index.ts\nmain.ts"), { expanded: true, isPartial: false }, theme, l2);
		expect(plain((out as Component).render(80)).join("\n")).toContain("main.ts");
		void c1;
	});
});
