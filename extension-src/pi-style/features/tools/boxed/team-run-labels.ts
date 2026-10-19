// Presentation-only lookup: Pi's saved Agent tool results bind each run ID to
// its teammate name and optional admitted color. Never resolve an assignment by
// name or read pi-teams state.
import { isHexColor } from "../../../shared/ansi.js";

const teammateByRunId = new Map<string, string>();
const colorByRunId = new Map<string, string>();
// Roster identity by name: `send_message` targets, task owners and lifecycle
// receipts publish a name but no run id. Same fail-closed rule as the run
// index — only a color the owning runtime published is stored.
const colorByName = new Map<string, string>();
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function runId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() && value.length <= 256 ? value : undefined;
}
function name(value: unknown): string | undefined {
	return typeof value === "string" && NAME.test(value) ? value : undefined;
}

function bindRun(id: string | undefined, teammate: string | undefined, color: string | undefined): void {
	if (!id || !teammate) return;
	if (teammateByRunId.get(id) !== teammate) colorByRunId.delete(id);
	teammateByRunId.set(id, teammate);
	if (color !== undefined) colorByRunId.set(id, color);
}

function publishedColor(value: unknown): string | undefined {
	return typeof value === "string" && isHexColor(value) ? value : undefined;
}

export function rememberTeammateRun(details: unknown, args?: Record<string, unknown>): void {
	const data = record(details);
	const teammate = name(data?.teammateName) ?? name(args?.name);
	// Colors are authoritative only when published by the owning runtime.
	const color = publishedColor(data?.color);
	bindRun(runId(data?.agentId), teammate, color);
	if (teammate && color) colorByName.set(teammate, color);
}

/** Remember a lifecycle receipt (`teammate_status`/`teammate_release` details
 *  carry `name` + `color` and the run ids that address the teammate). Steer and
 *  get-result calls address runs that may have no Agent receipt in this session
 *  branch (task execution runs, resumed/forked history), so every published run
 *  id binds to the name here. */
export function rememberTeammateIdentity(details: unknown): void {
	const data = record(details);
	const teammate = name(data?.name);
	if (!teammate) return;
	const color = publishedColor(data?.color);
	if (color) colorByName.set(teammate, color);
	bindRun(runId(data?.currentRunId), teammate, color);
	bindRun(runId(data?.lastRunId), teammate, color);
}

/** Bind the run ids a task projection publishes (`attempts[].runId` +
 *  `teammateName`, and the `runId` returned by `tasks_execute`) so legacy or
 *  task-spawned runs resolve to their teammate in steer/get cards. */
export function rememberTaskRuns(task: unknown, runIdHint?: unknown): void {
	const data = record(task);
	if (!data) return;
	const attempts = Array.isArray(data.attempts) ? data.attempts : [];
	for (const item of attempts) {
		const attempt = record(item);
		bindRun(runId(attempt?.runId), name(attempt?.teammateName), undefined);
	}
	const last = record(attempts.at(-1));
	bindRun(runId(runIdHint), name(last?.teammateName), undefined);
}

export function rememberTeammateResult(agentId: unknown, text: string): void {
	const teammate = /^Teammate: @([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s|$)/m.exec(text)?.[1];
	const id = runId(agentId);
	if (id && teammate) {
		if (teammateByRunId.get(id) !== teammate) colorByRunId.delete(id);
		teammateByRunId.set(id, teammate);
	}
}

export function teammateForRun(agentId: unknown): string | undefined {
	const id = runId(agentId);
	return id ? teammateByRunId.get(id) : undefined;
}

export function teammateColorForRun(agentId: unknown): string | undefined {
	const id = runId(agentId);
	return id ? colorByRunId.get(id) : undefined;
}

/** Identity color for a teammate name. The name index is written in session
 *  order, so a reused name with a new color keeps the latest admitted color. */
export function teammateColorForName(teammate: unknown): string | undefined {
	const value = name(teammate);
	return value ? colorByName.get(value) : undefined;
}

/** Terminal run data written by the teammate-notification renderer (ADR 0012
 *  §5). Duration/token fields are optional producer details; absent fields are
 *  omitted silently by renderers, never fabricated. */
export interface TeammateRunSettlement {
	outcome: "completed" | "failed" | "stopped";
	durationMs?: number;
	totalTokens?: number;
}

/** Live Agent tool-call render handle, stored at result registration so the
 *  notification renderer can flip the spawn row in-process (ADR 0012 §5). */
interface TeammateRunHandle {
	state: Record<string, unknown>;
	invalidate: () => void;
}

const settlementByRunId = new Map<string, TeammateRunSettlement>();
const handleByRunId = new Map<string, TeammateRunHandle>();

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Store the render handle of a live Agent tool call (ADR 0012 §5). Replayed
 *  results do not register handles, so resumed rows render `●` from admission
 *  (the documented replay bound: hosts that re-invoke result renderers with
 *  live semantics degrade replayed rows to `◌`). */
export function rememberTeammateRunHandle(agentId: unknown, handle: TeammateRunHandle): void {
	const id = runId(agentId);
	if (id) handleByRunId.set(id, handle);
}

export function hasTeammateRunHandle(agentId: unknown): boolean {
	const id = runId(agentId);
	return id !== undefined && handleByRunId.has(id);
}

/** Write terminal run data and re-render the live spawn row (ADR 0012 §5).
 *  Invalid outcomes are ignored (fail-closed); the write itself is replay-safe
 *  and works without a live handle. */
export function settleTeammateRun(agentId: unknown, settlement: TeammateRunSettlement): void {
	const id = runId(agentId);
	if (!id || !(["completed", "failed", "stopped"] as const).includes(settlement.outcome)) return;
	const durationMs = numberOrUndefined(settlement.durationMs);
	const totalTokens = numberOrUndefined(settlement.totalTokens);
	settlementByRunId.set(id, {
		outcome: settlement.outcome,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
	});
	handleByRunId.get(id)?.invalidate();
}

export function settlementForRun(agentId: unknown): TeammateRunSettlement | undefined {
	const id = runId(agentId);
	return id ? settlementByRunId.get(id) : undefined;
}

export function resetTeammateRuns(): void {
	teammateByRunId.clear();
	colorByRunId.clear();
	colorByName.clear();
	settlementByRunId.clear();
	handleByRunId.clear();
}

/** Rebuild from the selected session branch, not the full file: forks and
 * session switches must not inherit identities from unrelated runs. */
export function rebuildTeammateRuns(entries: readonly unknown[]): void {
	resetTeammateRuns();
	const argsByCall = new Map<string, Record<string, unknown>>();
	for (const entry of entries) {
		const item = record(entry);
		if (item?.type !== "message") continue;
		const message = record(item.message);
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				const call = record(part);
				if (
					call?.type === "toolCall" &&
					(call.name === "Agent" || call.name === "get_subagent_result") &&
					typeof call.id === "string"
				)
					argsByCall.set(call.id, record(call.arguments) ?? {});
			}
		} else if (message?.role === "toolResult" && message.toolName === "Agent") {
			const args = typeof message.toolCallId === "string" ? argsByCall.get(message.toolCallId) : undefined;
			rememberTeammateRun(message.details, args);
		} else if (message?.role === "toolResult" && message.toolName === "get_subagent_result") {
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.map((part) => record(part))
				.filter((part) => part?.type === "text" && typeof part.text === "string")
				.map((part) => part?.text as string)
				.join("\n");
			const args = typeof message.toolCallId === "string" ? argsByCall.get(message.toolCallId) : undefined;
			rememberTeammateResult(args?.agent_id, text);
		}
	}
}
