import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { registerTeammateMessageRenderers } from "../../extension-src/pi-style/features/messages/teammates.js";
import { closeActiveBatch, resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import { renderBoxedToolCall, renderBoxedToolResult } from "../../extension-src/pi-style/features/tools/boxed/index.js";
import { setToolsRenderConfig } from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext, BoxedToolResult } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import {
	rebuildTeammateRuns,
	resetTeammateRuns,
	settleTeammateRun,
	teammateColorForRun,
	teammateForRun,
} from "../../extension-src/pi-style/features/tools/boxed/team-run-labels.js";
import {
	beginAgentRun,
	finishAgentRun,
	registerTurnFromMessage,
	resetTurnRegistry,
} from "../../extension-src/pi-style/features/tools/boxed/turn-summary.js";
import { createToolDecorationOwner } from "../../extension-src/pi-style/features/tools/index.js";
import { registerTeammateToolRenderers } from "../../extension-src/pi-style/pi/teammate-tool-renderers.js";
import { stripAnsi } from "../../extension-src/pi-style/shared/ansi.js";
import { createFakeTheme } from "../helpers/fake-theme.js";
import { expectLinesFit } from "../helpers/render-assertions.js";

const theme = createFakeTheme();
const plain = (lines: string[]): string[] => lines.map(stripAnsi);
const result = (text: string, details: unknown = {}) => ({ content: [{ type: "text", text }], details });
function context(id: string, args: Record<string, unknown>): BoxedToolContext {
	return {
		args,
		toolCallId: id,
		state: {},
		cwd: "/fake",
		invalidate() {},
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
	};
}
function call(name: string, id: string, args: Record<string, unknown>, palette = theme) {
	const ctx = context(id, args);
	return { ctx, component: renderBoxedToolCall(name, args, palette, ctx) };
}
afterEach(() => {
	resetCapabilitiesCache();
	closeActiveBatch();
	resetBatchRegistry();
	resetTeammateRuns();
	resetTurnRegistry();
	setToolsRenderConfig({ nerdFonts: false, glyphMode: "unicode", collapseAfterTurn: false, mergedSummaryGlyph: "◈" });
});

