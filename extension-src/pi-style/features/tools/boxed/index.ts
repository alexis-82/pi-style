// Boxed tool renderer dispatcher.
//
// Maps Pi tool names to their boxed call/result renderers and falls back to a
// boxed generic renderer for unknown tools. The dispatcher is invoked from the
// tool decoration owner when tools.style === "compact-box".

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../../shared/box.js";
import { everyMessageInEndedGroup } from "../../../shared/turn-summary-bridge.js";
import { bashTool } from "./bash.js";
import { closeActiveBatch, EMPTY_BATCH_COMPONENT, isBatchableTool } from "./batch.js";
import { editTool } from "./edit.js";
import { renderFallbackCall, renderFallbackResult } from "./fallback.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { getQuickEditToolConfig, quickEditTool } from "./quick-edit.js";
import { readTool } from "./read.js";
import { getStateElapsedMs, getToolsRenderConfig, recordExecutionEnded, stopElapsedTicker } from "./session-config.js";
import type { BoxedToolContext, BoxedToolDefinition } from "./shared.js";
import { agentTool, getAgentResultTool, sendMessageTool, steerTool, TEAM_TOOL_NAMES, teamTaskTools } from "./teams.js";
import {
	effectiveTurnExpansion,
	emptyTurnResult,
	getTurnEntry,
	isMutatingTool,
	isTurnMemberExpanded,
	noteTurnMemberElapsed,
	noteTurnMemberRender,
	renderTurnSummaryCall,
	renderTurnToggleRow,
	type TurnState,
} from "./turn-summary.js";
import { writeTool } from "./write.js";

function quickEditToolFor(toolName: string): BoxedToolDefinition {
	const config = getQuickEditToolConfig(toolName);
	if (!config) throw new Error(`missing quick-edit config for ${toolName}`);
	return quickEditTool(config);
}

const REGISTRY: Readonly<Record<string, BoxedToolDefinition>> = {
	read: readTool,
	write: writeTool,
	edit: editTool,
	bash: bashTool,
	ls: lsTool,
	find: findTool,
	grep: grepTool,
	Agent: agentTool,
	get_subagent_result: getAgentResultTool,
	steer_subagent: steerTool,
	send_message: sendMessageTool,
	...teamTaskTools,
	quick_edit: quickEditToolFor("quick_edit"),
	substitute_edit: quickEditToolFor("substitute_edit"),
	target_edit: quickEditToolFor("target_edit"),
};

export function hasBoxedRenderer(toolName: unknown): boolean {
	return typeof toolName === "string" && Object.hasOwn(REGISTRY, toolName);
}

/**
 * Turn-summary gate (ADR 0007): the member belongs to an ended turn, Pi's
 * global tool-output state is collapsed, the surface is enabled, and the block
 * is finalized. Merged mode covers errors and mutations too; legacy mode
 * retains the error/mutating exemptions. Native expansion flags always win.
 */
function collapsedTurnFor(toolCallId: string, expanded: boolean, toolName: unknown): TurnState | undefined {
	// The compact team receipts remain visible after the run-wide summary closes.
	if (typeof toolName === "string" && (toolName === "Agent" || TEAM_TOOL_NAMES.has(toolName))) return undefined;
	const config = getToolsRenderConfig();
	if (expanded || !config.collapseAfterTurn) return undefined;
	const entry = getTurnEntry(toolCallId);
	if (!entry?.turn.ended) return undefined;
	// In merged mode the one disclosure owns ALL finalized tools: failures and
	// file changes are represented in its stats and remain accessible on open.
	if (!config.mergedTurnSummary) {
		if (entry.member.isError) return undefined;
		if (isMutatingTool(entry.member.toolName) && !config.collapseMutatingTools) return undefined;
	}
	return entry.turn;
}

function summaryLeaderId(turn: TurnState, keepExpandedOwner = false): string {
	const config = getToolsRenderConfig();
	const configuredLeader = config.mergedTurnSummary ? (turn.members[0]?.toolCallId ?? "") : turn.leaderId;
	// Merged thought labels disclose the whole run independently of a tool row.
	if (hasMergedThoughtLabel(turn)) return configuredLeader;
	const eligible = (member: TurnState["members"][number]): boolean => {
		return (
			!TEAM_TOOL_NAMES.has(member.toolName) &&
			(keepExpandedOwner || !isTurnMemberExpanded(member.toolCallId)) &&
			(config.mergedTurnSummary ||
				(!member.isError && (!isMutatingTool(member.toolName) || config.collapseMutatingTools)))
		);
	};
	// Keep exempt team receipts visible, but put the disclosure on a tool that
	// the active collapse policy will actually hide.
	const configuredMember = turn.members.find((member) => member.toolCallId === configuredLeader);
	if (configuredMember && eligible(configuredMember)) return configuredLeader;
	return turn.members.find(eligible)?.toolCallId ?? configuredLeader;
}

