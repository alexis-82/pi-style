import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StatusSnapshot } from "../domain/status.js";
import { resolvePendingImageMarkers, transformClipboardImages } from "../features/messages/image-input.js";
import {
	flushImagePreviewEntry,
	type ImagePreviewEntryData,
	registerImagePreviewSurface,
	stageImagePreviewData,
} from "../features/messages/image-preview.js";
import { registerTeammateMessageRenderers } from "../features/messages/teammates.js";
import {
	attributeMessageToLatestGroup,
	beginAgentThoughtRun,
	finishAgentThoughtRun,
	rebuildAgentThoughtRunsFromEntries,
	refreshObservedThoughtComponents,
	refreshThoughtComponentsForMessage,
} from "../features/messages/thought-summary.js";
import { closeActiveBatch, resetReadChunkCandidates } from "../features/tools/boxed/batch.js";
import { rebuildTeammateRuns, resetTeammateRuns } from "../features/tools/boxed/team-run-labels.js";
import {
	beginAgentRun,
	finishAgentRun,
	invalidateRegisteredTurnMembers,
	invalidateTurnMembers,
	rebuildTurnRegistryFromEntries,
	registerTurnFromMessage,
} from "../features/tools/boxed/turn-summary.js";
import { requestToolPresentationRender } from "../features/tools/index.js";
import { registerPiStyleCommand } from "./commands.js";
import { parseEditorColor, savedEditorColor } from "./editor-color.js";
import { type CompatibilityTestHooks, createPiStyleSessionCoordinator } from "./session-coordinator.js";
import { resetUsageFromSessionCache, usageFromSession } from "./session-usage.js";
import { registerTeammateToolRenderers } from "./teammate-tool-renderers.js";

/** Usage patch clears stale usage when the active branch/session has none. */
function usagePatch(ctx: ExtensionContext): StatusSnapshot {
	return { usage: usageFromSession(ctx.sessionManager) } as StatusSnapshot;
}

/**
 * Add Pi's read-only tools (grep/find/ls) to the active tool set if they are
 * registered. Preserves any other active tools (e.g. extension tools).
 * Only calls setActiveTools when something actually changed.
 */
function activateReadOnlyTools(pi: ExtensionAPI): void {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	const active = new Set(pi.getActiveTools());
	let changed = false;
	for (const name of ["grep", "find", "ls"] as const) {
		if (available.has(name) && !active.has(name)) {
			active.add(name);
			changed = true;
		}
	}
	if (changed) pi.setActiveTools([...active]);
}

/**
 * Structural view of `before_agent_start` across supported runtimes: pre-1.2
 * hosts emit the flat user shape with no `messageType` (the prompt's `images`
 * ride along); 1.2+ splits the event into `messageType: "user"` (same shape,
 * plus the discriminator) and `messageType: "custom"` — a run started by
 * `sendMessage(..., { triggerTurn: true })`, which carries no prompt images.
 */
interface BeforeAgentStartEventShape {
	readonly messageType?: unknown;
	readonly images?: readonly unknown[];
}

let compatibilityTestHooks: CompatibilityTestHooks = {};
export function __setCompatibilityTestHooks(hooks: CompatibilityTestHooks): () => void {
	const previous = compatibilityTestHooks;
	compatibilityTestHooks = hooks;
	return () => {
		compatibilityTestHooks = previous;
	};
}