describe("pi-teams tool presentation", () => {
	it("renders one Agent inline, without guessing omitted mode/model/max turns", () => {
		const a = call("Agent", "a", { name: "fe-fleet", description: "Find frontend entrypoints" });
		const text = plain(a.component.render(120)).join("\n");
		expect(text).toContain("◌ Agent @fe-fleet · Find frontend entrypoints");
		expect(text).not.toContain("background");
		expect(text).not.toContain("max 30");
		renderBoxedToolResult(
			"Agent",
			result("{agent:run-1 started}", { agentId: "run-1", background: true }),
			{ expanded: false, isPartial: false },
			theme,
			a.ctx,
		);
		expect(plain(a.component.render(120))[0]).toContain("◌ Agent @fe-fleet");
		expectLinesFit(a.component.render(28), 28);
	});

	it("groups adjacent explicit background spawns; metadata arrives out of order, with no ID or role", () => {
		const args1 = {
			name: "fe-fleet",
			subagent_type: "explore",
			description: "Find frontend entrypoints",
			run_in_background: true,
			max_turns: 30,
		};
		const args2 = {
			name: "reviewer",
			subagent_type: "reviewer",
			description: "Review auth changes",
			run_in_background: true,
			thinking: "max",
		};
		const first = call("Agent", "one", args1);
		const second = call("Agent", "two", args2);
		expect(second.component.render(110)).toEqual([]);
		renderBoxedToolResult(
			"Agent",
			result("{agent:run-2 started}", { agentId: "run-2", model: "anthropic/sonnet-4.5", background: true }),
			{ expanded: false, isPartial: false },
			theme,
			second.ctx,
		);
		const lines = plain(first.component.render(110));
		expect(lines[0]).toBe("◌ Agent (2) · 0/2");
		expect(lines[1]).toContain("├─ ◌ @fe-fleet · Find frontend entrypoints");
		expect(lines[1]).not.toContain("max 30 turns");
		expect(lines[2]).toContain("└─ ◌ @reviewer · Review auth changes · sonnet-4.5");
		expect(lines[2]).not.toContain("thinking max");
		expect(lines.join(" ")).not.toContain("run-2");
		expect(lines.join(" ")).not.toContain("explore");
		// A call re-render after settlement must retain the admitted model.
		renderBoxedToolCall("Agent", args2, theme, second.ctx);
		expect(plain(first.component.render(110))[2]).toContain("sonnet-4.5");
	});

	it("uses only validated optional identity color and effective metadata", () => {
		const run = call("Agent", "colored", { name: "fe-fleet", max_turns: 30, thinking: "max", run_in_background: true });
		const initial = plain(run.component.render(100))[0] ?? "";
		expect(initial).not.toContain("max 30 turns");
		expect(initial).not.toContain("thinking max");
		renderBoxedToolResult(
			"Agent",
			result("{agent:xyz started}", {
				agentId: "xyz",
				maxTurns: 20,
				thinking: "high",
				teammateName: "effective-name",
				color: "#00bbdd",
			}),
			{ expanded: false, isPartial: false },
			theme,
			run.ctx,
		);
		const colored = run.component.render(100)[0] ?? "";
		expect(colored).toContain("\u001b[");
		expect(stripAnsi(colored)).toContain("thinking high · max 20 turns");
		expect(stripAnsi(colored)).toContain("@effective-name");
		expect(stripAnsi(colored)).not.toContain("@fe-fleet");
	});

	it("separates foreground, non-Agent, and later-message batches", () => {
		const first = call("Agent", "first", { name: "one", run_in_background: true });
		const foreground = call("Agent", "second", { name: "two", run_in_background: false });
		expect(plain(first.component.render(80))[0]).toContain("◌ Agent @one");
		expect(plain(foreground.component.render(80))[0]).toContain("◌ Agent @two");
		renderBoxedToolCall("send_message", { target: "one", message: "hi" }, theme, context("mail", {}));
		const next = call("Agent", "third", { name: "three", run_in_background: false });
		expect(plain(next.component.render(80))[0]).toContain("◌ Agent @three");
	});

	it("keeps failures and foreground output accessible", () => {
		const run = call("Agent", "failure", { description: "Review", run_in_background: false });
		const failure = renderBoxedToolResult(
			"Agent",
			result("No usable model"),
			{ expanded: false, isPartial: false },
			theme,
			run.ctx,
		);
		expect(plain(failure.render(80)).join(" ")).toContain("No usable model");
		const expanded = renderBoxedToolResult(
			"Agent",
			result("Line one\nLine two", { agentId: "a" }),
			{ expanded: true, isPartial: false },
			theme,
			{ ...run.ctx, expanded: true },
		);
		expect(plain(expanded.render(80))).toEqual(["Line one", "Line two"]);
		const foreground = renderBoxedToolResult(
			"Agent",
			result("Review complete", { agentId: "a" }),
			{ expanded: false, isPartial: false },
			theme,
			run.ctx,
		);
		expect(plain(foreground.render(80))).toEqual(["└─ Review complete"]);
		const warning = renderBoxedToolResult(
			"Agent",
			result("Partial answer", {
				agentId: "foreground",
				modelFallback: "provider fallback",
				budgetExhausted: "timeout",
				budgetSeconds: 30,
			}),
			{ expanded: true, isPartial: false },
			theme,
			{ ...run.ctx, expanded: true },
		);
		expect(plain(warning.render(80))).toEqual([
			"└─ model fallback provider fallback · budget exhausted (30s)",
			"Partial answer",
		]);
		const batchLeader = call("Agent", "batch-leader", { name: "one", run_in_background: true });
		const batchPeer = call("Agent", "batch-peer", { name: "two", run_in_background: true });
		renderBoxedToolResult(
			"Agent",
			result("Admission refused", { status: "error" }),
			{ expanded: false, isPartial: false },
			theme,
			batchPeer.ctx,
		);
		expect(batchPeer.component.render(80)).toEqual([]);
		expect(plain(batchLeader.component.render(100)).join(" ")).toContain("ERROR: Admission refused");
	});

	it("keeps text-only Agent validation receipts even without launch metadata", () => {
		const invalid = call("Agent", "missing-agent-metadata", { run_in_background: true });
		const receiptText = "A new Agent spawn requires both name and color (#RGB or #RRGGBB).";
		const rendered = renderBoxedToolResult(
			"Agent",
			result(receiptText),
			{ expanded: false, isPartial: false },
			theme,
			invalid.ctx,
		);
		expect(plain(rendered.render(100)).join(" ")).toContain(receiptText);
		expect(plain(invalid.component.render(100)).join(" ")).toContain(receiptText);
	});

	it("retains every critical batch receipt and foreground peer answer in the visible leader", () => {
		const calls = Array.from({ length: 4 }, (_, i) =>
			call("Agent", `four-${i}`, { name: `peer-${i}`, run_in_background: true }),
		);
		for (const [i, callResult] of calls.entries())
			renderBoxedToolResult(
				"Agent",
				result(`Admission failure ${i}`, { status: "error" }),
				{ expanded: false, isPartial: false },
				theme,
				callResult.ctx,
			);
		const leader = calls.at(0);
		if (!leader) throw new Error("expected batch leader");
		const collapsed = plain(leader.component.render(100)).join("\n");
		for (let i = 0; i < 4; i++) {
			expect(collapsed).toContain(`ERROR: Admission failure ${i}`);
			expect(collapsed).toContain(`   └─ @peer-${i}`);
			expect(collapsed).toContain(`ERROR: Admission failure ${i}`);
		}
		closeActiveBatch();

		const backgroundLeader = call("Agent", "warn-bg-lead", { name: "bg-lead", run_in_background: true });
		const backgroundPeer = call("Agent", "warn-bg-peer", { name: "bg-peer", run_in_background: true });
		renderBoxedToolResult(
			"Agent",
			result("started", { agentId: "bg-run", background: true, modelFallback: "provider/model" }),
			{ expanded: false, isPartial: false },
			theme,
			backgroundPeer.ctx,
		);
		expect(plain(backgroundLeader.component.render(100)).join("\n")).toContain("   └─ @bg-peer");
		expect(plain(backgroundLeader.component.render(100)).join("\n")).toContain("NOTICE: model fallback provider/model");

		const foregroundLeader = call("Agent", "warn-fg-lead", { name: "fg-lead", run_in_background: false });
		const foregroundPeer = call("Agent", "warn-fg-peer", { name: "fg-peer", run_in_background: false });
		const peerResult = renderBoxedToolResult(
			"Agent",
			result("Answer first\nAnswer second", { agentId: "fg-run", modelFallback: "provider/model" }),
			{ expanded: false, isPartial: false },
			theme,
			foregroundPeer.ctx,
		);
		expect(peerResult.render(80)).toEqual([]);
		const leaderText = plain(foregroundLeader.component.render(100)).join("\n");
		expect(leaderText).toContain("   └─ @fg-peer");
		expect(leaderText).toContain("NOTICE: model fallback provider/model");
		expect(leaderText).toContain("Answer: Answer first Answer second");
		const expandedLeader = renderBoxedToolCall("Agent", foregroundLeader.ctx.args, theme, {
			...foregroundLeader.ctx,
			expanded: true,
		});
		expect(plain(expandedLeader.render(100)).join("\n")).toContain("      Answer second");
	});

	it("keeps expanded multiline admission and foreground-peer diagnostics with fallback notices", () => {
		const backgroundLeader = call("Agent", "diag-bg-lead", { name: "lead", run_in_background: true });
		const backgroundPeer = call("Agent", "diag-bg-peer", { name: "strict-review", run_in_background: true });
		const candidates = Array.from({ length: 24 }, (_, index) => `candidate-${index}: provider/model-${index}`).join(
			"\n",
		);
		renderBoxedToolResult(
			"Agent",
			result(`Strict model admission failed\n${candidates}`, {
				status: "error",
				modelFallback: "provider/notice-model",
			}),
			{ expanded: false, isPartial: false },
			theme,
			backgroundPeer.ctx,
		);
		const expandedBackground = renderBoxedToolCall("Agent", backgroundLeader.ctx.args, theme, {
			...backgroundLeader.ctx,
			expanded: true,
		});
		const backgroundText = plain(expandedBackground.render(120)).join("\n");
		expect(backgroundText).toContain("   └─ @strict-review");
		expect(backgroundText).toContain("ERROR: Strict model admission failed");
		expect(backgroundText).toContain("candidate-23: provider/model-23");
		expect(backgroundText).toContain("NOTICE: model fallback provider/notice-model");

		closeActiveBatch();
		const foregroundLeader = call("Agent", "diag-fg-lead", { name: "lead-fg", run_in_background: false });
		const foregroundPeer = call("Agent", "diag-fg-peer", { name: "foreground-review", run_in_background: false });
		const peerFailure = renderBoxedToolResult(
			"Agent",
			result(`Foreground failed\n${candidates}`, {
				agentId: "fg-peer-run",
				status: "error",
				modelFallback: "provider/foreground-notice",
			}),
			{ expanded: false, isPartial: false },
			theme,
			foregroundPeer.ctx,
		);
		expect(peerFailure.render(80)).toEqual([]);
		const expandedForeground = renderBoxedToolCall("Agent", foregroundLeader.ctx.args, theme, {
			...foregroundLeader.ctx,
			expanded: true,
		});
		const foregroundText = plain(expandedForeground.render(120)).join("\n");
		expect(foregroundText).toContain("   └─ @foreground-review");
		expect(foregroundText).toContain("ERROR: Foreground failed");
		expect(foregroundText).toContain("candidate-23: provider/model-23");
		expect(foregroundText).toContain("NOTICE: model fallback provider/foreground-notice");
	});

	it("keeps receipts visible beside long reviewer detail at width 80", () => {
		const reviewer = {
			name: "reviewer",
			description: "Review native teammate rendering behavior",
			run_in_background: false,
		};
		const admittedModel = "anthropic/claude-sonnet-4-5";
		const leader = call("Agent", "wide-lead", { name: "lead", run_in_background: false });
		const peer = call("Agent", "wide-reviewer", reviewer);
		renderBoxedToolResult(
			"Agent",
			result("The answer remains visible", {
				agentId: "wide-run",
				teammateName: "reviewer",
				model: admittedModel,
				modelFallback: "provider/compatible-model",
			}),
			{ expanded: false, isPartial: false },
			theme,
			peer.ctx,
		);
		const visible = renderBoxedToolCall("Agent", leader.ctx.args, theme, { ...leader.ctx, expanded: true });
		const visibleLines = plain(visible.render(80));
		expect(visibleLines.join("\n")).toContain("   └─ @reviewer");
		expect(visibleLines.join("\n")).toContain("Answer: The answer remains visible");
		expect(visibleLines.join("\n")).toContain("NOTICE: model fallback provider/compatible-model");
		expectLinesFit(visible.render(80), 80);

		closeActiveBatch();
		const errorLeader = call("Agent", "wide-error-lead", { name: "lead", run_in_background: false });
		const errorPeer = call("Agent", "wide-error-reviewer", reviewer);
		renderBoxedToolResult(
			"Agent",
			result("Strict model failed\nNo candidate matched", {
				agentId: "wide-error-run",
				teammateName: "reviewer",
				model: admittedModel,
				modelFallback: "provider/error-fallback",
				status: "error",
			}),
			{ expanded: false, isPartial: false },
			theme,
			errorPeer.ctx,
		);
		const errorVisible = renderBoxedToolCall("Agent", errorLeader.ctx.args, theme, {
			...errorLeader.ctx,
			expanded: true,
		});
		const errorLines = errorVisible.render(80);
		const errorText = plain(errorLines).join("\n");
		expect(errorText).toContain("   └─ @reviewer");
		expect(errorText).toContain("ERROR: Strict model failed");
		expect(errorText).toContain("NOTICE: model fallback provider/error-fallback");
		expect(errorText).toContain("No candidate matched");
		expectLinesFit(errorLines, 80);
	});

	it("shows the admitted teammate name while waiting, keeping run IDs separate across assignments", () => {
		const first = call("Agent", "spawn-one", { name: "workflow", run_in_background: true });
		const waiting = call("get_subagent_result", "wait-one", { agent_id: "run-one", wait: true });
		expect(plain(waiting.component.render(100))[0]).toBe("◌ Get result run-one · wait");
		renderBoxedToolResult(
			"Agent",
			result("{agent:run-one started as @workflow}", {
				agentId: "run-one",
				teammateName: "workflow",
				background: true,
			}),
			{ expanded: false, isPartial: false },
			theme,
			first.ctx,
		);
		expect(plain(waiting.component.render(100))[0]).toBe("◌ Get result @workflow · wait");
		const second = call("Agent", "spawn-two", { name: "workflow", run_in_background: true });
		renderBoxedToolResult(
			"Agent",
			result("{agent:run-two started as @workflow}", {
				agentId: "run-two",
				teammateName: "workflow",
				background: true,
			}),
			{ expanded: false, isPartial: false },
			theme,
			second.ctx,
		);
		expect(
			plain(call("get_subagent_result", "wait-two", { agent_id: "run-two", wait: true }).component.render(100))[0],
		).toBe("◌ Get result @workflow · wait");
		expect(teammateForRun("run-one")).toBe("workflow");
		expect(teammateForRun("run-two")).toBe("workflow");
		expect(
			plain(
				call("get_subagent_result", "wait-unknown", { agent_id: "run-unknown", wait: true }).component.render(100),
			)[0],
		).toBe("◌ Get result run-unknown · wait");
	});

	it("colors only @references in result receipts using the admitted color or theme accent", () => {
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const waiting = call("get_subagent_result", "wait", { agent_id: "run-review", wait: true }, palette);
		const spawn = call("Agent", "spawn", { name: "arch-review", run_in_background: true }, palette);
		const accent = "\x1b[38;2;68;102;170m@arch-review\x1b[39m";
		expect(spawn.component.render(100)[0]).toContain(accent);
		expect(stripAnsi(waiting.component.render(100)[0] ?? "")).toContain("Get result run-review");
		renderBoxedToolResult(
			"Agent",
			result("{agent:run-review started}", {
				agentId: "run-review",
				teammateName: "arch-review",
				color: "#00bbdd",
				background: true,
			}),
			{ expanded: false, isPartial: false },
			palette,
			spawn.ctx,
		);
		const identity = "\x1b[38;2;0;187;221m@arch-review\x1b[39m";
		expect(spawn.component.render(100)[0]).toContain(identity);
		expect(waiting.component.render(100)[0]).toContain(`${identity} · wait`);
		const receipt =
			renderBoxedToolResult(
				"get_subagent_result",
				result("Type: review | Status: completed\nTeammate: @arch-review\n\n## Status: partial"),
				{ expanded: false, isPartial: false },
				palette,
				waiting.ctx,
			).render(100)[0] ?? "";
		// Collapsed: the record header parses as labeled fields and `Type:`/
		// `Teammate:` noise drops, so `@name` never prints twice (ADR 0012 §8).
		expect(stripAnsi(receipt)).toBe("└ Status: completed");
		expect(receipt).not.toContain(identity);
		const expanded = renderBoxedToolResult(
			"get_subagent_result",
			result("Type: review | Status: completed\nTeammate: @arch-review\n\nDone @arbitrary"),
			{ expanded: true, isPartial: false },
			palette,
			{ ...waiting.ctx, expanded: true },
		).render(100);
		expect(expanded[1]).toBe(`Teammate: ${identity}`);
		expect(expanded.at(-1)).not.toContain("\x1b[38;2;0;187;221m");
		expect(teammateColorForRun("run-review")).toBe("#00bbdd");
		const mismatched =
			renderBoxedToolResult(
				"get_subagent_result",
				result("Type: review | Status: completed\nTeammate: @other-review\n\nDone"),
				{ expanded: false, isPartial: false },
				palette,
				waiting.ctx,
			).render(100)[0] ?? "";
		expect(stripAnsi(mismatched)).toBe("└ Status: completed — Done");
		expect(teammateColorForRun("run-review")).toBeUndefined();

		const unknown = call("get_subagent_result", "unknown", { agent_id: "run-unknown", wait: true }, palette);
		expect(unknown.component.render(100)[0]).not.toContain("\x1b[38;2;0;187;221m");
		const fallback =
			renderBoxedToolResult(
				"get_subagent_result",
				result("Type: review | Status: completed\nTeammate: @docs-review\n\nDone"),
				{ expanded: false, isPartial: false },
				palette,
				unknown.ctx,
			).render(100)[0] ?? "";
		expect(stripAnsi(fallback)).toBe("└ Status: completed — Done");
		expect(unknown.component.render(100)[0]).not.toContain("\x1b[38;2;0;187;221m");
	});

	it("learns a teammate from a completed result when the spawn receipt is unavailable", () => {
		const waiting = call("get_subagent_result", "late", { agent_id: "run-old", wait: true });
		renderBoxedToolResult(
			"get_subagent_result",
			result("Type: explore | Status: completed\nTeammate: @reviewer\n\nDone"),
			{ expanded: false, isPartial: false },
			theme,
			waiting.ctx,
		);
		expect(plain(waiting.component.render(100))[0]).toBe("● Get result @reviewer · wait");
	});

	it("restores only the selected branch's run-to-name mapping", () => {
		const assistant = (id: string, name: string) => ({
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id, name: "Agent", arguments: { name } }] },
		});
		const receipt = (id: string, runId: string, name?: string, color?: string) => ({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "Agent",
				toolCallId: id,
				details: { agentId: runId, ...(name ? { teammateName: name } : {}), ...(color ? { color } : {}) },
			},
		});
		rebuildTeammateRuns([
			assistant("one", "workflow"),
			receipt("one", "run-one"),
			assistant("two", "reviewer"),
			receipt("two", "run-two", "reviewer", "#00bbdd"),
		]);
		expect(teammateForRun("run-one")).toBe("workflow");
		expect(teammateForRun("run-two")).toBe("reviewer");
		expect(teammateColorForRun("run-two")).toBe("#00bbdd");
		rebuildTeammateRuns([assistant("one", "workflow"), receipt("one", "run-one")]);
		expect(teammateForRun("run-two")).toBeUndefined();
		expect(teammateColorForRun("run-two")).toBeUndefined();
		expect(
			plain(call("get_subagent_result", "restored", { agent_id: "run-one", wait: true }).component.render(100))[0],
		).toBe("◌ Get result @workflow · wait");
		// Older sessions may have a formatted result but no Agent admission metadata.
		rebuildTeammateRuns([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "lookup", name: "get_subagent_result", arguments: { agent_id: "run-old" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "get_subagent_result",
					toolCallId: "lookup",
					content: [{ type: "text", text: "Type: explore | Status: completed\nTeammate: @reviewer" }],
				},
			},
		]);
		expect(teammateForRun("run-one")).toBeUndefined();
		expect(teammateForRun("run-old")).toBe("reviewer");
	});

	it("sends minimal message cards — quiet success, loud failure", () => {
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const mail = call("send_message", "mail", { target: "reviewer", message: "Check the diff" }, palette);
		expect(plain(mail.component.render(90))[0]).toBe("● Message to @reviewer (Ctrl+O to expand)");
		expect(mail.component.render(90)[0]).toContain("\x1b[38;2;68;102;170m@reviewer\x1b[39m");
		renderBoxedToolResult(
			"send_message",
			result("Message queued for @reviewer."),
			{ expanded: false, isPartial: false },
			theme,
			mail.ctx,
		);
		// The settled glyph itself is the receipt: no `queued` verb is appended.
		expect(plain(mail.component.render(90))[0]).toBe("● Message to @reviewer (Ctrl+O to expand)");
		const steer = call("steer_subagent", "steer", { agent_id: "run-1", message: "Focus on API" }, palette);
		expect(plain(steer.component.render(90))[0]).toBe("● Steer to @run-1 (Ctrl+O to expand)");
		expect(steer.component.render(90)[0]).toContain("\x1b[38;2;68;102;170m@run-1\x1b[39m");
		renderBoxedToolResult(
			"steer_subagent",
			result("Agent cannot be steered"),
			{ expanded: false, isPartial: false },
			theme,
			steer.ctx,
		);
		expect(plain(steer.component.render(90))[0]).toBe("✗ Steer to @run-1 · Agent cannot be steered");
		const invalidTarget = call("send_message", "bad-target", { target: "bad\rFORGED", message: "hi" });
		renderBoxedToolResult(
			"send_message",
			result("Unknown teammate: bad\rFORGED"),
			{ expanded: true, isPartial: false },
			theme,
			{ ...invalidTarget.ctx, expanded: true },
		);
		const failed = renderBoxedToolCall("send_message", invalidTarget.ctx.args, theme, {
			...invalidTarget.ctx,
			expanded: true,
		})
			.render(80)
			.join("\n");
		expect(failed).not.toContain("\r");
		expect(failed).toContain("bad FORGED");
		// Expanded: the identical head minus the hint, then the │-railed body.
		expect(failed).toContain("  │ hi");
	});

	it("keeps a team receipt visible while a later tools-only member owns the collapse disclosure", () => {
		setToolsRenderConfig({ collapseAfterTurn: true, mergedTurnSummary: false });
		const message = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "team-leader", name: "tasks_get", arguments: { id: "T1" } },
				{ type: "toolCall", id: "bash-hidden", name: "bash", arguments: { command: "pwd" } },
			],
		};
		beginAgentRun();
		registerTurnFromMessage(message, [
			{ toolCallId: "team-leader", isError: false, content: [] },
			{ toolCallId: "bash-hidden", isError: false, content: [] },
		]);
		finishAgentRun();
		const teamReceipt = call("tasks_get", "team-leader", { id: "T1" });
		const disclosure = call("bash", "bash-hidden", { command: "pwd" });
		expect(plain(teamReceipt.component.render(100)).join(" ")).toContain("Task T1");
		expect(plain(disclosure.component.render(100)).join(" ")).toContain("➔");

		for (const writeFailed of [false, true]) {
			resetTurnRegistry();
			beginAgentRun();
			const mixed = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: `receipt-${writeFailed}`, name: "tasks_get", arguments: { id: "T1" } },
					{ type: "toolCall", id: `write-${writeFailed}`, name: "write", arguments: { path: "/tmp/a", content: "a" } },
					{ type: "toolCall", id: `bash-${writeFailed}`, name: "bash", arguments: { command: "pwd" } },
				],
			};
			registerTurnFromMessage(mixed, [
				{ toolCallId: `receipt-${writeFailed}`, isError: false, content: [] },
				{ toolCallId: `write-${writeFailed}`, isError: writeFailed, content: [] },
				{ toolCallId: `bash-${writeFailed}`, isError: false, content: [] },
			]);
			finishAgentRun();
			const bashSummary = renderBoxedToolCall(
				"bash",
				{ command: "pwd" },
				theme,
				context(`bash-${writeFailed}`, { command: "pwd" }),
			);
			expect(plain(bashSummary.render(100)).join(" ")).toContain("➔");
		}

		resetTurnRegistry();
		beginAgentRun();
		const individuallyExpanded = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "expanded-receipt", name: "tasks_get", arguments: { id: "T1" } },
				{ type: "toolCall", id: "expanded-read", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "remaining-bash", name: "bash", arguments: { command: "pwd" } },
			],
		};
		registerTurnFromMessage(individuallyExpanded, [
			{ toolCallId: "expanded-receipt", isError: false, content: [] },
			{ toolCallId: "expanded-read", isError: false, content: [] },
			{ toolCallId: "remaining-bash", isError: false, content: [] },
		]);
		finishAgentRun();
		const native = () => undefined;
		const owner = createToolDecorationOwner({ style: "compact-box" });
		const readHost = { toolName: "read", setExpanded() {} };
		const readRenderer = owner.decorateToolRendererSelection("tool-call-renderer", native, readHost, []) as (
			args: Record<string, unknown>,
			theme: typeof theme,
			context: BoxedToolContext,
		) => { render(width: number): string[] };
		const readCall = readRenderer({ path: "a.ts" }, theme, {
			...context("expanded-read", { path: "a.ts" }),
			expanded: true,
		});
		expect(plain(readCall.render(100)).join(" ")).toContain("Read");
		const bashHost = { toolName: "bash", setExpanded() {} };
		const bashRenderer = owner.decorateToolRendererSelection("tool-call-renderer", native, bashHost, []) as (
			args: Record<string, unknown>,
			theme: typeof theme,
			context: BoxedToolContext,
		) => { render(width: number): string[] };
		const bashAfterExpandedRead = bashRenderer(
			{ command: "pwd" },
			theme,
			context("remaining-bash", { command: "pwd" }),
		);
		expect(plain(bashAfterExpandedRead.render(100)).join(" ")).toContain("➔");

		resetTurnRegistry();
		beginAgentRun();
		const simpleRun = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "toggle-receipt", name: "tasks_get", arguments: { id: "T1" } },
				{ type: "toolCall", id: "toggle-bash", name: "bash", arguments: { command: "pwd" } },
			],
		};
		registerTurnFromMessage(simpleRun, [
			{ toolCallId: "toggle-receipt", isError: false, content: [] },
			{ toolCallId: "toggle-bash", isError: false, content: [] },
		]);
		finishAgentRun();
		let receiptExpanded = false;
		let bashExpanded = false;
		const toggleOwner = createToolDecorationOwner({ style: "compact-box" });
		const receiptHost = {
			toolName: "tasks_get",
			setExpanded(open: boolean) {
				receiptExpanded = open;
			},
		};
		const toggleBashHost = {
			toolName: "bash",
			setExpanded(open: boolean) {
				bashExpanded = open;
			},
		};
		const receiptRenderer = toggleOwner.decorateToolRendererSelection(
			"tool-call-renderer",
			native,
			receiptHost,
			[],
		) as (
			args: Record<string, unknown>,
			theme: typeof theme,
			context: BoxedToolContext,
		) => {
			render(width: number): string[];
		};
		const toggleBashRenderer = toggleOwner.decorateToolRendererSelection(
			"tool-call-renderer",
			native,
			toggleBashHost,
			[],
		) as (
			args: Record<string, unknown>,
			theme: typeof theme,
			context: BoxedToolContext,
		) => {
			render(width: number): string[];
			handleMouse?: (event: never) => { handled: boolean } | undefined;
		};
		const dispatchToggleRun = () => {
			const receipt = receiptRenderer({ id: "T1" }, theme, {
				...context("toggle-receipt", { id: "T1" }),
				expanded: receiptExpanded,
			});
			const bash = toggleBashRenderer({ command: "pwd" }, theme, {
				...context("toggle-bash", { command: "pwd" }),
				expanded: bashExpanded,
			});
			return { receipt, bash };
		};
		const closed = dispatchToggleRun();
		expect(plain(closed.bash.render(100))[0]).toContain("➔");
		closed.bash.handleMouse?.({ type: "click", button: "left", x: 0, y: 0, width: 100, height: 10 } as never);
		expect(receiptExpanded).toBe(true);
		expect(bashExpanded).toBe(true);
		const opened = dispatchToggleRun();
		expect(plain(opened.bash.render(100))[0]).toContain("➔");
		expect(opened.bash.render(100).length).toBeGreaterThan(1);
		opened.bash.handleMouse?.({ type: "click", button: "left", x: 0, y: 0, width: 100, height: 10 } as never);
		expect(receiptExpanded).toBe(false);
		expect(bashExpanded).toBe(false);
		const closedAgain = dispatchToggleRun();
		expect(plain(closedAgain.bash.render(100))[0]).toContain("➔");
	});

	it("renders current task-board receipts, bounded trees, details and raw fallback", () => {
		const list = call("tasks_list", "board", {});
		const tasks = Array.from({ length: 6 }, (_, i) => ({
			id: `id-${i}`,
			code: `T${i + 1}`,
			title: `Task ${i}`,
			status: "pending",
			blockedBy: i === 0 ? ["T9"] : [],
		}));
		const view = renderBoxedToolResult(
			"tasks_list",
			result(JSON.stringify(tasks)),
			{ expanded: false, isPartial: false },
			theme,
			list.ctx,
		);
		expect(plain(list.component.render(80))[0]).toBe("● Tasks");
		expect(plain(view.render(80))).toHaveLength(4);
		expect(plain(view.render(80)).join(" ")).toContain("T1 · Task 0 · pending · blocked by T9");
		expect(plain(view.render(80)).join(" ")).toContain("3 more");
		const expandedTree = renderBoxedToolResult(
			"tasks_list",
			result(JSON.stringify(tasks)),
			{ expanded: true, isPartial: false },
			theme,
			context("all-tasks", { expanded: true }),
		);
		expect(expandedTree.render(80)).toHaveLength(tasks.length);
		const modelText = Array.from({ length: 45 }, (_, i) => `provider/model-${i} — Model ${i}`).join("\n");
		const models = renderBoxedToolResult(
			"list_models",
			result(modelText),
			{ expanded: true, isPartial: false },
			theme,
			context("models", { expanded: true }),
		);
		expect(models.render(80)).toHaveLength(46);
		expect(models.render(80).join("\n")).toContain("provider/model-44");
		expect(models.render(80).join("\n")).not.toContain("Ctrl+O to expand");
		const escapedModels = renderBoxedToolResult(
			"list_models",
			result('No available model matches "missing\u001b[2JFORGED".'),
			{ expanded: false, isPartial: false },
			theme,
			context("escaped-models", {}),
		);
		expect(escapedModels.render(80).join("\n")).not.toContain("\u001b");
		expect(escapedModels.render(80).join("\n")).toContain("FORGED");
		const task = {
			id: "uuid-1",
			code: "T1",
			title: "Review APIs",
			status: "completed",
			owner: "arch-review",
			dependencies: [],
			requirementRevision: 2,
			description: "Inspect API behavior\nImportant requirement",
			spec: { acceptanceCriteria: ["All checks pass"] },
			attempts: [
				{
					runId: "run-1",
					teammateName: "reviewer",
					status: "failed",
					requirementRevision: 1,
					partialResult: "partial first\npartial second",
					result: { summary: "attempt summary\nsecond summary" },
				},
			],
			outcome: { summary: "final summary\nsecond outcome line", verification: [{ check: "tests", outcome: "passed" }] },
		};
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const receipt = renderBoxedToolResult(
			"tasks_update",
			result(JSON.stringify(task)),
			{ expanded: false, isPartial: false },
			palette,
			context("update", {}),
		);
		expect(receipt.render(80)[0]).toContain("@arch-review");
		// ADR 0013 §1/§2: the completed delta compresses the outcome to counts.
		expect(plain(receipt.render(80))).toEqual(["└ T1 accepted · @arch-review · 1 check: 1 passed"]);
		const detail = renderBoxedToolResult(
			"tasks_get",
			result(JSON.stringify(task)),
			{ expanded: true, isPartial: false },
			theme,
			context("detail", { id: "T1", expanded: true }),
		);
		expect(plain(detail.render(100)).join("\n")).toContain("acceptanceCriteria");
		expect(plain(detail.render(100)).join("\n")).toContain("completed");
		expect(plain(detail.render(100))).toContain("  Important requirement");
		expect(plain(detail.render(100))).toContain("    partial second");
		expect(plain(detail.render(100))).toContain("    second summary");
		expect(plain(detail.render(100))).toContain("    second outcome line");
		const taskOutput = renderBoxedToolResult(
			"tasks_output",
			result(
				JSON.stringify({
					taskId: "id-1",
					attempt: { status: "completed", teammateName: "reviewer" },
					result: "first line\nsecond line",
				}),
			),
			{ expanded: true, isPartial: false },
			theme,
			context("output", { id: "T1", expanded: true }),
		);
		expect(plain(taskOutput.render(80)).join("\n")).toContain("second line");
		const failedOutput = renderBoxedToolResult(
			"tasks_output",
			result(
				JSON.stringify({
					taskId: "id-1",
					attempt: { status: "running" },
					error: "No live runtime",
					result: "partial answer",
				}),
			),
			{ expanded: true, isPartial: false },
			theme,
			context("output-error", { id: "T1", expanded: true }),
		);
		expect(plain(failedOutput.render(80)).join("\n")).toContain("ERROR No live runtime");
		expect(plain(failedOutput.render(80)).join("\n")).toContain("partial answer");
		const lifecycle = renderBoxedToolResult(
			"teammate_release",
			result("Teammate @reviewer is now released. Task-board claims are unchanged.", {
				name: "reviewer",
				state: "released",
				availability: "unavailable",
				contextAvailable: false,
				changed: true,
			}),
			{ expanded: true, isPartial: false },
			theme,
			context("release", { name: "reviewer", expanded: true }),
		);
		expect(plain(lifecycle.render(80)).join(" ")).toContain(
			"released · availability unavailable · context unavailable",
		);
		const lifecycleFailure = renderBoxedToolResult(
			"teammate_retire",
			result("Retire failed for @reviewer: busy", {
				name: "reviewer",
				changed: false,
				error: "busy",
				recovery: "wait and retry",
			}),
			{ expanded: true, isPartial: false },
			theme,
			{ ...context("retire-fail", { name: "reviewer", expanded: true }), isError: true },
		);
		expect(plain(lifecycleFailure.render(80)).join("\n")).toContain("Recovery: wait and retry");
		expect(plain(lifecycleFailure.render(80)).join("\n")).toContain("Retire failed for @reviewer: busy");
		const fallback = renderBoxedToolResult(
			"tasks_get",
			result("Unknown task"),
			{ expanded: false, isPartial: false },
			theme,
			context("get", { id: "x" }),
		);
		expect(plain(fallback.render(80))[0]).toContain("Unknown task");
	});
});

