import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetMessageDecorationTestState,
	setThoughtLabelTheme,
} from "../../extension-src/pi-style/features/messages/index.js";
import {
	attributeMessageToLatestGroup,
	beginAgentThoughtRun,
	finishAgentThoughtRun,
	rebuildAgentThoughtRunsFromEntries,
	refreshObservedThoughtComponents,
} from "../../extension-src/pi-style/features/messages/thought-summary.js";
import { closeActiveBatch, resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import { renderBoxedToolResult } from "../../extension-src/pi-style/features/tools/boxed/index.js";
import {
	__getElapsedTickerDebugState,
	getStateElapsedMs,
	recordExecutionStarted,
	setToolsRenderConfig,
	startElapsedTicker,
	stopAllElapsedTickers,
} from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import {
	beginAgentRun,
	finishAgentRun,
	getTurnEntry,
	invalidateRegisteredTurnMembers,
	invalidateTurnMembers,
	rebuildTurnRegistryFromEntries,
	registerTurnFromMessage,
	resetTurnRegistry,
} from "../../extension-src/pi-style/features/tools/boxed/turn-summary.js";
import {
	type CompatibilityProbeReport,
	disposePiCompatibilityProbe,
	probePiCompatibility,
} from "../../extension-src/pi-style/pi/compatibility-probe.js";
import { stripAnsi, visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";
import { mergedStatsFor, publishMessageStats } from "../../extension-src/pi-style/shared/turn-summary-bridge.js";

const snapshot = {
	assistantPrefix: "│ ",
	assistantEnabled: true,
	collapseHiddenThinking: true,
	thoughtSummary: true,
	mergedTurnSummary: true,
	thoughtGlyph: "◈",
} as const;

let report: CompatibilityProbeReport;
let sequence = 1000;
const ui = { requestRender: vi.fn(), terminal: { rows: 24 } };

beforeEach(() => {
	__resetMessageDecorationTestState();
	resetTurnRegistry();
	resetBatchRegistry();
	initTheme("dark", false);
	setThoughtLabelTheme({ fg: (_token, text) => text });
	setToolsRenderConfig({
		mergedTurnSummary: true,
		mergedSummaryGlyph: "◈",
		collapseAfterTurn: true,
		collapseMutatingTools: false,
		showElapsed: false,
		maxExpandedLines: 50,
	});
	report = probePiCompatibility("0.85.0", { messageSnapshot: snapshot, toolSnapshot: { style: "compact-box" } });
	expect(
		report.recordSnapshots.some((record) => record.subtype === "tool-call-renderer" && record.shape === "installed"),
	).toBe(true);
	beginAgentThoughtRun();
	beginAgentRun();
});

afterEach(() => {
	disposePiCompatibilityProbe(report);
	stopAllElapsedTickers();
	resetTurnRegistry();
	resetBatchRegistry();
	__resetMessageDecorationTestState();
	setToolsRenderConfig({ showElapsed: true, mergedTurnSummary: true });
	vi.useRealTimers();
});

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		stopReason: "toolUse",
		timestamp: sequence++,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function call(id: string, name = "read", args: Record<string, unknown> = { path: `${id}.ts` }) {
	return { type: "toolCall" as const, id, name, arguments: args };
}

function assistant(msg: AssistantMessage) {
	const component = new AssistantMessageComponent(undefined, true, undefined, "", 1);
	component.updateContent(msg, false);
	return component;
}

function tools(
	msg: AssistantMessage,
	overrides: Record<string, { isError?: boolean; details?: unknown }> = {},
	register = true,
) {
	closeActiveBatch();
	const components: ToolExecutionComponent[] = [];
	const results = [];
	for (const block of msg.content) {
		if (block.type !== "toolCall") continue;
		const result = {
			toolCallId: block.id,
			content: [{ type: "text", text: `payload_${block.id}\nsecond_${block.id}` }],
			details: overrides[block.id]?.details ?? {},
			isError: overrides[block.id]?.isError ?? false,
		};
		// An empty renderer definition deliberately exercises the certified
		// no-native-renderer fallback too (extension tools use this path).
		const component = new ToolExecutionComponent(block.name, block.id, block.arguments, {}, {}, ui as never, "/fake");
		component.updateResult(result);
		components.push(component);
		results.push(result);
	}
	if (register) {
		registerTurnFromMessage(msg, results);
		attributeMessageToLatestGroup(msg);
	}
	return { components, results };
}

function finish() {
	const run = finishAgentRun();
	if (run) for (const msg of run.messages ?? []) attributeMessageToLatestGroup(msg);
	finishAgentThoughtRun();
	if (run) invalidateTurnMembers(run);
	return run;
}

function rendered(component: { render(width: number): string[] }, width = 160): string {
	const lines = component.render(width);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	return stripAnsi(lines.join("\n"));
}

function clickSummary(component: AssistantMessageComponent) {
	const region = component.contentContainer.children.find((child) => rendered(child).includes("◈"));
	expect(region).toBeDefined();
	expect(region?.handleMouse?.({ type: "click", button: "left", x: 1, y: 0, width: 160, height: 1 } as never)).toEqual({
		handled: true,
	});
}

function expectHidden(components: readonly ToolExecutionComponent[]) {
	for (const component of components) expect(component.render(160)).toEqual([]);
}

describe("one coherent merged run disclosure (real native components)", () => {
	it("opens every text-split thought group and every batched/chunked tool, then closes all repeatedly", () => {
		const assistants: AssistantMessageComponent[] = [];
		const allTools: ToolExecutionComponent[] = [];
		for (let round = 0; round < 3; round++) {
			const msg = message([
				{ type: "thinking", thinking: `private_thought_${round}` },
				{ type: "text", text: `visible_progress_${round}` },
				call(`r${round}a`, "read", { path: "large.ts", offset: round * 4 + 1, limit: 2 }),
				call(`r${round}b`, "read", { path: "large.ts", offset: round * 4 + 3, limit: 2 }),
				call(`b${round}`, "bash", { command: `echo round_${round}` }),
			]);
			assistants.push(assistant(msg));
			allTools.push(...tools(msg).components);
		}
		finish();
		expectHidden(allTools);
		const transcript = assistants.map((comp) => rendered(comp)).join("\n");
		expect(transcript.match(/◈/g)).toHaveLength(3);
		expect(rendered(assistants[0])).toContain("◈ Thought 1 time · Called 3 tools");
		expect(rendered(assistants[1])).toContain("◈ Thought 2 times · Called 6 tools");
		expect(rendered(assistants[2])).toContain("◈ Thought 3 times · Called 9 tools");
		for (let cycle = 0; cycle < 3; cycle++) {
			// ANY cumulative label owns the whole-run disclosure — click the last.
			clickSummary(assistants[2]);
			for (let round = 0; round < 3; round++) expect(rendered(assistants[round])).toContain(`private_thought_${round}`);
			// A run click restores the compact presentation: six contiguous read
			// chunks stay on their one inline row, not six half-framed results.
			expect(rendered(allTools[0])).toContain("Read large.ts:1-12 · 6 chunks");
			for (const index of [1, 3, 4, 6, 7]) expect(allTools[index]?.render(160)).toEqual([]);
			for (const [index, id] of ["b0", "b1", "b2"].entries())
				expect(rendered(allTools[index * 3 + 2])).toContain(`payload_${id}`);
			expect(allTools.map((comp) => rendered(comp)).join("\n")).not.toMatch(/➔ Read \d+ files/);
			clickSummary(assistants[2]);
			expectHidden(allTools);
			for (let round = 0; round < 3; round++) {
				expect(rendered(assistants[round])).not.toContain(`private_thought_${round}`);
				expect(rendered(assistants[round])).toContain(`visible_progress_${round}`);
			}
		}
	});

	it("keeps read, list, find and grep in their compact styles after a run click", () => {
		const msg = message([
			{ type: "thinking", thinking: "inspect files" },
			call("read", "read", { path: "a.ts" }),
			call("list", "ls", { path: "." }),
			call("find", "find", { pattern: "*.ts" }),
			call("grep", "grep", { pattern: "needle" }),
		]);
		const comp = assistant(msg);
		const blocks = tools(msg).components;
		finish();
		expectHidden(blocks);
		clickSummary(comp);
		const transcript = blocks.map((block) => rendered(block)).join("\n");
		expect(transcript).toContain("Read a.ts");
		expect(transcript).toContain("List");
		expect(transcript).toContain("Find");
		expect(transcript).toContain("Grep:");
		expect(transcript).not.toContain("Response");
		expect(transcript).not.toContain("╰");
		clickSummary(comp);
		expectHidden(blocks);
	});

	it("collapses errors and mutations into the one stats row; opening reveals all of them", () => {
		const msg = message([
			{ type: "thinking", thinking: "examine_changes" },
			call("failed", "bash", { command: "false" }),
			call("edit", "edit", { path: "x.ts" }),
			call("write", "write", { path: "new.ts", content: "new content" }),
			call("custom", "extension_tool", {}),
		]);
		const comp = assistant(msg);
		const blocks = tools(msg, {
			failed: { isError: true },
			edit: { details: { diff: "+added_A\n+added_B\n-removed_C" } },
		}).components;
		finish();
		expectHidden(blocks);
		expect(rendered(comp)).toContain("◈ Thought 1 time · Called 4 tools · Edit +2 -1 · 1 failure");
		expect(rendered(comp)).not.toMatch(/\d+(?:\.\d+)?(?:ms|s)\b/);
		clickSummary(comp);
		for (const block of blocks) expect(block.render(160).length).toBeGreaterThan(0);
		expect(rendered(blocks[0])).toContain("payload_failed");
		expect(rendered(blocks[1])).toContain("added_A");
		expect(rendered(blocks[1])).toContain("removed_C");
		expect(rendered(blocks[2])).toContain("new content");
		expect(rendered(blocks[3])).toContain("payload_custom");
		clickSummary(comp);
		expectHidden(blocks);
	});

	it("native Ctrl+O collapse wins over a prior aggregate click-open", () => {
		const msg = message([{ type: "thinking", thinking: "reasoning" }, call("one"), call("two")]);
		const comp = assistant(msg);
		const blocks = tools(msg).components;
		finish();
		clickSummary(comp);
		expect(rendered(blocks[0])).toContain("Read (2)");
		expect(blocks[1]?.render(160)).toEqual([]);
		// Pi's global Ctrl+O calls the same public setter on every component.
		for (const block of blocks) block.setExpanded(false);
		expectHidden(blocks);
		for (const block of blocks) block.setExpanded(true);
		for (const [index, block] of blocks.entries())
			expect(rendered(block)).toContain(`payload_${index === 0 ? "one" : "two"}`);
		for (const block of blocks) block.setExpanded(false);
		expectHidden(blocks);
		// Thinking is independently native (Ctrl+T). The aggregate now closes
		// the remaining visible thoughts without re-opening any tool blocks.
		clickSummary(comp);
		expectHidden(blocks);
		expect(rendered(comp)).not.toContain("reasoning");
		clickSummary(comp);
		expect(rendered(blocks[0])).toContain("Read (2)");
		expect(blocks[1]?.render(160)).toEqual([]);
		clickSummary(comp);
		expectHidden(blocks);
	});

	it("closes an individually expanded native tool even if the run override was never open", () => {
		const msg = message([{ type: "thinking", thinking: "reasoning" }, call("one"), call("two")]);
		const comp = assistant(msg);
		const blocks = tools(msg).components;
		finish();
		blocks[1].setExpanded(true);
		expect(rendered(blocks[1])).toContain("payload_two");
		clickSummary(comp);
		expectHidden(blocks);
		expect(rendered(comp)).not.toContain("reasoning");
	});

	it("counts each message once even when it contributes multiple thinking segments", () => {
		const msg = message([
			{ type: "thinking", thinking: "first_reason" },
			{ type: "text", text: "commentary" },
			{ type: "thinking", thinking: "second_reason" },
			call("edit", "edit", { path: "x.ts" }),
		]);
		const comp = assistant(msg);
		const blocks = tools(msg, { edit: { details: { diff: "+a\n-b" } } }).components;
		finish();
		expect(rendered(comp)).toContain("◈ Thought 1 time · Called 1 tool · Edit +1 -1");
		expect(rendered(comp)).toContain("◈ Thought 2 times · Called 1 tool · Edit +1 -1");
		expect(rendered(comp).match(/◈/g)).toHaveLength(2);
		clickSummary(comp);
		expect(rendered(comp)).toContain("first_reason");
		expect(rendered(comp)).toContain("second_reason");
		clickSummary(comp);
		expectHidden(blocks);
		expect(rendered(comp)).not.toContain("first_reason");
		expect(rendered(comp)).not.toContain("second_reason");
	});
});

describe("attribution and replay", () => {
	it("keeps a single clickable ◈ fallback for tools-only/all-error runs", () => {
		const msg = message([call("failed_read"), call("failed_custom", "extension_tool", {})]);
		const blocks = tools(msg, { failed_read: { isError: true }, failed_custom: { isError: true } }).components;
		finish();
		expect(rendered(blocks[0])).toContain("◈ Called 2 tools · 2 failures");
		expect(rendered(blocks[0])).not.toContain("➔");
		expect(blocks[1].render(160)).toEqual([]);
		const click = () => {
			const lines = blocks[0].render(160);
			expect(
				blocks[0].handleMouse({
					type: "click",
					button: "left",
					x: 1,
					y: 1,
					screenX: 1,
					screenY: 1,
					width: 160,
					height: lines.length,
					shift: false,
					alt: false,
					ctrl: false,
				}),
			).toMatchObject({ handled: true });
		};
		click();
		expect(rendered(blocks[0])).toContain("payload_failed_read");
		expect(rendered(blocks[1])).toContain("payload_failed_custom");
		click();
		expect(blocks[1].render(160)).toEqual([]);
		expect(rendered(blocks[0])).not.toContain("payload_failed_read");
		expect(rendered(blocks[0])).toContain("◈ Called 2 tools · 2 failures");
		setToolsRenderConfig({ mergedSummaryGlyph: ">" });
		expect(rendered(blocks[0])).toContain("> Called 2 tools · 2 failures");
	});

	it("does not count an error result's unapplied diff", () => {
		const msg = message([{ type: "thinking", thinking: "reasoning" }, call("failed_edit", "edit", { path: "x.ts" })]);
		const comp = assistant(msg);
		tools(msg, { failed_edit: { isError: true, details: { diff: "+never_applied" } } });
		finish();
		expect(rendered(comp)).toContain("◈ Thought 1 time · Called 1 tool · 1 failure");
		expect(rendered(comp)).not.toContain("Edit +");
	});

	it("deduplicates bridge input identities", () => {
		const msg = {};
		publishMessageStats(msg, { calls: 2, failed: 1, diff: { additions: 4, removals: 2 } });
		expect(mergedStatsFor([msg, msg])).toEqual({ calls: 2, failed: 1, diff: { additions: 4, removals: 2 } });
	});

	it("replays tools-first and thinking-less continuations onto one correct run label", () => {
		const first = message([call("before")]);
		const middle = message([{ type: "thinking", thinking: "reasoning" }, call("during")]);
		const last = message([call("after", "bash", { command: "echo done" })]);
		const entries = [
			{ type: "message", message: { role: "user", content: [] } },
			...[first, middle, last].flatMap((msg) => [
				{ type: "message", message: msg },
				...msg.content
					.filter((block) => block.type === "toolCall")
					.map((block) => ({
						type: "message",
						message: { role: "toolResult", toolCallId: block.id, content: [], isError: false },
					})),
			]),
		];
		rebuildTurnRegistryFromEntries(entries);
		rebuildAgentThoughtRunsFromEntries(entries);
		const comp = assistant(middle);
		expect(rendered(comp)).toContain("◈ Thought 1 time · Called 3 tools");
		const blocks = [first, middle, last].flatMap((msg) => tools(msg, {}, false).components);
		expectHidden(blocks);
		const previous = getTurnEntry("before")?.turn;
		// Rebuild again using exactly the same message identities: no stale turns.
		rebuildTurnRegistryFromEntries(entries);
		rebuildAgentThoughtRunsFromEntries(entries);
		refreshObservedThoughtComponents();
		invalidateRegisteredTurnMembers();
		expectHidden(blocks);
		const current = getTurnEntry("before")?.turn;
		clickSummary(comp);
		expect(current?.forcedOpen).toBe(true);
		expect(previous?.forcedOpen).toBe(false);
		expect(rendered(blocks[0])).toContain("before.ts");
		expect(rendered(blocks[2])).toContain("payload_after");
		clickSummary(comp);
		expectHidden(blocks);
	});

	it("never attributes a new tools-only run to the previous request's thought group", () => {
		const prior = message([{ type: "thinking", thinking: "prior_reasoning" }, call("old")]);
		const priorComp = assistant(prior);
		tools(prior);
		finish();
		const previousLabel = rendered(priorComp);
		beginAgentThoughtRun();
		beginAgentRun();
		const next = message([call("new")]);
		expect(attributeMessageToLatestGroup(next)).toBe(false);
		const blocks = tools(next).components;
		finish();
		expect(rendered(priorComp)).toBe(previousLabel);
		expect(rendered(blocks[0])).toContain("◈ Called 1 tool");
		expect(rendered(blocks[0])).not.toContain("➔");
	});

	it("does not attribute native Ctrl+T refreshes of prior messages to the active request", () => {
		const oldMsg = message([{ type: "thinking", thinking: "old" }, call("old_refresh")]);
		const oldComp = assistant(oldMsg);
		tools(oldMsg);
		finish();
		beginAgentRun();
		beginAgentThoughtRun();
		const nextMsg = message([{ type: "thinking", thinking: "next" }, call("new_refresh")]);
		const nextComp = assistant(nextMsg);
		tools(nextMsg);
		// Pi's global thinking toggle rebuilds historical components too.
		oldComp.setHideThinkingBlock(false);
		finish();
		expect(rendered(nextComp)).toContain("◈ Thought 1 time · Called 1 tool");
		expect(rendered(nextComp)).not.toContain("Called 2 tools");
	});

	it("replaced components cannot retain an old expanded thinking override", () => {
		const msg = message([{ type: "thinking", thinking: "private_reason" }, call("read")]);
		const original = assistant(msg);
		const blocks = tools(msg).components;
		finish();
		clickSummary(original);
		const replacement = assistant(msg);
		// New native component starts collapsed, regardless of the old instance.
		expect(rendered(replacement)).not.toContain("private_reason");
		for (const block of blocks) block.setExpanded(false);
		clickSummary(replacement);
		expect(rendered(replacement)).toContain("private_reason");
		clickSummary(replacement);
		expect(rendered(replacement)).not.toContain("private_reason");
		expectHidden(blocks);
	});
});

describe("terminal cleanup through the collapse gate", () => {
	it("stops a hidden tool's elapsed ticker and freezes its clock at terminal render", () => {
		vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
		const msg = message([call("timer", "bash", { command: "echo done" })]);
		registerTurnFromMessage(msg, [{ toolCallId: "timer", isError: false }]);
		finishAgentRun();
		const state: Record<string, unknown> = {};
		recordExecutionStarted(state, true);
		startElapsedTicker(state, () => {});
		expect(__getElapsedTickerDebugState().trackedStates).toBe(1);
		vi.advanceTimersByTime(200);
		renderBoxedToolResult(
			"bash",
			{ content: [], details: {} },
			{ expanded: false, isPartial: false },
			{ fg: (_token, text) => text },
			{
				args: {},
				toolCallId: "timer",
				state,
				cwd: "/fake",
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
				lastComponent: undefined,
				invalidate() {},
			},
		);
		expect(__getElapsedTickerDebugState()).toEqual({ trackedStates: 0, hasSharedTicker: false });
		expect(getStateElapsedMs(state)).toBe(200);
		vi.advanceTimersByTime(60_000);
		// The terminal clock stays frozen even though no per-tool renderer ran.
		expect(getStateElapsedMs(state)).toBe(200);
	});
});