function hasMergedThoughtLabel(turn: TurnState): boolean {
	return getToolsRenderConfig().mergedTurnSummary && everyMessageInEndedGroup(turn.messages);
}

export function renderBoxedToolCall(
	toolName: unknown,
	args: Record<string, unknown>,
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	// Any non-batchable tool call is a batch boundary: the next quiet call starts
	// a fresh batch instead of joining the previous one.
	if (!isBatchableTool(toolName)) closeActiveBatch();
	// Capture the member invalidate even when the turn renders collapsed: the
	// summary-row click toggle re-dispatches every member later (agent_end no
	// longer releases these callbacks).
	noteTurnMemberRender(context.toolCallId, context.invalidate);
	const expanded = effectiveTurnExpansion(context.toolCallId, context.expanded);
	const entry = getTurnEntry(context.toolCallId);
	// Opening a run reveals its tools; it does not request every tool's full
	// output. In particular, read/ls/find must keep their inline/batch panels:
	// their expanded result renderer is a standalone *bottom half* of a box.
	context = { ...context, expanded: expanded && !entry?.turn.forcedOpen };
	const turn = collapsedTurnFor(context.toolCallId, expanded, toolName);
	if (turn) {
		if (summaryLeaderId(turn) === context.toolCallId) {
			// The thought leader owns the sole merged row. Tools-only runs use the
			// same ◈ format here with zero thoughts, never the legacy ➔ duration.
			if (hasMergedThoughtLabel(turn)) return EMPTY_BATCH_COMPONENT;
			return renderTurnSummaryCall(theme, turn);
		}
		// Same singleton the batch machinery uses: the decoration's hideBatchMember
		// (identity-compared) removes the instance so members consume zero lines.
		return EMPTY_BATCH_COMPONENT;
	}
	const tool = typeof toolName === "string" ? REGISTRY[toolName] : undefined;
	// Click-opened turn: the leader keeps its summary row above its normal call
	// so the turn can be closed again; every member renders its normal block.
	// A merged thought leader already supplies the close affordance, so never
	// reintroduce a second tool-summary row beneath it.
	if (
		entry?.turn.ended === true &&
		collapsedTurnFor(context.toolCallId, false, toolName) !== undefined &&
		entry.turn.forcedOpen &&
		expanded &&
		!hasMergedThoughtLabel(entry.turn) &&
		summaryLeaderId(entry.turn, true) === context.toolCallId
	) {
		const child = tool ? tool.call(args, theme, context) : renderFallbackCall(toolName, args, theme, context);
		return renderTurnToggleRow(theme, entry.turn, child);
	}
	if (tool) return tool.call(args, theme, context);
	return renderFallbackCall(toolName, args, theme, context);
}

export function renderBoxedToolResult(
	toolName: unknown,
	result: { content?: readonly unknown[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	noteTurnMemberRender(context.toolCallId, context.invalidate);
	// The collapse gate must not skip terminal lifecycle cleanup. Otherwise a
	// hidden tool's ticker keeps running and its elapsed grows while idle.
	if (!options.isPartial) {
		recordExecutionEnded(context.state);
		stopElapsedTicker(context.state);
		noteTurnMemberElapsed(context.toolCallId, getStateElapsedMs(context.state));
	}
	const expanded = effectiveTurnExpansion(context.toolCallId, options.expanded);
	const detailExpanded = expanded && !getTurnEntry(context.toolCallId)?.turn.forcedOpen;
	options = { ...options, expanded: detailExpanded };
	context = { ...context, expanded: detailExpanded };
	const turn = options.isPartial ? undefined : collapsedTurnFor(context.toolCallId, expanded, toolName);
	if (turn) {
		if (summaryLeaderId(turn) === context.toolCallId && !hasMergedThoughtLabel(turn)) return emptyTurnResult();
		return EMPTY_BATCH_COMPONENT;
	}
	const tool = typeof toolName === "string" ? REGISTRY[toolName] : undefined;
	if (tool) return tool.result(result, options, theme, context);
	return renderFallbackResult(toolName, result, options, theme, context);
}
