// Presentation-only adapters for pi-teams tools. Never read its files or own its run state.
import type { Component } from "@earendil-works/pi-tui";
import { fgHex, isHexColor, stripAnsi } from "../../../shared/ansi.js";
import type { BoxTheme } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import { type BatchToolMeta, EMPTY_BATCH_COMPONENT, registerBatchCall, registerBatchResult } from "./batch.js";
import { getToolsRenderConfig } from "./session-config.js";
import type { BoxedToolDefinition, BoxedToolResult } from "./shared.js";
import { rememberTeammateResult, rememberTeammateRun, teammateColorForRun, teammateForRun } from "./team-run-labels.js";

export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set([
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"send_message",
	"teammate_status",
	"teammate_release",
	"teammate_retire",
	"list_models",
	"tasks_create",
	"tasks_list",
	"tasks_get",
	"tasks_update",
	"tasks_cancel",
	"tasks_execute",
	"tasks_output",
	"tasks_stop",
	// Legacy names remain presentation-only aliases for saved sessions.
	"team_task_create",
	"team_task_update",
	"team_task_get",
	"team_task_list",
]);

const agentMeta = (mode: string): BatchToolMeta => ({
	toolName: `Agent:${mode}`,
	label: "Teammate",
});
const empty: Component = { render: () => [], invalidate() {} };
const clean = (value: unknown, limit = 220): string =>
	typeof value === "string"
		? stripAnsi(value)
				.replace(/\p{Cc}/gu, " ")
				.trim()
				.slice(0, limit)
		: "";
const short = (value: unknown): string => clean(value, 24);
const physicalLines = (value: string): string[] =>
	stripAnsi(value)
		.split(/\r\n|\r|\n/)
		.map((line) => line.replace(/\p{Cc}/gu, " "));
const rawText = (result: BoxedToolResult): string =>
	(result.content ?? [])
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
const details = (result: BoxedToolResult): Record<string, unknown> =>
	result.details && typeof result.details === "object" && !Array.isArray(result.details)
		? (result.details as Record<string, unknown>)
		: {};
// Do not assume the pi-teams setting backgroundByDefault: omission does not
// establish an effective mode. Explicit modes split adjacent batches.
const modeKey = (args: Record<string, unknown>): "background" | "foreground" | "unspecified" =>
	args.run_in_background === true ? "background" : args.run_in_background === false ? "foreground" : "unspecified";
const plural = (n: number): string => (n === 1 ? "teammate" : "teammates");
const glyph = (): string => (getToolsRenderConfig().nerdFonts ? "\uf086" : "✉");
// An absent pi-teams color gets the theme's generic accent, not an invented
// teammate-specific color. Keep the ANSI span limited to the @reference.
const styledTeammate = (theme: BoxTheme, label: string, color?: unknown): string =>
	typeof color === "string" && isHexColor(color) ? fgHex(theme, color, label) : theme.fg("accent", label);

