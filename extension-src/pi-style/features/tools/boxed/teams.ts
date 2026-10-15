// Presentation-only adapters for pi-teams tools. Never read its files or own its run state.
import { pathToFileURL } from "node:url";
import type { Component } from "@earendil-works/pi-tui";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { fgHex, isHexColor, stripAnsi } from "../../../shared/ansi.js";
import type { BoxTheme } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import { type BatchToolMeta, EMPTY_BATCH_COMPONENT, registerBatchCall, registerBatchResult } from "./batch.js";
import { compactToolPath } from "./path.js";
import { isResultSeen, markResultSeen, teamEventGlyph } from "./session-config.js";
import type { BoxedToolDefinition, BoxedToolResult } from "./shared.js";
import { formatDuration, formatTokens, normalizeModelLabel, normalizePreview } from "./shared.js";
import {
	hasTeammateRunHandle,
	rememberTeammateResult,
	rememberTeammateRun,
	rememberTeammateRunHandle,
	settlementForRun,
	settleTeammateRun,
	type TeammateRunSettlement,
	teammateColorForRun,
	teammateForRun,
} from "./team-run-labels.js";

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
	const parts = [who ? styledTeammate(theme, `@${who}`, data.color) : description || theme.fg("dim", "Teammate")];
	if (who && description) parts.push(description);
	// Only the admitted model is authoritative; the canonical ref stays in the
	// detail and collapsed rows clip it to the short label (§3/§6).
	if (typeof data.model === "string") parts.push(clean(data.model, 120));
	if (intent) parts.push(theme.fg("dim", intent));
	if (typeof data.thinking === "string") parts.push(theme.fg("dim", `thinking ${short(data.thinking)}`));
	// Definition pins override max_turns in the invocation. Only an effective
	// limit published by pi-teams is safe to label as the actual maximum.
	if (typeof data.maxTurns === "number" && Number.isSafeInteger(data.maxTurns) && data.maxTurns > 0)
		parts.push(theme.fg("dim", `max ${data.maxTurns} turns`));
	return parts.join(" · ");
}

/** Run-level settlement state of one Agent member (ADR 0012 §1/§5): the glyph
 *  tracks the run, not the tool call — `◌` while a live handle exists, `●`/`✗`/
 *  `○` once settled, `●` from admission when no live state exists (resume). */
function memberEvent(
	member: { runId?: string; isError?: boolean },
	live: boolean,
): {
	glyph: string;
	color: string;
	settlement?: TeammateRunSettlement;
} {
	const settlement = member.runId ? settlementForRun(member.runId) : undefined;
	if (settlement) {
		if (settlement.outcome === "failed") return { glyph: teamEventGlyph("failed"), color: "error", settlement };
		if (settlement.outcome === "stopped") return { glyph: teamEventGlyph("stopped"), color: "dim", settlement };
		return { glyph: teamEventGlyph("settled"), color: "success", settlement };
	}
	if (member.isError) return { glyph: teamEventGlyph("failed"), color: "error" };
	// A live in-process handle means the run is still in flight; without one
	// (resume/replay) the row renders settled from admission, muted — the
	// notification alone claims an outcome. Pre-admission rows track the live
	// execution flag instead (hollow while running, settled on replay).
	const running = member.runId !== undefined ? hasTeammateRunHandle(member.runId) : live;
	return { glyph: teamEventGlyph(running ? "running" : "settled"), color: "muted" };
}

/** ` · 2m 03s · ↓146.5k` line tail from settlement data; absent producer
 *  fields are omitted silently (never fabricated, ADR 0012 §1/§4). */