describe("public pi-teams tool renderer resolver (Pi 1.0.4)", () => {
	it("adapts only team tools without re-registering execution, and groups with self shell", () => {
		let resolver: ((name: string, next: () => unknown) => unknown) | undefined;
		registerTeammateToolRenderers({
			registerToolRenderer: (value: typeof resolver) => {
				resolver = value;
			},
		} as unknown as ExtensionAPI);
		expect(resolver?.("read", () => "native")).toBe("native");
		const adapters = resolver?.("Agent", () => undefined) as {
			renderShell: string;
			renderCall: (
				args: Record<string, unknown>,
				theme: typeof theme,
				ctx: BoxedToolContext,
			) => { render(width: number): string[] };
			renderResult: (
				result: BoxedToolResult,
				options: { expanded: boolean; isPartial: boolean },
				theme: typeof theme,
				ctx: BoxedToolContext,
			) => { render(width: number): string[] };
		};
		expect(adapters.renderShell).toBe("self");
		const args = { name: "fe-fleet", run_in_background: true, description: "Find frontend" };
		const leader = adapters.renderCall(args, theme, context("public-1", args));
		const second = adapters.renderCall(args, theme, context("public-2", args));
		expect(plain(leader.render(100))[0]).toBe("◌ Agent (2) · 0/2");
		expect(second.render(100)).toEqual([]);

		closeActiveBatch();
		const invalidArgs = { run_in_background: true };
		const invalidCtx = context("public-invalid", invalidArgs);
		const invalidLeader = adapters.renderCall(
			{ name: "host-lead", run_in_background: true },
			theme,
			context("public-host-lead", { name: "host-lead", run_in_background: true }),
		);
		adapters.renderCall(invalidArgs, theme, invalidCtx);
		const validation = adapters.renderResult(
			result("A new Agent spawn requires both name and color (#RGB or #RRGGBB)."),
			{ expanded: false, isPartial: false },
			theme,
			invalidCtx,
		);
		expect(validation.render(100)).toEqual([]);
		expect(plain(invalidLeader.render(100)).join(" ")).toContain("RECEIPT");
	});

	it("renders zero lines when the host context shape is unrecognizable (1.2 unknown-typed callback inputs)", () => {
		let resolver: ((name: string, next: () => unknown) => unknown) | undefined;
		registerTeammateToolRenderers({
			registerToolRenderer: (value: typeof resolver) => {
				resolver = value;
			},
		} as unknown as ExtensionAPI);
		const adapters = resolver?.("Agent", () => undefined) as {
			renderCall: (args: unknown, theme: typeof theme, ctx: unknown) => { render(width: number): string[] };
		};
		const args = { name: "fe-fleet", description: "Find frontend" };
		// Pi 1.2 types these inputs as unknown; a malformed context (missing
		// fields, non-record args) must degrade to zero lines, never throw.
		expect(adapters.renderCall(args, theme, undefined).render(100)).toEqual([]);
		expect(adapters.renderCall(args, theme, { toolCallId: "x" }).render(100)).toEqual([]);
		expect(adapters.renderCall("not-a-record", theme, context("bad-args", {})).render(100)).toEqual([]);
		// A well-formed context with plain-record args still renders the boxed row.
		const boxed = adapters.renderCall(args, theme, context("public-3", args));
		expect(plain(boxed.render(100))[0]).toContain("fe-fleet");
	});
});

