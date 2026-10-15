// Merged thought+tool summary line (`messages.mergedTurnSummary`).
//
// The bridge (shared/turn-summary-bridge.ts) attributes each assistant
// message's tool stats to the thought segments covering it; the segment
// leader renders `◈ Thought N times · Called M tools · …` and the ended
// run's `➔` leader defers to it. These tests cover the bridge contracts,
// the label format, and the dispatcher hide/keep decision.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { decorateMessageUpdate, setThoughtLabelTheme } from "../../extension-src/pi-style/features/messages/index.js";
import {
	beginAgentThoughtRun,
	finishAgentThoughtRun,
} from "../../extension-src/pi-style/features/messages/thought-summary.js";
import { renderBoxedToolCall as dispatchCall } from "../../extension-src/pi-style/features/tools/boxed/index.js";
import { setToolsRenderConfig } from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import {
	beginAgentRun,
	finishAgentRun,
	rebuildTurnRegistryFromEntries,
	registerTurnFromMessage,
	resetTurnRegistry,
} from "../../extension-src/pi-style/features/tools/boxed/turn-summary.js";
import { stripAnsi } from "../../extension-src/pi-style/shared/ansi.js";
import type { BoxTheme } from "../../extension-src/pi-style/shared/box.js";
import {
	everyMessageInEndedGroup,
	mergedStatsFor,
	publishEndedGroupMessage,
	publishMessageStats,
} from "../../extension-src/pi-style/shared/turn-summary-bridge.js";
import { createFakeTheme } from "../helpers/fake-theme.js";

const theme = createFakeTheme();
const plainTheme: BoxTheme = { fg: (_color, text) => text };

const MERGED_SNAPSHOT = {
	assistantPrefix: "│ ",
	assistantEnabled: true,
	collapseHiddenThinking: true,
	thoughtSummary: true,
	mergedTurnSummary: true,
	thoughtGlyph: "◈",
} as const;

function toolContext(id: string, overrides: Partial<BoxedToolContext> = {}): BoxedToolContext {
	return {
		args: {},
		toolCallId: id,
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

function baseMessage(
	content: AssistantMessage["content"],
	timestamp = 1,
): ConstructorParameters<typeof AssistantMessageComponent>[0] {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

function rendered(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(100).join("\n"));
}

afterEach(() => {
	resetTurnRegistry();
	setToolsRenderConfig({ mergedTurnSummary: true });
});

describe("turn-summary bridge", () => {
	it("combines stats across the messages a segment covers", () => {
		const a = {};
		const b = {};
		const c = {};
		publishMessageStats(a, { calls: 3, failed: 1, diff: { additions: 4, removals: 2 } });
		publishMessageStats(b, { calls: 2, failed: 0 });
		expect(mergedStatsFor([a, b, c])).toEqual({ calls: 5, failed: 1, diff: { additions: 4, removals: 2 } });
		expect(mergedStatsFor([c])).toBeUndefined();
	});

	it("reports full attribution only when every message belongs to an ended segment", () => {
		const a = {};
		const b = {};
		publishEndedGroupMessage(a);
		expect(everyMessageInEndedGroup([a])).toBe(true);
		expect(everyMessageInEndedGroup([a, b])).toBe(false);
		expect(everyMessageInEndedGroup(undefined)).toBe(false);
		expect(everyMessageInEndedGroup([])).toBe(false);
	});
});

describe("merged label format", () => {
	it("renders `◈ Thought N times · Called M tools · …` for a segment with tools", () => {
		initTheme("dark", false);
		setThoughtLabelTheme(plainTheme);
		// The assistant message carries its thinking run AND its tool calls.
		const message = baseMessage([
			{ type: "thinking", thinking: "deliberate" },
			{ type: "toolCall", id: "t1", name: "edit", arguments: {} },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		]);
		const comp = new AssistantMessageComponent(message, true, undefined, "", 1);
		beginAgentThoughtRun();
		beginAgentRun();
		// Live pass: observes the message and binds its thinking run.
		decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, comp, [message, false], MERGED_SNAPSHOT);
		registerTurnFromMessage(message, [
			{ toolCallId: "t1", isError: false, content: [], details: { diff: "+a\n+b\n+c\n+d\n-x\n-y" } },
			{ toolCallId: "t2", isError: false, content: [] },
		]);
		finishAgentRun(); // publishes the message's stats to the bridge
		finishAgentThoughtRun(); // ends the segment; production re-decorates via the patch
		decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, comp, [message, false], MERGED_SNAPSHOT);
		const text = rendered(comp);
		expect(text).toContain("◈ Thought 1 time · Called 2 tools");
		expect(text).toContain("Edit +4 -2");
	});

	it("omits the Called part entirely when the run produced no tools", () => {
		initTheme("dark", false);
		setThoughtLabelTheme(plainTheme);
		// Distinct timestamp: registry keys derive from message identity
		// signatures, so this test's message must not alias the previous one's.
		const message = baseMessage([{ type: "thinking", thinking: "deliberate alone" }], 2);
		const comp = new AssistantMessageComponent(message, true, undefined, "", 1);
		beginAgentThoughtRun();
		decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, comp, [message, false], MERGED_SNAPSHOT);
		finishAgentThoughtRun();
		decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, comp, [message, false], MERGED_SNAPSHOT);
		expect(rendered(comp)).toContain("◈ Thought 1 time");
		expect(rendered(comp)).not.toContain("Called");
	});
});

describe("dispatcher defers the ➔ leader to merged labels", () => {
	it("hides the leader when every run message belongs to an ended segment", () => {
		const assistant = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] };
		rebuildTurnRegistryFromEntries([
			{ type: "message", message: { role: "user", content: "q" } },
			{ type: "message", message: assistant },
			{ type: "message", message: { role: "toolResult", toolCallId: "t1", isError: false } },
			{ type: "message", message: { role: "user", content: "next" } },
		]);
		publishEndedGroupMessage(assistant);
		const leader = dispatchCall("read", { path: "a.ts" }, theme, toolContext("t1"));
		expect(leader.render(80)).toEqual([]);
	});

	it("uses the same ◈ format for tools-only runs and preserves the opt-out legacy format", () => {
		const assistant = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] };
		rebuildTurnRegistryFromEntries([
			{ type: "message", message: { role: "user", content: "q" } },
			{ type: "message", message: assistant },
			{ type: "message", message: { role: "toolResult", toolCallId: "t1", isError: false } },
			{ type: "message", message: { role: "user", content: "next" } },
		]);
		const kept = dispatchCall("read", { path: "a.ts" }, theme, toolContext("t1"));
		expect(kept.render(80).length).toBeGreaterThan(0);
		expect(stripAnsi(kept.render(80).join("\n"))).toContain("◈ Called 1 tool");
		expect(stripAnsi(kept.render(80).join("\n"))).not.toContain("➔");

		publishEndedGroupMessage(assistant);
		setToolsRenderConfig({ mergedTurnSummary: false });
		const configOff = dispatchCall("read", { path: "a.ts" }, theme, toolContext("t1"));
		expect(configOff.render(80).length).toBeGreaterThan(0);
		expect(stripAnsi(configOff.render(80).join("\n"))).toContain("➔ Read");
	});
});