function settlementTail(settlement: TeammateRunSettlement | undefined): string {
	if (!settlement) return "";
	const parts = [formatDuration(settlement.durationMs), formatTokens(settlement.totalTokens)].filter(
		(part): part is string => part !== undefined,
	);
	return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** Collapsed rows clip the member's admitted model to its short label;
 *  expanded rows keep the canonical full ref (authoritative for Agent.model). */
function memberDetail(member: { detail: string; modelRef?: string }, expanded: boolean): string {
	if (expanded || !member.modelRef) return member.detail;
	return member.detail.split(member.modelRef).join(normalizeModelLabel(member.modelRef));
}

function agentLine(
	theme: BoxTheme,
	batch: {
		leaderId: string;
		members: readonly {
			toolCallId: string;
			detail: string;
			modelRef?: string;
			runId?: string;
			effectiveMode?: "background" | "foreground";
			isError?: boolean;
			errorText?: string;
			noticeText?: string;
			resultText?: string;
			receiptText?: string;
		}[];
	},
	expanded: boolean,
	live: boolean,
): string[] {
	const members = batch.members;
	const events = members.map((member) => memberEvent(member, live));
	const settledCount = events.filter((event, i) => {
		const member = members[i];
		return Boolean(event.settlement || member?.isError || (member?.runId && !hasTeammateRunHandle(member.runId)));
	}).length;
	const failedCount = events.filter((event, i) => event.settlement?.outcome === "failed" || members[i]?.isError).length;
	const headEvent = failedCount
		? { glyph: teamEventGlyph("failed"), color: "error" }
		: settledCount === members.length && members.length > 0
			? { glyph: teamEventGlyph("settled"), color: "success" }
			: { glyph: teamEventGlyph("running"), color: "muted" };
	const max = expanded ? members.length : Math.min(3, members.length);
	const lines: string[] = [];
	if (members.length === 1) {
		const event = events[0] ?? { glyph: teamEventGlyph("running"), color: "muted" };
		const member = members[0];
		lines.push(
			`${theme.fg(event.color, event.glyph)} Agent ${member ? memberDetail(member, expanded) : ""}${settlementTail(event.settlement)}`,
		);
	} else {
		lines.push(
			`${theme.fg(headEvent.color, headEvent.glyph)} Agent (${members.length}) · ${settledCount}/${members.length}`,
		);
		for (let i = 0; i < max; i++) {
			const event = events[i] ?? { glyph: teamEventGlyph("running"), color: "muted" };
			const member = members[i];
			lines.push(
				`${i === members.length - 1 ? "└─" : "├─"} ${theme.fg(event.color, event.glyph)} ${member ? memberDetail(member, expanded) : ""}${settlementTail(event.settlement)}`,
			);
		}
		if (max < members.length) lines.push(`   … ${members.length - max} more · Ctrl+O to expand`);
	}
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
		const self = batch.members.find((item) => item.toolCallId === context.toolCallId);
		const cachedData = details(cached ?? {});
		if (self && typeof cachedData.model === "string") self.modelRef = clean(cachedData.model, 120);
		if (self && typeof cachedData.agentId === "string") self.runId = cachedData.agentId;
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return rows(() => agentLine(theme, batch, context.expanded, context.executionStarted), 10000);
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
		const data = details(result);
		if (!options.isPartial) {
			const member = batch.members.find((item) => item.toolCallId === context.toolCallId);
			const confirmed =
				data.background === true
					? "background"
					: typeof data.agentId === "string"
						? "foreground"
						: mode === "unspecified"
							? undefined
							: mode;
			if (member && confirmed) member.effectiveMode = confirmed;
			// Run identity + admitted model key the row glyph and the short
			// collapsed label (ADR 0012 §3/§5).
			if (member && typeof data.model === "string") member.modelRef = clean(data.model, 120);
			if (member && typeof data.agentId === "string") member.runId = data.agentId;
		}
		const output = rawText(result);
		const failed = context.isError || data.status === "error" || !!data.error;
		const hasRunIdentity = typeof data.agentId === "string";
		const foreground = data.background === true ? false : hasRunIdentity || mode === "foreground";
		if (!options.isPartial && hasRunIdentity) {
			if (foreground) {
				// A foreground run settles with its own tool result — there is no
				// completion notification to supersede the row (ADR 0012 §5).
				settleTeammateRun(data.agentId, { outcome: failed ? "failed" : "completed" });
			} else if (context.executionStarted) {
				// A live background run stays hollow until the completion
				// notification supersedes it (ADR 0012 §5). Replayed results do
				// not register handles, so resumed rows render `●` from admission.
				rememberTeammateRunHandle(data.agentId, { state: context.state, invalidate: context.invalidate });
			}
		}
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
/** Shared minimal message card (ADR 0012 §9). The collapsed line answers only
 *  "who → whom"; the body lives entirely behind expansion; receipts are dropped
 *  because the settled glyph itself is the receipt (success quiet, failure
 *  loud). No envelope glyph exists anywhere. */
function messageTool(
	key: "target" | "agent_id",
	head: (label: string) => string,
	failurePrefix: string,
	accepted: RegExp,
): BoxedToolDefinition {
	// The thinking-quote rail language, not tree rows: 2-space indent + `│ ` on
	// every physical line including blanks (ADR 0012 §9).
	const quoteRows = (body: string): string[] =>
		physicalLines(body).map((line) => (line.trim() ? `  │ ${line.replace(/\s+$/, "")}` : "  │"));
	return {
		call: (args, theme, context) => {
			const label = teammateLabel(args, key, theme);
			const hasBody = typeof args.message === "string" && args.message.trim() !== "";
			// The failure state is written by the result renderer; reading it inside
			// the render closure keeps the one-line card current (ADR 0012 §9).
			const cardLines = (expanded: boolean): string[] => {
				const failure =
					typeof context.state.teamMessageFailure === "string" ? context.state.teamMessageFailure : undefined;
				const glyph = failure
					? theme.fg("error", teamEventGlyph("failed"))
					: theme.fg("muted", teamEventGlyph("settled"));
				const headLine = failure ? `${glyph} ${head(label)} · ${failurePrefix}${failure}` : `${glyph} ${head(label)}`;
				if (!expanded) return [`${headLine}${hasBody && !failure ? theme.fg("dim", " (Ctrl+O to expand)") : ""}`];
				const rails = hasBody && typeof args.message === "string" ? quoteRows(args.message) : [];
				return [headLine, ...rails];
			};
			if (!context.expanded) return rows(() => cardLines(false), 1);
			const railCount = hasBody && typeof args.message === "string" ? physicalLines(args.message).length : 0;
			return rows(() => cardLines(true), 1 + railCount);
		},
		result: (result, options, _theme, context) => {
			if (options.isPartial) return empty;
			const text = rawText(result);
			// Success stays quiet; a failure re-renders the call card loud via the
			// stored reason (ADR 0012 §9). Malformed text still degrades to a
			// cleaned plain reason — nothing is lost verbatim beyond the budget.
			if (!accepted.test(text)) context.state.teamMessageFailure = clean(text, 200) || "failed";
			return empty;
		},
	};
}

export const sendMessageTool = messageTool(
	"target",
	(label) => `Message to ${label}`,
	"not sent: ",
	/^Message queued for @/,
);
export const steerTool = messageTool("agent_id", (label) => `Steer to ${label}`, "", /^Steering accepted/);

// get_subagent_result returns a formatted text record, not structured details.
// A malformed or changed record remains accessible verbatim when expanded.
export const getAgentResultTool: BoxedToolDefinition = {
	call(args, theme, context) {
		return rows(() => {
			const teammate = teammateForRun(args.agent_id);
			const label = typeof teammate === "string" ? `@${teammate}` : short(args.agent_id) || "teammate";
			const styledLabel = teammate ? styledTeammate(theme, label, teammateColorForRun(args.agent_id)) : label;
			// `◌ Get result @name` while waiting; `●` once the result exists (§8).
			const glyph = theme.fg("muted", teamEventGlyph(isResultSeen(context.state) ? "settled" : "running"));
			return [`${glyph} Get result ${styledLabel}${args.wait === true ? " · wait" : ""}`];
		}, 1);
	},
	result(result, options, theme, context) {
		markResultSeen(context.state);
		if (options.isPartial) return empty;
		const text = stripAnsi(rawText(result));
		const admitted = teammateForRun(context.args.agent_id);
		rememberTeammateResult(context.args.agent_id, text);
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
		// Collapsed: the shared preview collapse (§2) parses the record header as
		// labeled fields and drops `Type:`/`Teammate:` noise so `@name` never
		// prints twice (§8). Malformed records fall back to cleaned verbatim lines.
		const preview = normalizePreview(text, { dropFields: ["Type", "Teammate"] }) || clean(text, 160) || "(no output)";
		return rows(() => [theme.fg("dim", `└ ${preview}`)], 1);
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
/** Full outcome dump used only by the tasks_get detail (ADR 0013: that
 *  surface's rendering stays byte-identical, so its audit shape is pinned
 *  here instead of following the delta-card formatter below). */
function auditOutcomeLines(outcome: unknown, theme: BoxTheme, expanded = false): string[] {
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

/** Outcome compression (ADR 0013 §2): counts only — `4 checks: 4 passed ·
 *  1 issue remaining · 3 artifacts`. Failed checks never hide inside the
 *  counts; they also break out into their own loud rows (see failedCheckRows). */
function outcomeCompression(outcome: unknown): string {
	if (!isRecord(outcome)) return "";
	const segments: string[] = [];
	const verification = Array.isArray(outcome.verification) ? outcome.verification.filter(isRecord) : [];
	if (verification.length > 0) {
		const passed = verification.filter((item) => item.outcome === "passed").length;
		const failed = verification.filter((item) => item.outcome === "failed").length;
		segments.push(
			`${verification.length} check${verification.length === 1 ? "" : "s"}: ${passed} passed${failed > 0 ? ` · ${failed} failed` : ""}`,
		);
	}
	const issues = Array.isArray(outcome.remainingIssues) ? outcome.remainingIssues : [];
	if (issues.length > 0) segments.push(`${issues.length} issue${issues.length === 1 ? "" : "s"} remaining`);
	const artifacts = Array.isArray(outcome.artifacts) ? outcome.artifacts : [];
	if (artifacts.length > 0) segments.push(`${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`);
	return segments.join(" · ");
}

/** Every failed verification check as its own loud `✗ <check>` row (ADR 0013
 *  §2): successes compress, failures never do. */
function failedCheckRows(outcome: unknown, theme: BoxTheme): string[] {
	if (!isRecord(outcome) || !Array.isArray(outcome.verification)) return [];
	return outcome.verification
		.filter(isRecord)
		.filter((item) => item.outcome === "failed")
		.map((item) => (typeof item.check === "string" ? clean(item.check, 300) : ""))
		.filter(Boolean)
		.map((check) => theme.fg("error", `✗ ${check}`));
}

/** Clip one artifact path for a delta-card row (ADR 0013 §3); real absolute
 *  paths additionally hyperlink via the existing capability logic. */
function artifactRow(path: string, branch: string, theme: BoxTheme): string {
	const clipped = compactToolPath(path, 48);
	const link =
		path.startsWith("/") && getCapabilities().hyperlinks ? hyperlink(clipped, pathToFileURL(path).href) : clipped;
	return theme.fg("dim", `  ${branch} ↗ ${link}`);
}

/** Outcome formatter for delta cards (ADR 0013 §2/§3) — the single place task
 *  outcomes are formatted outside the pinned tasks_get audit dump. Collapsed:
 *  the count compression plus loud failed-check rows. Expanded: `│ `-railed
 *  Summary rows, `↗` artifact tree rows with middle-clipped paths, `✓/✗`
 *  verification rows with the first evidence line, railed remaining issues. */
function outcomeLines(outcome: unknown, theme: BoxTheme, expanded = false): string[] {
	if (!isRecord(outcome)) return [];
	if (!expanded) {
		const compression = outcomeCompression(outcome);
		return compression
			? [theme.fg("dim", compression), ...failedCheckRows(outcome, theme)]
			: failedCheckRows(outcome, theme);
	}
	const lines: string[] = [];
	const rail = (text: string): string => theme.fg("dim", text.trim() ? `  │ ${text.replace(/\s+$/, "")}` : "  │");
	if (typeof outcome.summary === "string") {
		const physical = physicalLines(outcome.summary);
		if (physical.length > 0)
			lines.push(rail(`Summary: ${physical[0] ?? ""}`), ...physical.slice(1).map((line) => rail(line)));
	}
	const artifacts = Array.isArray(outcome.artifacts)
		? outcome.artifacts.map((path) => clean(path, 500)).filter(Boolean)
		: [];
	for (const [index, path] of artifacts.entries())
		lines.push(artifactRow(path, index === artifacts.length - 1 ? "└─" : "├─", theme));
	const verification = Array.isArray(outcome.verification) ? outcome.verification.filter(isRecord) : [];
	for (const item of verification) {
		const failed = item.outcome === "failed";
		const glyph = failed ? "✗" : item.outcome === "passed" ? "✓" : "○";
		const check = typeof item.check === "string" ? clean(item.check, 1000) : "";
		const evidence =
			typeof item.evidence === "string"
				? stripAnsi(item.evidence)
						.split("\n")
						.map((line) => clean(line, 1000))
						.find(Boolean)
				: undefined;
		lines.push(theme.fg(failed ? "error" : "dim", `  ${glyph} ${check}${evidence ? ` — ${evidence}` : ""}`));
	}
	const issues = Array.isArray(outcome.remainingIssues) ? outcome.remainingIssues : [];
	for (const issue of issues)
		if (typeof issue === "string") {
			const physical = physicalLines(issue);
			if (physical.length > 0)
				lines.push(rail(`Remaining: ${physical[0] ?? ""}`), ...physical.slice(1).map((line) => rail(line)));
		}
	return lines;
}

/** Mutation delta row (ADR 0013 §1): verb + actor per status, with the outcome
 *  compression tail for completed results. Undefined for unmapped statuses —
 *  the caller falls back to the existing `code · title · status` summary
 *  (fail-closed, never invented verbs). */
function taskDelta(name: string, task: Task, theme: BoxTheme): string | undefined {
	const code = taskCode(task);
	const status = clean(task.status, 24);
	const owner = short(task.owner ?? task.assignee);
	const actor = owner ? ` · ${styledTeammate(theme, `@${owner}`)}` : "";
	if (name === "tasks_create") return `${code} created${status ? ` · ${status}` : ""}`;
	if (name === "tasks_cancel") return `${code} cancelled`;
	if (name === "tasks_update") {
		if (status === "in_progress") return `${code} claimed${actor}`;
		if (status === "in_review") return `${code} submitted for review${actor}`;
		if (status === "pending") return `${code} claim released`;
		if (status === "completed") {
			const compression = outcomeCompression(task.outcome);
			return `${code} accepted${actor}${compression ? ` · ${compression}` : ""}`;
		}
	}
	return undefined;
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
					if (attempt.result) lines.push(...auditOutcomeLines(attempt.result, theme, true));
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
	if (task.outcome) lines.push(...auditOutcomeLines(task.outcome, theme, true));
	return lines;
}
const textResult = (result: BoxedToolResult): string => rawText(result);

/** Display-name dedupe normalization (§6): lowercase, non-alphanumerics stripped. */
const normalizeModelToken = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `provider/modelId — Name` row parser for the list_models card (ADR 0012
 *  §6). Returns undefined unless every content line parses — anything else
 *  keeps the verbatim fail-closed fallback. A trailing `N of M matching models
 *  shown` line lifts into the header. */
function parseModelRows(
	raw: string,
): { rows: { ref: string; display?: string }[]; shown?: { n: number; m: number } } | undefined {
	const lines = raw
		.split("\n")
		.map((line) => stripAnsi(line).trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const trailer = /^(\d+) of (\d+) matching models shown$/.exec(lines.at(-1) ?? "");
	const contentLines = trailer ? lines.slice(0, -1) : lines;
	if (contentLines.length === 0) return undefined;
	const rows: { ref: string; display?: string }[] = [];
	for (const line of contentLines) {
		const match = /^(\S+) — (.+)$/.exec(line);
		if (!match) return undefined;
		rows.push({ ref: match[1] ?? "", ...(match[2]?.trim() ? { display: match[2]?.trim() } : {}) });
	}
	if (!trailer) return { rows };
	const n = Number(trailer[1]);
	const m = Number(trailer[2]);
	if (!Number.isSafeInteger(n) || !Number.isSafeInteger(m)) return undefined;
	return { rows, shown: { n, m } };
}

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
				// Mutation results answer "what changed" (ADR 0013 §1); tasks_get
				// reads and unmapped/error results keep the full summary line.
				const delta = !error ? taskDelta(name, value, theme) : undefined;
				if (delta === undefined) {
					const lines = [`${prefix}${taskSummary(value, theme)}`];
					if (value.outcome) lines.push(...outcomeLines(value.outcome, theme, options.expanded));
					if (options.expanded && typeof value.description === "string")
						lines.push(...value.description.split("\n").map((line) => `  ${clean(line, 2000)}`));
					return rows(() => lines, 8);
				}
				// Delta rows hang from the dash-less `└` card family (ADR 0013 §1);
				// tree glyphs stay reserved for tasks_list/tasks_get rows. Failed-check
				// breakouts are collapsed-only — expanded rows carry full ✓/✗ detail.
				const lines = [
					`${theme.fg("dim", "└ ")}${delta}`,
					...(options.expanded ? [] : failedCheckRows(value.outcome, theme)),
				];
				if (options.expanded) {
					if (value.outcome) lines.push(...outcomeLines(value.outcome, theme, true));
					if (typeof value.description === "string")
						lines.push(...value.description.split("\n").map((line) => `  ${clean(line, 2000)}`));
				}
				return rows(() => lines, options.expanded ? 10000 : 8);
			}
			if (name === "tasks_execute" && isRecord(value)) {
				const task = isRecord(value.task) ? value.task : {};
				const attempt = Array.isArray(task.attempts) ? task.attempts.at(-1) : undefined;
				const teammate = clean(isRecord(attempt) ? attempt.teammateName : "", 64);
				const actor = teammate ? styledTeammate(theme, `@${teammate}`) : "teammate";
				const status = clean(task.status, 24);
				// `T5 · in_progress · attempt → @teammate` — no disclaimer row; the
				// model still reads the disclaimer in the tool text (ADR 0013 §1).
				const lines = [
					`${error ? prefix : theme.fg("dim", "└ ")}${taskCode(task)}${status ? ` · ${status}` : ""} · attempt → ${actor}`,
				];
				const runId = clean(value.runId, 100);
				if (options.expanded && runId) lines.push(theme.fg("dim", `  run ${runId}`));
				return rows(() => lines, 2);
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
				if (output) {
					if (options.expanded) lines.push(...output.split("\n").map((line) => `  ${clean(line, 2000)}`));
					else
						lines.push(
							theme.fg(
								"dim",
								`  └ ${normalizePreview(output, { dropFields: ["Status", "Teammate"] }) || clean(output, 180)}`,
							),
						);
				}
				return rows(() => lines, options.expanded ? 10000 : 3);
			}
			if (name === "tasks_stop" && isRecord(value)) {
				const task = isRecord(value.task) ? value.task : { id: context.args.id };
				const code = taskCode(task);
				const stopped = value.stopped === true;
				const text = stopped ? `${code} attempt stop requested`.trim() : "no running attempt";
				const line = error ? `${prefix}${text}` : stopped ? `${theme.fg("dim", "└ ")}${text}` : text;
				return rows(() => [line], 1);
			}
			if (name === "list_models" && !error) {
				const parsed = parseModelRows(raw);
				if (parsed) {
					const query = clean(context.args.query, 60);
					const shown = parsed.shown ? ` · ${parsed.shown.n}/${parsed.shown.m}` : "";
					const header = `${theme.fg("muted", teamEventGlyph("settled"))} Models${query ? ` · ${query}` : ""}${shown}`;
					// Collapsed rows show the id tail; expanded rows and the single-match
					// `└` row keep the canonical full ref — the copyable payload (§6).
					const label = (row: { ref: string; display?: string }): string => {
						const full = options.expanded || parsed.rows.length === 1;
						const id = full ? row.ref : normalizeModelLabel(row.ref);
						const display =
							row.display && normalizeModelToken(row.display) !== normalizeModelToken(normalizeModelLabel(row.ref))
								? ` — ${row.display}`
								: "";
						return `${id}${display}`;
					};
					const bodyRows = parsed.rows.map((row, index) =>
						theme.fg("dim", `${index === parsed.rows.length - 1 ? "└─" : "├─"} ${label(row)}`),
					);
					const count = options.expanded ? bodyRows.length : 4;
					return rows(
						() => [
							header,
							...bodyRows.slice(0, count),
							...(bodyRows.length > count
								? [theme.fg("dim", `   … ${bodyRows.length - count} more · Ctrl+O to expand`)]
								: []),
						],
						count + 1,
					);
				}
				// Unparseable results keep the verbatim fail-closed fallback (§6).
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
