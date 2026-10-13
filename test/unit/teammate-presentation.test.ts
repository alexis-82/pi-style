import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerTeammateMessageRenderers } from "../../extension-src/pi-style/features/messages/teammates.js";
import { closeActiveBatch, resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import { renderBoxedToolCall, renderBoxedToolResult } from "../../extension-src/pi-style/features/tools/boxed/index.js";
import { setToolsRenderConfig } from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import {
	rebuildTeammateRuns,
	resetTeammateRuns,
	teammateColorForRun,
	teammateForRun,
} from "../../extension-src/pi-style/features/tools/boxed/team-run-labels.js";
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
	closeActiveBatch();
	resetBatchRegistry();
	resetTeammateRuns();
	setToolsRenderConfig({ nerdFonts: false, collapseAfterTurn: false });
});

describe("pi-teams tool presentation", () => {
	it("renders one Agent inline, without guessing omitted mode/model/max turns", () => {
		const a = call("Agent", "a", { name: "fe-fleet", description: "Find frontend entrypoints" });
		const text = plain(a.component.render(120)).join("\n");
		expect(text).toContain("● Spawn teammate @fe-fleet · Find frontend entrypoints");
		expect(text).not.toContain("background");
		expect(text).not.toContain("max 30");
		renderBoxedToolResult(
			"Agent",
			result("{agent:run-1 started}", { agentId: "run-1", background: true }),
			{ expanded: false, isPartial: false },
			theme,
			a.ctx,
		);
		expect(plain(a.component.render(120))[0]).toContain("Spawn background teammate");
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
		expect(lines[0]).toBe("● Spawn 2 background teammates");
		expect(lines[1]).toContain("├─ @fe-fleet · Find frontend entrypoints");
		expect(lines[1]).not.toContain("max 30 turns");
		expect(lines[2]).toContain("└─ @reviewer · Review auth changes · sonnet-4.5");
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
		expect(plain(first.component.render(80))[0]).toContain("Spawn background teammate");
		expect(plain(foreground.component.render(80))[0]).toContain("Spawn foreground teammate");
		renderBoxedToolCall("send_message", { target: "one", message: "hi" }, theme, context("mail", {}));
		const next = call("Agent", "third", { name: "three", run_in_background: false });
		expect(plain(next.component.render(80))[0]).toContain("Spawn foreground teammate");
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
	});

	it("shows the admitted teammate name while waiting, keeping run IDs separate across assignments", () => {
		const first = call("Agent", "spawn-one", { name: "workflow", run_in_background: true });
		const waiting = call("get_subagent_result", "wait-one", { agent_id: "run-one", wait: true });
		expect(plain(waiting.component.render(100))[0]).toBe("● Get result run-one · wait");
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
		expect(plain(waiting.component.render(100))[0]).toBe("● Get result @workflow · wait");
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
		).toBe("● Get result @workflow · wait");
		expect(teammateForRun("run-one")).toBe("workflow");
		expect(teammateForRun("run-two")).toBe("workflow");
		expect(
			plain(
				call("get_subagent_result", "wait-unknown", { agent_id: "run-unknown", wait: true }).component.render(100),
			)[0],
		).toBe("● Get result run-unknown · wait");
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
		expect(receipt).toContain(`${identity}`);
		expect(stripAnsi(receipt)).toBe("└─ @arch-review · completed · ## Status: partial");
		expect(receipt).not.toContain("\x1b[38;2;0;187;221m · completed");
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
		expect(mismatched).toContain("\x1b[38;2;68;102;170m@other-review\x1b[39m");
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
		expect(fallback).toContain("\x1b[38;2;68;102;170m@docs-review\x1b[39m");
		expect(unknown.component.render(100)[0]).toContain("\x1b[38;2;68;102;170m@docs-review\x1b[39m");
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
		).toBe("● Get result @workflow · wait");
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

	it("sends messages with one confirmation and preserves errors", () => {
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const mail = call("send_message", "mail", { target: "reviewer", message: "Check the diff" }, palette);
		expect(plain(mail.component.render(90))[0]).toContain("✉ Message → @reviewer · “Check the diff”");
		expect(mail.component.render(90)[0]).toContain("\x1b[38;2;68;102;170m@reviewer\x1b[39m");
		renderBoxedToolResult(
			"send_message",
			result("Message queued for @reviewer."),
			{ expanded: false, isPartial: false },
			theme,
			mail.ctx,
		);
		expect(plain(mail.component.render(90))[0]).toContain(" · queued");
		const steer = call("steer_subagent", "steer", { agent_id: "run-1", message: "Focus on API" }, palette);
		expect(steer.component.render(90)[0]).toContain("\x1b[38;2;68;102;170m@run-1\x1b[39m");
		const error = renderBoxedToolResult(
			"steer_subagent",
			result("Agent cannot be steered"),
			{ expanded: false, isPartial: false },
			theme,
			steer.ctx,
		);
		expect(plain(error.render(90))[0]).toContain("cannot be steered");
		expect(plain(steer.component.render(90))[0]).not.toContain("accepted");
	});

	it("uses actual task-board JSON and falls back to raw output", () => {
		const list = call("team_task_list", "board", {});
		const tasks = Array.from({ length: 6 }, (_, i) => ({
			title: `Task ${i}`,
			status: "pending",
			blockedBy: i === 0 ? ["x"] : [],
		}));
		const view = renderBoxedToolResult(
			"team_task_list",
			result(JSON.stringify(tasks)),
			{ expanded: false, isPartial: false },
			theme,
			list.ctx,
		);
		expect(plain(list.component.render(80))[0]).toBe("● Team tasks · 6 tasks");
		expect(plain(view.render(80))).toHaveLength(5);
		expect(plain(view.render(80)).join(" ")).toContain("2 more");
		const palette = createFakeTheme({ colors: { accent: "#4466aa" } });
		const owned = { title: "Review APIs", status: "pending", owner: "arch-review" };
		const ownedList = renderBoxedToolResult(
			"team_task_list",
			result(JSON.stringify([owned])),
			{ expanded: false, isPartial: false },
			palette,
			context("owned-list", {}),
		);
		expect(ownedList.render(80)[0]).toContain("\x1b[38;2;68;102;170m@arch-review\x1b[39m");
		const ownedTask = renderBoxedToolResult(
			"team_task_get",
			result(JSON.stringify(owned)),
			{ expanded: false, isPartial: false },
			palette,
			context("owned", {}),
		);
		expect(ownedTask.render(80)[0]).toContain("\x1b[38;2;68;102;170m@arch-review\x1b[39m");
		const fallback = renderBoxedToolResult(
			"team_task_get",
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
		};
		expect(adapters.renderShell).toBe("self");
		const args = { name: "fe-fleet", run_in_background: true, description: "Find frontend" };
		const leader = adapters.renderCall(args, theme, context("public-1", args));
		const second = adapters.renderCall(args, theme, context("public-2", args));
		expect(plain(leader.render(100))[0]).toBe("● Spawn 2 background teammates");
		expect(second.render(100)).toEqual([]);
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
		const notice = renderers.get("teammate-notification")?.(
			{
				content: "Teammate @fe-fleet finished\n\nFound files\nfull result: /tmp/result.md",
				details: { teammateName: "fe-fleet", outcome: "completed", resultFile: "/tmp/result.md" },
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(plain(notice?.render(100) ?? [])).toEqual([
			"● Teammate @fe-fleet finished",
			"  └─ Found files · /tmp/result.md",
		]);
		expect(notice?.render(100)[0]).toContain("\x1b[38;2;68;102;170m@fe-fleet\x1b[39m finished");
		const message = renderers.get("teammate-message")?.(
			{
				content: "Message from @fe-fleet:\n\nFound routes",
				details: { from: "fe-fleet", color: "#00bbdd", untrusted: true },
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(plain(message?.render(80) ?? [])).toEqual(["✉ @fe-fleet → lead · Found routes"]);
		expect(message?.render(80)[0]).toContain("\x1b[38;2;0;187;221m@fe-fleet\x1b[39m → lead");
		const noColor = renderers.get("teammate-message")?.(
			{
				content: "Message from @docs-review:\n\nUpdate",
				details: { from: "docs-review", color: "not-a-color" },
			} as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			palette,
		);
		expect(noColor?.render(100)[0]).toContain("\x1b[38;2;68;102;170m@docs-review\x1b[39m → lead");
		setToolsRenderConfig({ nerdFonts: true });
		expect(plain(message?.render(80) ?? [])[0]).toContain("\uf086 @fe-fleet → lead");
		const malformed = renderers.get("teammate-notification")?.(
			{ content: "Legacy notification", details: {} } as Parameters<MessageRenderer>[0],
			{ expanded: false } as Parameters<MessageRenderer>[1],
			theme,
		);
		expect(plain(malformed?.render(80) ?? []).map((line) => line.trimEnd())).toEqual(["Legacy notification"]);
	});
});