/** Thin Pi adapter: register flags, commands, and forward lifecycle events. */
export default function piStyleExtension(pi: ExtensionAPI): void {
	// The core/message/tool surfaces are default-on (identity-certified per surface by
	// name/arity/source fingerprint, graceful native fallback for any surface whose
	// runtime identity is not recorded, conflict-preserving). The OFF switch is the
	// product gate `compatibility.allowCorePatches: false` (or `enabled: false`) in config.
	for (const [name, description] of [
		["pi-style-core-patches", "Enable pi-style message/tool core patches"],
		["pi-style-message-assistant", "Enable pi-style assistant message prefix"],
		["pi-style-message-special-blocks", "Enable pi-style boxed compaction/skill/branch/custom message blocks"],
		["pi-style-tools", "Enable pi-style tool renderer decoration"],
		["pi-style-readonly-tools", "Enable grep/find/ls read-only tools in the active tool set"],
	] as const)
		pi.registerFlag(name, { type: "boolean", description, default: true });
	// ASCII markers stay opt-in; unicode markers are the default.
	pi.registerFlag("pi-style-ascii", { type: "boolean", description: "Use ASCII pi-style markers" });
	pi.registerFlag("color", { type: "string", description: "Initial editor border color (#RGB or #RRGGBB)" });
	const coordinator = createPiStyleSessionCoordinator(pi, compatibilityTestHooks);
	registerPiStyleCommand(pi, coordinator.app);
	// User-prompt image previews (ADR 0008): the entry renderer must be
	// registered before the first entry of this type can exist — the host drops
	// entries whose customType has no renderer — and once at extension load is
	// enough (persisted entries from previous sessions render on resume).
	registerImagePreviewSurface(pi);
	registerTeammateMessageRenderers(pi);
	registerTeammateToolRenderers(pi);
	// User-prompt image previews (ADR 0008): the prompt's `images` are only
	// available at `before_agent_start`, but appending there would place the entry
	// above the user message because extension handlers run before the UI handles
	// `message_start(user)`. Capture there, then flush on the next event-loop turn
	// after `message_start(user)` so the preview appears immediately below it.
	// The assistant-start handler is a synchronous fallback for runtimes that begin
	// the assistant before the deferred flush runs. A steered prompt arriving before
	// flush replaces the staged slot (last write wins).
	let stagedImagePreview: ImagePreviewEntryData | undefined;
	let previewFlushTimer: ReturnType<typeof setTimeout> | undefined;
	pi.on("before_agent_start", (event: BeforeAgentStartEventShape) => {
		// 1.2+ custom runs (`sendMessage` triggerTurn) carry no prompt images and
		// may fire while a user prompt's preview is waiting to flush — leave the
		// pending slot untouched so the custom run cannot erase it. User runs and
		// the pre-1.2 flat shape (no `messageType`) stage as before.
		if (event.messageType === "custom") return;
		// Always replace the slot: a subsequent image-less prompt must not
		// accidentally flush the previous prompt's preview.
		stagedImagePreview = stageImagePreviewData(event.images ?? []);
	});
	pi.on("session_start", async (event, ctx) => {
		resetUsageFromSessionCache(ctx.sessionManager);
		// Pi only activates read/bash/edit/write by default; grep/find/ls are
		// registered but inactive (kept out of the model's tool list to keep the
		// core small). Activate them so the TUI shows them and the model can call
		// them directly, mirroring Claude Code's glob/grep/read tool set.
		if (pi.getFlag("pi-style-readonly-tools") === true && process.env.PI_TEAMS_CHILD !== "1") {
			activateReadOnlyTools(pi);
		}
		await coordinator.start(event, ctx);
		const rawColor = pi.getFlag("color");
		const cliColor = typeof rawColor === "string" ? parseEditorColor(rawColor) : undefined;
		if (rawColor !== undefined && !cliColor) ctx.ui?.notify?.("Invalid --color; use #RGB or #RRGGBB", "warning");
		const saved = savedEditorColor(
			typeof ctx.sessionManager.getBranch === "function"
				? ctx.sessionManager.getBranch()
				: ctx.sessionManager.getEntries(),
		);
		coordinator.app.update(
			{ sessionName: pi.getSessionName(), editorBorderColor: saved === undefined ? cliColor : (saved ?? undefined) },
			"immediate",
		);
	});
	pi.on("agent_start", () => {
		coordinator.app.runtime.current?.dismissStartup();
		// Thought segments are collected until agent_end (visible assistant text
		// splits them); tool summaries still use the whole agent-run boundary.
		beginAgentThoughtRun();
		beginAgentRun();
		// A new request never continues the previous run's read-chunk sequences
		// (ADR 0010): a fresh full-file read must start its own merged line.
		resetReadChunkCandidates();
	});
	pi.on("input", async (event, _ctx) => {
		coordinator.app.runtime.current?.dismissStartup();
		// Bare `!`/`!!` submit guard: Pi treats `!`-prefixed input as a direct bash
		// command but falls through to normal message submission when the bang has
		// no command after it — sending a literal `!` to the agent. Drop those
		// accidental submits instead; Pi's submit path already cleared the editor
		// (onChange("") resets isBashMode), so the input returns to the normal
		// prompt without sending anything. Only the interactive input box is
		// guarded; rpc/extension sources keep sending text verbatim.
		if (event.source === "interactive") {
			const trimmed = event.text.trimStart();
			if (trimmed.startsWith("!")) {
				const bangLength = trimmed.startsWith("!!") ? 2 : 1;
				if (trimmed.slice(bangLength).trim() === "") return { action: "handled" };
			}
		}
		// Clipboard image input (ADR 0009): `[Image #N]` markers resolve for EVERY
		// submit source — a submit is a submit (image-paste semantics); consuming
		// the registry one-shot on rpc/extension submits too keeps a pasted marker
		// from dangling into a later, unrelated prompt. No-op when the registry is
		// empty. Raw clipboard path tokens, in contrast, only ever come from the
		// interactive editor's built-in paste — that upgrade stays interactive-only.
		// Combined images flow on to before_agent_start, where the ADR 0008 preview
		// entry picks them up.
		const markerResult = await resolvePendingImageMarkers(event.text);
		const pathResult = event.source === "interactive" ? await transformClipboardImages(event.text) : undefined;
		if (markerResult || pathResult) {
			return {
				action: "transform" as const,
				text: pathResult?.text ?? event.text,
				images: [...(markerResult?.images ?? []), ...(pathResult?.images ?? [])],
			};
		}
		return undefined;
	});
	pi.on("tool_execution_start", () => coordinator.app.runtime.current?.dismissStartup());
	pi.on("model_select", (event) =>
		coordinator.app.update(
			{
				model: event.model.name || event.model.id,
				...(event.model.provider ? { provider: event.model.provider } : {}),
				...(event.model.reasoning !== undefined ? { reasoning: event.model.reasoning } : {}),
			},
			"immediate",
		),
	);
	pi.on("thinking_level_select", (event) => coordinator.app.update({ thinkingLevel: event.level }, "immediate"));
	pi.on("session_info_changed", (event) =>
		coordinator.app.update({ sessionName: event.name }, "coalesced", { refreshExtensionStatuses: true }),
	);
	pi.on("message_start", (event) => {
		// A new message is a batch boundary: quiet-tool (read/ls/find) calls of the
		// new message start a fresh batch instead of joining the previous one.
		closeActiveBatch();
		if (event.message?.role === "user" && stagedImagePreview && !previewFlushTimer) {
			// Extension handlers run before Pi's interactive listener adds the user
			// message to the chat. Defer one turn so the entry is appended below the
			// visible user message, but do not wait for assistant content to arrive.
			const pending = stagedImagePreview;
			previewFlushTimer = setTimeout(() => {
				previewFlushTimer = undefined;
				if (stagedImagePreview !== pending) return;
				flushImagePreviewEntry(pi, pending);
				stagedImagePreview = undefined;
			}, 0);
		}
		// Fallback for runtimes that start the assistant before the deferred turn
		// runs. This preserves the ordering below the user and never duplicates.
		if (stagedImagePreview && event.message?.role === "assistant") {
			if (previewFlushTimer) {
				clearTimeout(previewFlushTimer);
				previewFlushTimer = undefined;
			}
			flushImagePreviewEntry(pi, stagedImagePreview);
			stagedImagePreview = undefined;
		}
		// grep/bash tree panels are NOT cleared here: historical panels must keep
		// their state so Pi re-renders of previous messages (scroll/resume) stay
		// intact. Only session boundaries reset them (session-coordinator).
	});
	pi.on("message_update", () => coordinator.app.update({}, "coalesced"));
	// Usage (tokens + cost) is aggregated from finalized session entries at
	// message/turn boundaries, mirroring Pi's native footer; per-chunk updates
	// stay usage-free to keep streaming cheap.
	pi.on("message_end", (_event, ctx) =>
		coordinator.app.update({ ...usagePatch(ctx) }, "coalesced", { refreshContextUsage: true }),
	);
	pi.on("turn_end", (event, ctx) => {
		// Append the finalized assistant message's tool batch to the current run —
		// publishing its stats to the merged-summary bridge immediately — then
		// refresh the observed assistant components so text-split segment labels
		// pick the stats up mid-run (not only at agent_end). A thinking-less
		// message (tool continuation, e.g. subagent result pickup) attributes to
		// the latest thought group so its tools count on the merged line and the
		// run's `➔` leader defers instead of duplicating the summary.
		registerTurnFromMessage(event.message, event.toolResults);
		if (attributeMessageToLatestGroup(event.message)) refreshThoughtComponentsForMessage(event.message);
		coordinator.app.update({ ...usagePatch(ctx) }, "deferred", { refreshContextUsage: true });
	});
	pi.on("agent_end", () => {
		// Order matters: finishAgentRun FIRST — it finalizes the run, publishes
		// per-message stats, and exposes `run.messages` for late attribution
		// (tools-first rounds whose turn ended before any thought group existed).
		// finishAgentThoughtRun THEN pools the run stats onto the first segment
		// leader (one merged row per agent run) and refreshes the labels. Only
		// THEN rebuild the tool blocks: the collapse gate must see the ended
		// thought groups or it leaves a stale ➔ row until the next toggle.
		const run = finishAgentRun();
		if (run) {
			for (const message of run.messages ?? []) attributeMessageToLatestGroup(message);
		}
		finishAgentThoughtRun();
		if (run) {
			// Pi only re-invokes the tool renderer selectors from updateDisplay(), so
			// the captured per-block invalidate callbacks force the collapse and the
			// captured Tui repaints. Interrupted runs (a call without a result) stay
			// expanded. The invalidators are NOT released: the summary-row click
			// toggle re-dispatches every member of an ended turn later.
			invalidateTurnMembers(run);
			requestToolPresentationRender();
		}
	});
	pi.on("agent_settled", (_event, ctx) =>
		coordinator.app.update({ ...usagePatch(ctx) }, "coalesced", { refreshContextUsage: true }),
	);
	pi.on("session_tree", (_event, ctx) => {
		resetUsageFromSessionCache(ctx.sessionManager);
		// Rebuild both agent-run presentation registries from the selected branch.
		// Turn registry first: it publishes the tool stats the thought labels read.
		const entries =
			typeof ctx.sessionManager.getBranch === "function"
				? ctx.sessionManager.getBranch()
				: ctx.sessionManager.getEntries();
		rebuildTurnRegistryFromEntries(entries);
		rebuildAgentThoughtRunsFromEntries(entries);
		rebuildTeammateRuns(entries);
		refreshObservedThoughtComponents();
		invalidateRegisteredTurnMembers();
		requestToolPresentationRender();
		const saved = savedEditorColor(
			typeof ctx.sessionManager.getBranch === "function"
				? ctx.sessionManager.getBranch()
				: ctx.sessionManager.getEntries(),
		);
		const cli = pi.getFlag("color");
		const color =
			saved === undefined ? (typeof cli === "string" ? parseEditorColor(cli) : undefined) : (saved ?? undefined);
		coordinator.app.update({ ...usagePatch(ctx), editorBorderColor: color }, "deferred", { refreshContextUsage: true });
	});
	pi.on("session_compact", (_event, ctx) => {
		resetUsageFromSessionCache(ctx.sessionManager);
		coordinator.app.update({ ...usagePatch(ctx) }, "deferred", { refreshContextUsage: true });
	});
	pi.on("tool_result", (event, ctx) => {
		if (["write", "edit", "bash"].includes(event.toolName)) {
			coordinator.app.runtime.current?.invalidateGit();
			coordinator.app.update({ ...usagePatch(ctx) }, "delayed-retry", { refreshContextUsage: true });
		}
	});
	pi.on("user_bash", (_event, ctx) => {
		coordinator.app.runtime.current?.invalidateGit();
		coordinator.app.update({ ...usagePatch(ctx) }, "delayed-retry", { refreshContextUsage: true });
	});
	pi.on("session_shutdown", (_event, ctx) => {
		resetUsageFromSessionCache(ctx.sessionManager);
		resetTeammateRuns();
		coordinator.shutdown();
	});
}