function rows(lines: () => string[], max = 8): Component {
	return {
		invalidate() {},
		render(width: number) {
			if (width < 8) return [];
			return lines()
				.slice(0, max)
				.map((line) => safeTruncateToWidth(line, width));
		},
	};
}
function simple(text: string, theme: BoxTheme): Component {
	return rows(() => [theme.fg("dim", text)], 1);
}
function agentDetail(args: Record<string, unknown>, theme: BoxTheme, result?: BoxedToolResult): string {
	const data = details(result ?? {});
	const who = short(data.teammateName) || short(args.name);
	const description = clean(args.description, 100);
	// Distinguish only explicit context policy or explicit cold-resume intent.
	const intent =
		typeof args.resume === "string"
			? "resume"
			: args.context === "fresh"
				? "fresh"
				: args.context === "continue"
					? "continue"
					: "";
	// Color and name are optional metadata from the owning runtime, never
	// inferred from specialist definitions or teammate names.
	const parts = [who ? styledTeammate(theme, `@${who}`, data.color) : description || "Teammate"];
	if (intent) parts.push(intent);
	if (who && description) parts.push(description);
	// Only the admitted model is authoritative; retain its canonical ref.
	if (typeof data.model === "string") parts.push(clean(data.model, 120));
	if (typeof data.thinking === "string") parts.push(`thinking ${short(data.thinking)}`);
	// Definition pins override max_turns in the invocation. Only an effective
	// limit published by pi-teams is safe to label as the actual maximum.
	if (typeof data.maxTurns === "number" && Number.isSafeInteger(data.maxTurns) && data.maxTurns > 0)
		parts.push(`max ${data.maxTurns} turns`);
	return parts.join(" · ");
}
function agentLine(
	theme: BoxTheme,
	batch: {
		leaderId: string;
		members: readonly {
			toolCallId: string;
			detail: string;
			effectiveMode?: "background" | "foreground";
			isError?: boolean;
			errorText?: string;
			noticeText?: string;
			resultText?: string;
			receiptText?: string;
		}[];
	},
	mode: string,
	expanded: boolean,
): string[] {
	const members = batch.members;
	const confirmed =
		mode === "unspecified" && members.every((m) => m.effectiveMode === "background")
			? "background"
			: mode === "unspecified" && members.every((m) => m.effectiveMode === "foreground")
				? "foreground"
				: mode;
	const title = `${theme.fg("muted", "●")} Spawn ${members.length === 1 ? "" : `${members.length} `}${confirmed === "unspecified" ? "" : `${confirmed} `}${plural(members.length)}`;
	const max = expanded ? members.length : Math.min(3, members.length);
	const lines = [title];
	if (members.length === 1) lines[0] += ` ${members[0]?.detail ?? ""}`;
	if (members.length > 1)
		for (let i = 0; i < max; i++) lines.push(`${i === members.length - 1 ? "└─" : "├─"} ${members[i]?.detail ?? ""}`);
	if (max < members.length) lines.push(`   … ${members.length - max} more · Ctrl+O to expand`);
	for (const member of members) {
		const foreground = member.effectiveMode === "foreground";
		const ownLeader = member.toolCallId === batch.leaderId;
		const firstDetail = stripAnsi(member.detail).split(" · ", 1)[0] ?? "";
		const attribution = firstDetail.startsWith("@") ? firstDetail : "teammate";
		const appendReceipt = (kind: string, value: string, color: string): void => {
			const receiptLines = expanded ? physicalLines(value) : [clean(value, 160)];
			lines.push(theme.fg("dim", `   └─ ${attribution}`));
			lines.push(
				...receiptLines.map((line, index) => theme.fg(color, `      ${index === 0 ? `${kind}: ` : ""}${line}`)),
			);
		};
		if (member.isError && member.errorText) appendReceipt("ERROR", member.errorText, "error");
		if (member.noticeText) appendReceipt("NOTICE", member.noticeText, "warning");
		if (member.receiptText) appendReceipt("RECEIPT", member.receiptText, "dim");
		if (member.resultText && foreground && !ownLeader) appendReceipt("Answer", member.resultText, "dim");
	}
	if (lines.length > 10000) {
		const omitted = lines.length - 9999;
		lines.splice(9999);
		lines.push(`… ${omitted} teammate receipt lines omitted`);
	}
	return lines;
}