describe("pi-teams message renderers", () => {
	it("renders notification and untrusted mailbox without duplicate sender header", () => {
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const renderers = new Map<string, MessageRenderer>();
		registerTeammateMessageRenderers({
			registerMessageRenderer: (type: string, renderer: MessageRenderer) => {
				renderers.set(type, renderer);
			},
		} as unknown as ExtensionAPI);
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const notice = renderers.get("teammate-notification")?.(
			{
				content: "Teammate @fe-fleet finished\n\nFound files\nfull result: /tmp/result.md",
				details: { teammateName: "fe-fleet", outcome: "completed", resultFile: "/tmp/result.md" },
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(plain(notice?.render(100) ?? [])).toEqual(["● @fe-fleet", "  └ Found files", "  └ ↗ result.md"]);
		expect(notice?.render(100)[0]).toContain("\x1b[38;2;68;102;170m@fe-fleet\x1b[39m");
		const linked = notice?.render(80).at(-1) ?? "";
		expect(linked).toContain("\x1b]8;;file:///tmp/result.md\x1b\\result.md\x1b]8;;\x1b\\");
		const longPreview = renderers.get("teammate-notification")?.(
			{
				content: `Teammate @worker finished\n\n${"preview ".repeat(80)}`,
				details: {
					teammateName: "worker",
					outcome: "completed",
					resultFile: `/tmp/${"very-long-path/".repeat(30)}result.md`,
				},
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		const narrowLines = longPreview?.render(40) ?? [];
		expect(narrowLines.at(-1)).toContain("result.md");
		expect(narrowLines.at(-1)).toContain("\x1b]8;;file://");
		expectLinesFit(narrowLines, 40);
		const tinyLink = notice?.render(12).at(-1) ?? "";
		expect(tinyLink).toContain("\x1b]8;;file:///tmp/result.md");
		expectLinesFit(notice?.render(12) ?? [], 12);
		const longExpanded = renderers.get("teammate-notification")?.(
			{
				content: `Teammate @worker finished\n\n${Array.from({ length: 200 }, (_, i) => `preview-${i}`).join("\n")}`,
				details: { teammateName: "worker", outcome: "completed", resultFile: "/tmp/worker.md" },
			} as Parameters<MessageRenderer>[0],
			{ expanded: true } as Parameters<MessageRenderer>[1],
			palette,
		);
		const longExpandedRows = longExpanded?.render(80) ?? [];
		expect(longExpandedRows).toHaveLength(200);
		expect(longExpandedRows.at(-2)).toContain("worker.md");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const noHyperlinks = notice?.render(80).at(-1) ?? "";
		expect(noHyperlinks).toContain("/tmp/result.md");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const unusualPath = "/tmp/project#v1/a result.md";
		const unusual = renderers.get("teammate-notification")?.(
			{
				content: "Teammate @worker finished\n\nDone",
				details: { teammateName: "worker", outcome: "completed", resultFile: unusualPath },
			} as Parameters<MessageRenderer>[0],
			{ expanded: true } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(unusual?.render(120).join("\n")).toContain("file:///tmp/project%23v1/a%20result.md");
		const width16Link = unusual?.render(16).find((line) => line.includes("\x1b]8;;file://")) ?? "";
		expect(stripAnsi(width16Link)).toContain("/tmp/proj");
		expect(width16Link).toContain("\x1b]8;;file://");
		const expandedTinyLink = unusual?.render(12).at(-2) ?? "";
		expect(expandedTinyLink).toContain("\x1b]8;;file:///tmp/project%23v1/a%20result.md");
		expectLinesFit(unusual?.render(12) ?? [], 12);
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const noHyperlinkNarrow = unusual?.render(12) ?? [];
		expect(
			noHyperlinkNarrow
				.map(stripAnsi)
				.map((line) => line.replace(/^ {2}↗ /, "").replace(/^ {4}/, ""))
				.join(""),
		).toContain(unusualPath);
		expect(noHyperlinkNarrow.join("\n")).not.toContain("\x1b]8;;");
		expectLinesFit(noHyperlinkNarrow, 12);
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const withoutResult = renderers.get("teammate-notification")?.(
			{
				content: "Teammate @worker finished\n\nDone",
				details: { teammateName: "worker", outcome: "completed" },
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(withoutResult?.render(80).join(" ")).not.toContain("result.md");
		const grouped = renderers.get("teammate-notification")?.(
			{
				content:
					"2 teammates reported from the same launch batch:\n\n@lead (completed):\nOK\nfull result: /tmp/lead.md\n\n@bad (failed):\nbroken\nfull result: /tmp/bad.md",
				details: {
					teammateName: "lead",
					outcome: "completed",
					resultFile: "/tmp/lead.md",
					others: [{ teammateName: "bad", outcome: "failed", resultFile: "/tmp/bad.md" }],
				},
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(plain(grouped?.render(100) ?? []).join("\n")).toContain("✗ @bad · broken");
		const longCompleted = Array.from({ length: 200 }, () => "x").join("\n");
		const budgetedGroup = renderers.get("teammate-notification")?.(
			{
				content: `2 teammates reported from the same launch batch:\n\n@lead (completed):\n${longCompleted}\nfull result: /tmp/lead.md\n\n@bad (failed):\nStrict model admission failed: no valid candidates\nfull result: /tmp/bad.md`,
				details: {
					teammateName: "lead",
					outcome: "completed",
					resultFile: "/tmp/lead.md",
					others: [{ teammateName: "bad", outcome: "failed", resultFile: "/tmp/bad.md" }],
				},
			} as Parameters<MessageRenderer>[0],
			{ expanded: true } as Parameters<MessageRenderer>[1],
			palette,
		);
		const budgetedRows = plain(budgetedGroup?.render(100) ?? []);
		expect(budgetedRows).toHaveLength(200);
		expect(budgetedRows).toContain("  @bad:");
		expect(budgetedRows).toContain("    Strict model admission failed: no valid candidates");
		expect(budgetedRows.join("\n")).toContain("noncritical preview lines to keep failure receipts visible");
		const spoofed = renderers.get("teammate-notification")?.(
			{
				content:
					"2 teammates reported from the same launch batch:\n\n@lead (completed):\nExample:\n\n@bad (failed):\nQuoted fake error\n\n@bad (failed):\nActual diagnostic",
				details: {
					teammateName: "lead",
					outcome: "completed",
					others: [{ teammateName: "bad", outcome: "failed" }],
				},
			} as Parameters<MessageRenderer>[0],
			{ expanded: true } as Parameters<MessageRenderer>[1],
			palette,
		);
		const spoofedRows = plain(spoofed?.render(100) ?? []).join("\n");
		expect(spoofedRows).toContain("ambiguous section boundaries");
		expect(spoofedRows).not.toContain("Quoted fake error");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const artifactPath = (letter: string): string => `/root/${letter.repeat(522)}`;
		const artifactReports = [
			{ name: "completed-member-one-with-a-long-name", path: artifactPath("a") },
			{ name: "completed-member-two", path: artifactPath("b") },
			{ name: "completed-member-three", path: artifactPath("c") },
		];
		const groupedContent = [
			"4 teammates reported from the same launch batch:",
			...artifactReports.flatMap((item, index) => [
				"",
				`@${item.name} (completed):`,
				`done-${index + 1}`,
				`full result: ${item.path}`,
			]),
			"",
			"@failed-member-with-a-long-name (failed):",
			"boom",
		].join("\n");
		const crowdedGroup = renderers.get("teammate-notification")?.(
			{
				content: groupedContent,
				details: {
					teammateName: artifactReports[0]?.name,
					outcome: "completed",
					resultFile: artifactReports[0]?.path,
					others: [
						...artifactReports.slice(1).map((item) => ({
							teammateName: item.name,
							outcome: "completed",
							resultFile: item.path,
						})),
						{ teammateName: "failed-member-with-a-long-name", outcome: "failed" },
					],
				},
			} as Parameters<MessageRenderer>[0],
			{ expanded: true } as Parameters<MessageRenderer>[1],
			palette,
		);
		const crowdedRows = plain(crowdedGroup?.render(12) ?? []);
		expect(crowdedRows).toHaveLength(200);
		expect(crowdedRows.some((line) => line.includes("failed"))).toBe(true);
		expect(crowdedRows).toContain("    boom");
		expect(crowdedRows.join("\n")).toContain("omitted");
		expectLinesFit(crowdedGroup?.render(12) ?? [], 12);
		const renderedArtifactText = crowdedRows
			.filter((line) => line.startsWith("  ↗ ") || /^ {4}[abc]+$/.test(line))
			.map((line) => line.replace(/^ {2}↗ /, "").replace(/^ {4}/, ""))
			.join("");
		expect(renderedArtifactText).toContain(artifactReports[0]?.path);
		expect(renderedArtifactText).toContain(artifactReports[1]?.path);

		const sixArtifacts = Array.from({ length: 6 }, (_, index) => ({
			name: `member-${index + 1}`,
			path: `/${String(index + 1).repeat(799)}`,
		}));
		const sixArtifactContent = [
			"7 teammates reported from the same launch batch:",
			...sixArtifacts.flatMap((item, index) => [
				"",
				`@${item.name} (completed):`,
				`done-${index + 1}`,
				`full result: ${item.path}`,
			]),
			"",
			"@failed-member (failed):",
			"boom",
		].join("\n");
		const sixArtifactGroup = renderers.get("teammate-notification")?.(
			{
				content: sixArtifactContent,
				details: {
					teammateName: sixArtifacts[0]?.name,
					outcome: "completed",
					resultFile: sixArtifacts[0]?.path,
					others: [
						...sixArtifacts.slice(1).map((item) => ({
							teammateName: item.name,
							outcome: "completed",
							resultFile: item.path,
						})),
						{ teammateName: "failed-member", outcome: "failed" },
					],
				},
			} as Parameters<MessageRenderer>[0],
			{ expanded: true } as Parameters<MessageRenderer>[1],
			palette,
		);
		const sixArtifactRows = plain(sixArtifactGroup?.render(24) ?? []);
		expect(sixArtifactRows).toHaveLength(200);
		expect(sixArtifactRows).toContain("    boom");
		const artifactOmission = sixArtifactRows.find((line) => line.includes("omitted")) ?? "";
		expect(artifactOmission).toContain("omitted 51");
		expect(artifactOmission).not.toContain("omitted 11");
		expectLinesFit(sixArtifactGroup?.render(24) ?? [], 24);
		const message = renderers.get("teammate-message")?.(
			{
				content: "Message from @fe-fleet:\n\nFound routes",
				details: { from: "fe-fleet", color: "#00bbdd", untrusted: true },
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(plain(message?.render(80) ?? [])).toEqual(["● Message from @fe-fleet (Ctrl+O to expand)"]);
		const multiline = renderers.get("teammate-message")?.(
			{
				content: "Message from @worker:\n\nfirst line\nsecond\r\u0007line",
				details: { from: "worker" },
			} as Parameters<MessageRenderer>[0],
			{ expanded: true } as Parameters<MessageRenderer>[1],
			palette,
		);
		const expandedMessage = multiline?.render(80) ?? [];
		expect(expandedMessage.length).toBeGreaterThan(1);
		expect(expandedMessage.join("\n")).toContain("second  line");
		expect(expandedMessage.join("\n").includes("\r")).toBe(false);
		expect(expandedMessage.join("\n").includes("\u0007")).toBe(false);
		expect(message?.render(80)[0]).toContain("\x1b[38;2;0;187;221m@fe-fleet\x1b[39m");
		const noColor = renderers.get("teammate-message")?.(
			{
				content: "Message from @docs-review:\n\nUpdate",
				details: { from: "docs-review", color: "not-a-color" },
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(noColor?.render(100)[0]).toContain("\x1b[38;2;68;102;170m@docs-review\x1b[39m");
		setToolsRenderConfig({ nerdFonts: true });
		expect(plain(message?.render(80) ?? [])[0]).toContain("● Message from @fe-fleet");
		const malformed = renderers.get("teammate-notification")?.(
			{ content: "Legacy notification", details: {} } as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			theme,
		);
		expect(plain(malformed?.render(80) ?? []).map((line) => line.trimEnd())).toEqual(["Legacy notification"]);
	});
});

describe("ADR 0012 team event transcript", () => {
	it.each(["unicode", "ascii"] as const)("keeps model call/result glyphs identical in %s mode", (glyphMode) => {
		setToolsRenderConfig({ glyphMode, nerdFonts: true });
		const models = call("list_models", `models-${glyphMode}`, {});
		const output = renderBoxedToolResult(
			"list_models",
			result("openai-codex/gpt-6-luna — GPT-6 Luna"),
			{ expanded: false, isPartial: false },
			theme,
			models.ctx,
		);
		const header = `${glyphMode === "ascii" ? "*" : "●"} Models`;
		expect(plain(models.component.render(100))[0]).toBe(header);
		expect(plain(output.render(100))[0]).toBe(header);
		const release = call("teammate_release", `release-${glyphMode}`, { name: "luna" });
		expect(plain(release.component.render(100))[0]).toBe(`${header[0]} Release @luna`);
	});

	it("flips a live background spawn row only at settlement, and renders ● from admission after resetTeammateRuns", () => {
		const spawn = call("Agent", "flip-1", { name: "worker", run_in_background: true, description: "Long job" });
		expect(plain(spawn.component.render(100))[0]).toBe("◌ Agent @worker · Long job");
		renderBoxedToolResult(
			"Agent",
			result("{agent:flip-run started}", {
				agentId: "flip-run",
				teammateName: "worker",
				background: true,
				model: "zhipu/glm-5.3-flash",
			}),
			{ expanded: false, isPartial: false },
			theme,
			spawn.ctx,
		);
		// Admission alone never settles the glyph (fill = progress).
		expect(plain(spawn.component.render(100))[0]).toBe("◌ Agent @worker · Long job · glm-5.3-flash");
		settleTeammateRun("flip-run", { outcome: "completed", durationMs: 123_000, totalTokens: 146_500 });
		expect(plain(spawn.component.render(100))[0]).toBe("● Agent @worker · Long job · glm-5.3-flash · 2m 03s · ↓146.5k");
		settleTeammateRun("flip-run", { outcome: "failed" });
		expect(stripAnsi(spawn.component.render(100)[0] ?? "")).toContain("✗ Agent @worker");
		// Without live state (resume/replay) the row renders settled from admission.
		resetTeammateRuns();
		expect(plain(spawn.component.render(100))[0]).toBe("● Agent @worker · Long job · glm-5.3-flash");
	});

	it("settles a foreground spawn row at its own tool result", () => {
		const spawn = call("Agent", "fg-flip", { name: "solo", run_in_background: false, description: "Quick task" });
		renderBoxedToolResult(
			"Agent",
			result("Answer", { agentId: "fg-run", teammateName: "solo" }),
			{ expanded: false, isPartial: false },
			theme,
			spawn.ctx,
		);
		expect(plain(spawn.component.render(100))[0]).toBe("● Agent @solo · Quick task");
	});

	it("renders the list_models card with lifted header counts, deduped dim rows, and the full 1-match ref", () => {
		const many = renderBoxedToolResult(
			"list_models",
			result(
				[
					"zhipu/glm-5.3-flash — GLM-5.3-Flash",
					"anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5",
					"openai/gpt-5 — GPT Five",
					"2 of 10 matching models shown",
				].join("\n"),
			),
			{ expanded: false, isPartial: false },
			theme,
			context("models-many", { query: "flash" }),
		);
		const lines = plain(many.render(100));
		expect(lines[0]).toBe("● Models · flash · 2/10");
		expect(lines[1]).toBe("├─ glm-5.3-flash");
		expect(lines[2]).toBe("├─ claude-sonnet-4-5");
		expect(lines[3]).toBe("└─ gpt-5 — GPT Five");
		const expanded = renderBoxedToolResult(
			"list_models",
			result("zhipu/glm-5.3-flash — GLM-5.3-Flash\n1 of 7 matching models shown"),
			{ expanded: false, isPartial: false },
			theme,
			context("models-one", { query: "glm" }),
		);
		expect(plain(expanded.render(100))).toEqual(["● Models · glm · 1/7", "└─ zhipu/glm-5.3-flash"]);
		const expandedMany = renderBoxedToolResult(
			"list_models",
			result("zhipu/glm-5.3-flash — GLM-5.3-Flash\nanthropic/claude-sonnet-4-5 — Claude Sonnet 4.5"),
			{ expanded: true, isPartial: false },
			theme,
			context("models-expanded", {}),
		);
		expect(plain(expandedMany.render(100))).toEqual([
			"● Models",
			"├─ zhipu/glm-5.3-flash",
			"└─ anthropic/claude-sonnet-4-5",
		]);
		// Unparseable results keep the verbatim fail-closed fallback.
		const fallback = renderBoxedToolResult(
			"list_models",
			result('No available model matches "missing".'),
			{ expanded: false, isPartial: false },
			theme,
			context("models-fallback", {}),
		);
		expect(plain(fallback.render(100))).toEqual(['No available model matches "missing".']);
	});

	it("collapses get_subagent_result records to labeled fields without repeating @name", () => {
		const waiting = call("get_subagent_result", "record", { agent_id: "run-record", wait: true });
		const receipt = renderBoxedToolResult(
			"get_subagent_result",
			result(
				"Type: review | Status: partial\nTeammate: @worker\n\n### Findings\nVerdict: undetermined — No actionable bugs found.\nSecond line",
			),
			{ expanded: false, isPartial: false },
			theme,
			waiting.ctx,
		);
		expect(plain(receipt.render(120))[0]).toBe(
			"└ Status: partial · Verdict: undetermined — No actionable bugs found. … +1 lines",
		);
		// The waiting call head settles to ● once its own result exists.
		expect(plain(waiting.component.render(100))[0]).toBe("● Get result @worker · wait");
	});

	it("resolves ASCII team glyphs from the explicit session glyph mode", () => {
		setToolsRenderConfig({ glyphMode: "ascii", mergedSummaryGlyph: ">" });
		const spawn = call("Agent", "ascii-spawn", { name: "worker", run_in_background: true });
		expect(plain(spawn.component.render(100))[0]).toBe("~ Agent @worker");
		const mail = call("send_message", "ascii-mail", { target: "worker", message: "hi" });
		expect(plain(mail.component.render(100))[0]).toBe("* Message to @worker (Ctrl+O to expand)");
	});

	it("renders notification duration/tokens only from producer details and settles the remembered run", () => {
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const renderers = new Map<string, MessageRenderer>();
		registerTeammateMessageRenderers({
			registerMessageRenderer: (type: string, renderer: MessageRenderer) => {
				renderers.set(type, renderer);
			},
		} as unknown as ExtensionAPI);
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const notice = renderers.get("teammate-notification")?.(
			{
				content: "Teammate @worker finished\n\nAll checks pass",
				details: {
					teammateName: "worker",
					outcome: "completed",
					agentId: "notify-run",
					durationMs: 123_000,
					totalTokens: 146_500,
				},
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(plain(notice?.render(100) ?? [])).toEqual(["● @worker · 2m 03s · ↓146.5k tokens", "  └ All checks pass"]);
		// Rule 5: the notification renderer settles the remembered run in-process.
		closeActiveBatch();
		const spawn = call("Agent", "notify-spawn", { name: "worker", run_in_background: true });
		renderBoxedToolResult(
			"Agent",
			result("{agent:notify-run started}", { agentId: "notify-run", teammateName: "worker", background: true }),
			{ expanded: false, isPartial: false },
			theme,
			spawn.ctx,
		);
		expect(plain(spawn.component.render(100))[0]).toBe("● Agent @worker · 2m 03s · ↓146.5k");
	});
});

describe("ADR 0013 task delta cards", () => {
	const baseTask = { code: "T5", title: "Retire reminders", status: "pending", owner: "worker" };
	const render = (name: string, payload: unknown, id: string, expanded = false) =>
		renderBoxedToolResult(
			name,
			result(JSON.stringify(payload)),
			{ expanded, isPartial: false },
			theme,
			context(id, {}),
		);

	it("renders the delta line for every mapped status", () => {
		expect(plain(render("tasks_create", baseTask, "d-create").render(100))).toEqual(["└ T5 created · pending"]);
		expect(plain(render("tasks_update", { ...baseTask, status: "in_progress" }, "d-claim").render(100))).toEqual([
			"└ T5 claimed · @worker",
		]);
		expect(plain(render("tasks_update", { ...baseTask, status: "in_review" }, "d-review").render(100))).toEqual([
			"└ T5 submitted for review · @worker",
		]);
		expect(plain(render("tasks_update", { ...baseTask, status: "pending" }, "d-release").render(100))).toEqual([
			"└ T5 claim released",
		]);
		expect(plain(render("tasks_cancel", { ...baseTask, status: "cancelled" }, "d-cancel").render(100))).toEqual([
			"└ T5 cancelled",
		]);
	});

	it("compresses completed outcomes to counts and breaks failed checks out loud", () => {
		const accepted = {
			...baseTask,
			status: "completed",
			outcome: {
				verification: [
					{ check: "lint", outcome: "passed" },
					{ check: "tests pass", outcome: "failed", evidence: "3 failures" },
				],
			},
		};
		const rows = render("tasks_update", accepted, "d-fail").render(100);
		expect(plain(rows)).toEqual(["└ T5 accepted · @worker · 2 checks: 1 passed · 1 failed", "✗ tests pass"]);
		// The failed-check breakout is loud (error tint), never a dim count.
		expect(rows[1]).toContain("\u001b[");
	});

	it("keeps the identity accent on delta actors", () => {
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const row = renderBoxedToolResult(
			"tasks_update",
			result(JSON.stringify({ ...baseTask, status: "in_progress" })),
			{ expanded: false, isPartial: false },
			palette,
			context("d-actor", {}),
		);
		expect(row.render(100)[0]).toContain("\u001b[38;2;68;102;170m@worker\u001b[39m");
	});

	it("expands the acceptance card with railed summary, clipped artifact rows and verification", () => {
		const accepted = {
			...baseTask,
			status: "completed",
			outcome: {
				summary: "Main accepts bounded retirement\nContinuation line",
				artifacts: [
					`/tmp/work/very/long/${"deep/".repeat(6)}delta-reminder-retirement-build-20261015-052517.log`,
					"/tmp/work/delta-suite.log",
				],
				verification: [
					{ check: "unit tests", outcome: "passed", evidence: "42 passed\nmore detail" },
					{ check: "typecheck", outcome: "failed", evidence: "src/a.ts:1 error" },
				],
				remainingIssues: ["One follow-up remains\nsplit line"],
			},
		};
		const rows = plain(render("tasks_update", accepted, "d-expanded", true).render(120));
		expect(rows[0]).toBe("└ T5 accepted · @worker · 2 checks: 1 passed · 1 failed · 1 issue remaining · 2 artifacts");
		expect(rows[1]).toBe("  │ Summary: Main accepts bounded retirement");
		expect(rows[2]).toBe("  │ Continuation line");
		expect(rows[3]).toContain("├─ ↗ ");
		expect(rows[3]).toContain("...");
		expect(rows[3]).not.toContain("/tmp/work/very/long/");
		expect(rows[4]).toBe("  └─ ↗ /tmp/work/delta-suite.log");
		expect(rows[5]).toBe("  ✓ unit tests — 42 passed");
		expect(rows[6]).toBe("  ✗ typecheck — src/a.ts:1 error");
		expect(rows[7]).toBe("  │ Remaining: One follow-up remains");
		expect(rows[8]).toBe("  │ split line");
		// Artifacts with real absolute paths hyperlink when the capability exists.
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const linked = render("tasks_update", accepted, "d-linked", true).render(120);
		expect(linked.some((line) => line.includes("\u001b]8;;file://"))).toBe(true);
	});

	it("renders the tasks_execute delta without the disclaimer row", () => {
		const execution = {
			task: { code: "T5", status: "in_progress", attempts: [{ teammateName: "worker" }] },
			runId: "exec-run-9",
		};
		const collapsed = render("tasks_execute", execution, "d-exec").render(120);
		expect(plain(collapsed)).toEqual(["└ T5 · in_progress · attempt → @worker"]);
		expect(collapsed.join("\n")).not.toContain("does not imply");
		const expanded = plain(render("tasks_execute", execution, "d-exec-x", true).render(120));
		expect(expanded).toContain("  run exec-run-9");
	});

	it("renders both tasks_stop deltas", () => {
		expect(plain(render("tasks_stop", { stopped: true, task: { code: "T5" } }, "d-stop").render(100))).toEqual([
			"└ T5 attempt stop requested",
		]);
		expect(plain(render("tasks_stop", { stopped: false }, "d-stop-idle").render(100))).toEqual(["no running attempt"]);
	});

	it("runs tasks_output bodies through normalizePreview collapsed and keeps them verbatim expanded", () => {
		const payload = {
			taskId: "id-1",
			attempt: { status: "completed", teammateName: "reviewer" },
			result: "## Findings\n\n**All** checks `pass`\nStatus: duplicated",
		};
		expect(plain(render("tasks_output", payload, "d-out").render(100))).toEqual([
			"└─ completed · @reviewer",
			"  └ All checks pass … +1 lines",
		]);
		const expanded = plain(render("tasks_output", payload, "d-out-x", true).render(100));
		expect(expanded).toContain("  ## Findings");
		expect(expanded).toContain("  **All** checks `pass`");
	});

	it("falls back to the existing summary line for unmapped statuses (fail-closed)", () => {
		expect(plain(render("tasks_update", { ...baseTask, status: "teleported" }, "d-weird").render(100))).toEqual([
			"└─ T5 · Retire reminders · teleported · @worker",
		]);
	});
});