export const agentTool: BoxedToolDefinition = {
	call(args, theme, context) {
		const mode = modeKey(args);
		const known = context.state.teamAgentDetails;
		const cached = known && typeof known === "object" ? { details: known } : undefined;
		const { batch, isLeader } = registerBatchCall(agentMeta(mode), agentDetail(args, theme, cached), context);
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return rows(() => agentLine(theme, batch, mode, context.expanded), 10000);
	},
	result(result, options, theme, context) {
		const mode = modeKey(context.args);
		// Save authoritative admission metadata on Pi's per-call renderer state,
		// so later call re-renders cannot erase it with invocation-only arguments.
		if (!options.isPartial && result.details && typeof result.details === "object") {
			context.state.teamAgentDetails = result.details;
			rememberTeammateRun(result.details, context.args);
		}
		const { batch } = registerBatchCall(agentMeta(mode), agentDetail(context.args, theme, result), context);
		if (!options.isPartial) {
			const member = batch.members.find((item) => item.toolCallId === context.toolCallId);
			const confirmed =
				details(result).background === true
					? "background"
					: typeof details(result).agentId === "string"
						? "foreground"
						: mode === "unspecified"
							? undefined
							: mode;
			if (member && confirmed) member.effectiveMode = confirmed;
		}
		const data = details(result);
		const output = rawText(result);
		const failed = context.isError || data.status === "error" || !!data.error;
		const hasRunIdentity = typeof data.agentId === "string";
		const foreground = data.background === true ? false : hasRunIdentity || mode === "foreground";
		const validationReceipt = !failed && !hasRunIdentity && data.background !== true && output.length > 0;
		const failureText = output || (typeof data.error === "string" ? data.error : "Agent admission failed");
		const notice = [
			data.modelFallback ? `model fallback ${clean(data.modelFallback, 120)}` : "",
			data.budgetExhausted
				? `budget exhausted${typeof data.budgetSeconds === "number" ? ` (${data.budgetSeconds}s)` : ""}`
				: "",
		]
			.filter(Boolean)
			.join(" · ");
		const critical = [failed ? `ERROR ${clean(failureText, 160)}` : "", notice].filter(Boolean).join(" · ");
		registerBatchResult(
			agentMeta(mode),
			{
				isPartial: options.isPartial,
				isError: failed,
				errorText: failed ? failureText : undefined,
				...(notice ? { noticeText: notice } : {}),
				...(!failed && foreground && batch.leaderId !== context.toolCallId ? { resultText: output } : {}),
				...(validationReceipt ? { receiptText: output } : {}),
			},
			context,
		);
		const isLeader = batch.leaderId === context.toolCallId;
		if (!isLeader) return empty;
		if (options.isPartial) return empty;
		const outputLines = physicalLines(output);
		if (options.expanded && output && (foreground || failed || validationReceipt))
			return rows(() => {
				const detailLimit = critical ? 9998 : 9999;
				const omitted = Math.max(0, outputLines.length - detailLimit);
				return [
					...(critical ? [theme.fg(failed ? "error" : "warning", `└─ ${critical}`)] : []),
					...outputLines.slice(0, detailLimit),
					...(omitted ? [`… ${omitted} diagnostic lines omitted`] : []),
				];
			}, 10000);
		if (validationReceipt) return rows(() => [theme.fg("warning", `└─ RECEIPT: ${clean(output, 180)}`)], 1);
		if (critical && !foreground) return empty;
		if (critical && foreground)
			return rows(
				() => [theme.fg(failed ? "error" : "warning", `└─ ${critical}`), ...(output ? [clean(output, 160)] : [])],
				2,
			);
		if (output && foreground) return simple(`└─ ${clean(output, 160)}`, theme);
		return critical ? rows(() => [theme.fg(failed ? "error" : "warning", `└─ ${critical}`)], 1) : empty;
	},
};

function teammateLabel(args: Record<string, unknown>, key: string, theme: BoxTheme): string {
	const value = short(args[key]);
	return value
		? key === "target" && value === "lead"
			? "lead"
			: styledTeammate(theme, `@${value}`, key === "agent_id" ? teammateColorForRun(args[key]) : undefined)
		: "teammate";
}
function messageTool(
	make: (args: Record<string, unknown>, theme: BoxTheme) => string,
	accepted: RegExp,
	confirmation: string,
): BoxedToolDefinition {
	return {
		call: (args, theme, context) =>
			rows(() => [`${make(args, theme)}${context.state.teamMessageAccepted === true ? ` · ${confirmation}` : ""}`], 1),
		result: (result, options, theme, context) => {
			if (options.isPartial) return empty;
			const text = rawText(result);
			if (accepted.test(text)) {
				context.state.teamMessageAccepted = true;
				return options.expanded
					? rows(
							() =>
								stripAnsi(text)
									.split("\n")
									.map((line) => `└─ ${clean(line, 2000)}`),
							20,
						)
					: empty;
			}
			const lines = options.expanded
				? stripAnsi(text)
						.split("\n")
						.map((line) => clean(line, 2000))
				: [clean(text, 200)];
			return rows(
				() => lines.map((line, index) => theme.fg("error", `${index === 0 ? "└─ " : "   "}${line}`)),
				options.expanded ? 40 : 1,
			);
		},
	};
}

export const sendMessageTool = messageTool(
	(args, theme) =>
		`${theme.fg("muted", glyph())} Message → ${teammateLabel(args, "target", theme)} · “${clean(args.message, 100)}”`,
	/^Message queued for @/,
	"queued",
);
export const steerTool = messageTool(
	(args, theme) =>
		`${theme.fg("muted", glyph())} Steer ${teammateLabel(args, "agent_id", theme)} · “${clean(args.message, 100)}”`,
	/^Steering accepted/,
	"accepted",
);

// get_subagent_result returns a formatted text record, not structured details.
// A malformed or changed record remains accessible verbatim when expanded.
export const getAgentResultTool: BoxedToolDefinition = {
	call(args, theme) {
		return rows(() => {
			const teammate = teammateForRun(args.agent_id);
			const label = typeof teammate === "string" ? `@${teammate}` : short(args.agent_id) || "teammate";
			const styledLabel = teammate ? styledTeammate(theme, label, teammateColorForRun(args.agent_id)) : label;
			return [`${theme.fg("muted", "●")} Get result ${styledLabel}${args.wait === true ? " · wait" : ""}`];
		}, 1);
	},
	result(result, options, theme, context) {
		if (options.isPartial) return empty;
		const text = stripAnsi(rawText(result));
		const admitted = teammateForRun(context.args.agent_id);
		rememberTeammateResult(context.args.agent_id, text);
		const status = /^Type:.*\| Status: ([a-z_]+)/m.exec(text)?.[1];
		const teammate = /^Teammate: (@[A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s|$)/m.exec(text)?.[1];
		const color = teammate === `@${admitted}` ? teammateColorForRun(context.args.agent_id) : undefined;
		if (options.expanded)
			return rows(
				() =>
					text.split("\n").map((line) => {
						const prefix = `Teammate: ${teammate}`;
						return teammate && line.startsWith(prefix)
							? `Teammate: ${styledTeammate(theme, teammate, color)}${clean(line.slice(prefix.length), 2000)}`
							: clean(line, 2000);
					}),
				10000,
			);
		const body = text.split("\n\n").slice(1).join(" ").trim();
		const suffix = `${status ? `${teammate ? " · " : ""}${status}` : ""}${(teammate || status) && body ? " · " : ""}${clean(body || text, 160)}`;
		return rows(
			() => [
				`${theme.fg("dim", "└─ ")}${teammate ? styledTeammate(theme, teammate, color) : ""}${theme.fg("dim", suffix)}`,
			],
			1,
		);
	},
};

type Task = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
const taskCode = (task: Task): string => clean(task.code ?? task.id, 32);
function taskSummary(task: Task, theme: BoxTheme): string {
	const parts = [taskCode(task), clean(task.title, 90), clean(task.status, 24)];
	const owner = short(task.owner ?? task.assignee);
	if (owner) parts.push(styledTeammate(theme, `@${owner}`));
	const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : [];
	if (blockers.length) parts.push(`blocked by ${blockers.map((item) => clean(item, 24)).join(",")}`);
	return parts.filter(Boolean).join(" · ");
}
function outcomeLines(outcome: unknown, theme: BoxTheme, expanded = false): string[] {
	if (!isRecord(outcome)) return [];
	const lines: string[] = [];
	const appendText = (label: string, text: string) => {
		const physical = stripAnsi(text)
			.split("\n")
			.map((line) => clean(line, 2000));
		if (expanded)
			lines.push(`${label}${physical[0] ? ` ${physical[0]}` : ""}`, ...physical.slice(1).map((line) => `  ${line}`));
		else lines.push(`${label} ${clean(text, 300)}`);
	};
	if (typeof outcome.summary === "string") appendText("Summary:", outcome.summary);
	if (Array.isArray(outcome.artifacts))
		lines.push(`Artifacts: ${outcome.artifacts.map((x) => clean(x, 240)).join(", ")}`);
	if (Array.isArray(outcome.verification))
		for (const item of outcome.verification)
			if (isRecord(item)) {
				const prefix = `${item.outcome === "failed" ? "✗" : item.outcome === "passed" ? "✓" : "○"} `;
				const check =
					typeof item.check === "string"
						? stripAnsi(item.check)
								.split("\n")
								.map((line) => clean(line, 1000))
						: [""];
				const evidence =
					typeof item.evidence === "string"
						? stripAnsi(item.evidence)
								.split("\n")
								.map((line) => clean(line, 1000))
						: [];
				lines.push(`${prefix}${check[0] ?? ""}${evidence[0] ? ` — ${evidence[0]}` : ""}`);
				if (expanded)
					lines.push(...check.slice(1).map((line) => `  ${line}`), ...evidence.slice(1).map((line) => `  ${line}`));
			}
	if (Array.isArray(outcome.remainingIssues) && outcome.remainingIssues.length)
		for (const issue of outcome.remainingIssues) if (typeof issue === "string") appendText("Remaining:", issue);
	return lines.map((line) => theme.fg("dim", `  ${line}`));
}
function taskDetail(task: Task, theme: BoxTheme): string[] {
	const lines = [`${taskCode(task)} ${clean(task.title, 300)} · ${clean(task.status, 30)}`];
	for (const key of [
		"description",
		"owner",
		"assignee",
		"dependencies",
		"blockedBy",
		"requirementRevision",
		"reviewRequested",
		"executionPlan",
		"createdAt",
		"updatedAt",
		"spec",
		"context",
		"attempts",
	]) {
		const value = task[key];
		if (value === undefined) continue;
		if (key === "attempts" && Array.isArray(value)) {
			lines.push(`Attempts (${value.length}):`);
			for (const attempt of value)
				if (isRecord(attempt)) {
					lines.push(
						`  ${clean(attempt.runId, 80)} · ${clean(attempt.teammateName, 64) || "unassigned"} · ${clean(attempt.status, 24)}${attempt.error ? ` · ERROR ${clean(attempt.error, 500)}` : ""}`,
					);
					if (typeof attempt.partialResult === "string")
						lines.push(...attempt.partialResult.split("\n").map((line) => `    ${clean(line, 2000)}`));
					if (attempt.result) lines.push(...outcomeLines(attempt.result, theme, true));
				}
		} else if (key === "spec" || key === "context" || key === "executionPlan")
			lines.push(
				`${key}:`,
				...JSON.stringify(value, null, 2)
					.split("\n")
					.map((line) => `  ${clean(line, 2000)}`),
			);
		else if (typeof value === "number" || typeof value === "boolean") lines.push(`${key}: ${value}`);
		else if (key === "description" && typeof value === "string")
			lines.push("description:", ...value.split("\n").map((line) => `  ${clean(line, 2000)}`));
		else
			lines.push(`${key}: ${Array.isArray(value) ? value.map((x) => clean(x, 120)).join(", ") : clean(value, 1200)}`);
	}
	if (task.outcome) lines.push(...outcomeLines(task.outcome, theme, true));
	return lines;
}
const textResult = (result: BoxedToolResult): string => rawText(result);
function teamTool(name: string): BoxedToolDefinition {
	return {
		call(args, theme) {
			const labels: Record<string, string> = {
				tasks_create: `Create task · ${clean(args.title, 80)}`,
				tasks_list: `Tasks${args.status ? ` · ${short(args.status)}` : ""}`,
				tasks_get: `Task ${short(args.id)}`,
				tasks_update: `Update ${short(args.id)}${args.status ? ` · ${short(args.status)}` : ""}`,
				tasks_cancel: `Cancel ${short(args.id)}`,
				tasks_execute: `Execute ${short(args.id)} → ${short(args.name) || short(args.type)}`,
				tasks_output: `Output ${short(args.id)}`,
				tasks_stop: `Stop ${short(args.id)}`,
				teammate_status: `Teammate status @${short(args.name)}`,
				teammate_release: `Release @${short(args.name)}`,
				teammate_retire: `Retire @${short(args.name)}`,
				list_models: `Models${args.query ? ` · ${clean(args.query, 60)}` : ""}`,
			};
			return rows(() => [`${theme.fg("muted", "●")} ${labels[name] ?? name}`], 1);
		},
		result(result, options, theme, context) {
			if (options.isPartial) return empty;
			const raw = textResult(result);
			const value = parseJson(raw);
			const receipt = details(result);
			const error =
				context.isError ||
				!!receipt.error ||
				!!receipt.recoveryError ||
				receipt.changed === false ||
				(isRecord(value) && (typeof value.error === "string" || value.recovery !== undefined));
			const prefix = error ? theme.fg("error", "ERROR · ") : theme.fg("dim", "└─ ");
			if (name === "tasks_list" && Array.isArray(value)) {
				const limit = options.expanded ? value.length : 3;
				const list = value
					.slice(0, limit)
					.filter(isRecord)
					.map((task, i) => `${i === Math.min(value.length, limit) - 1 ? "└─" : "├─"} ${taskSummary(task, theme)}`);
				if (value.length > limit) list.push(`   … ${value.length - limit} more · Ctrl+O to expand`);
				return rows(() => list, limit + 1);
			}
			if (isRecord(value) && (typeof value.title === "string" || typeof value.status === "string")) {
				if (name === "tasks_get" && options.expanded) return rows(() => taskDetail(value, theme), 10000);
				const lines = [`${prefix}${taskSummary(value, theme)}`];
				if (value.outcome) lines.push(...outcomeLines(value.outcome, theme, options.expanded));
				if (options.expanded && typeof value.description === "string")
					lines.push(...value.description.split("\n").map((line) => `  ${clean(line, 2000)}`));
				return rows(() => lines, 8);
			}
			if (name === "tasks_execute" && isRecord(value)) {
				const task = isRecord(value.task) ? value.task : {};
				const attempt = Array.isArray(task.attempts) ? task.attempts.at(-1) : undefined;
				const runId = clean(value.runId, 100);
				const lines = [
					`${prefix}${taskCode(task)} ${clean(task.title, 100)} → ${clean(isRecord(attempt) ? attempt.teammateName : "", 64) || "teammate"} → ${runId || "run pending"}`,
				];
				if (typeof task.status === "string")
					lines.push(`Task status: ${clean(task.status, 24)} (attempt execution does not imply task acceptance)`);
				return rows(() => lines, 3);
			}
			if (name === "tasks_output" && isRecord(value)) {
				const attempt = isRecord(value.attempt) ? value.attempt : {};
				const output = typeof value.result === "string" ? value.result : "";
				const status = clean(attempt.status ?? value.status, 32);
				const lines = [
					`${prefix}${status || "attempt status unavailable"}${attempt.teammateName ? ` · @${clean(attempt.teammateName, 64)}` : ""}`,
				];
				if (typeof value.error === "string")
					lines.push(theme.fg("error", `  ERROR ${clean(value.error, options.expanded ? 2000 : 240)}`));
				if (output)
					lines.push(
						...(options.expanded ? output.split("\n").map((line) => clean(line, 2000)) : [clean(output, 180)]).map(
							(line) => `  ${line}`,
						),
					);
				return rows(() => lines, options.expanded ? 10000 : 3);
			}
			if (name === "tasks_stop" && isRecord(value))
				return rows(() => [`${prefix}${value.stopped === true ? "stop requested" : "no running attempt"}`], 1);
			if (name === "list_models") {
				const modelLines = raw.split("\n").map((line) => clean(line, 2000));
				const count = options.expanded ? modelLines.length : 4;
				return rows(
					() => [
						...modelLines.slice(0, count),
						...(modelLines.length > count ? [`… ${modelLines.length - count} more · Ctrl+O to expand`] : []),
					],
					count + 1,
				);
			}
			if (name.startsWith("teammate_")) {
				const data = receipt;
				const status = clean(data.state, 24);
				const availability = clean(data.availability, 32);
				const recovery = clean(data.recoveryError ?? data.recovery, options.expanded ? 1000 : 300);
				const lines = [
					`${error ? theme.fg("error", "ERROR · ") : theme.fg("dim", "└─ ")}@${clean(data.name, 64)}${status ? ` · ${status}` : clean(raw, 200) ? ` · ${clean(raw, 200)}` : ""}${availability ? ` · availability ${availability}` : ""}${typeof data.contextAvailable === "boolean" ? ` · context ${data.contextAvailable ? "available" : "unavailable"}` : ""}`,
				];
				if (recovery) lines.push(theme.fg("error", `  Recovery: ${recovery}`));
				if (data.changed === true) lines.push(theme.fg("dim", "  Task claims unchanged"));
				if (options.expanded && raw) lines.push(...raw.split("\n").map((line) => `  ${clean(line, 1000)}`));
				return rows(() => lines, 8);
			}
			const lines = options.expanded ? raw.split("\n").map((line) => clean(line, 2000)) : [clean(raw, 200)];
			return rows(
				() => lines.map((line, i) => (i === 0 ? `${prefix}${line}` : `  ${line}`)),
				options.expanded ? 50 : 1,
			);
		},
	};
}
export const teamTaskTools: Readonly<Record<string, BoxedToolDefinition>> = Object.fromEntries([
	...[
		"teammate_status",
		"teammate_release",
		"teammate_retire",
		"list_models",
		"tasks_create",
		"tasks_list",
		"tasks_get",
		"tasks_update",
		"tasks_cancel",
		"tasks_execute",
		"tasks_output",
		"tasks_stop",
	].map((name) => [name, teamTool(name)]),
	["team_task_create", teamTool("tasks_create")],
	["team_task_update", teamTool("tasks_update")],
	["team_task_get", teamTool("tasks_get")],
	["team_task_list", teamTool("tasks_list")],
]);
