import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderBoxedToolCall, renderBoxedToolResult } from "../features/tools/boxed/index.js";
import type { BoxedToolContext, BoxedToolResult } from "../features/tools/boxed/shared.js";
import { TEAM_TOOL_NAMES } from "../features/tools/boxed/teams.js";
import type { BoxTheme } from "../shared/box.js";

/** Pi 0.85 (the package's local development peer) does not expose this API;
 * Pi 1.0.4 (pi-teams' minimum) does. Keep it an optional structural port. */
type TeamRenderers = {
	renderShell: "self";
	renderCall: (args: Record<string, unknown>, theme: BoxTheme, context: BoxedToolContext) => Component;
	renderResult: (
		result: BoxedToolResult,
		options: { expanded: boolean; isPartial: boolean },
		theme: BoxTheme,
		context: BoxedToolContext,
	) => Component;
};
type PublicToolRendererHost = {
	registerToolRenderer?: (
		resolver: (name: string, next: () => TeamRenderers | undefined) => TeamRenderers | undefined,
	) => void;
};

/** Zero-line placeholder for a malformed public-renderer callback context:
 * render nothing rather than rendering garbage (the ADR 0008 fail-closed
 * vocabulary). Pi types these callbacks as `Static<TParams>`/`unknown` while
 * hosts pass plain records; the guards below make that contract explicit.
 */
const EMPTY_RENDER: Component = { render: () => [], invalidate() {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Runtime narrowing of the host-provided renderer context into the boxed
 * shape (same validate-then-forward contract as the fingerprint path's
 * validCallArgs gate); undefined when the host shape is unrecognizable. */
function boxedContext(context: unknown): BoxedToolContext | undefined {
	if (!isRecord(context)) return undefined;
	const { args, toolCallId, invalidate, state, cwd } = context;
	const { executionStarted, argsComplete, isPartial, expanded, showImages, isError } = context;
	if (!isRecord(args) || !isRecord(state)) return undefined;
	if (typeof toolCallId !== "string" || typeof cwd !== "string" || typeof invalidate !== "function") return undefined;
	if (
		typeof executionStarted !== "boolean" ||
		typeof argsComplete !== "boolean" ||
		typeof isPartial !== "boolean" ||
		typeof expanded !== "boolean" ||
		typeof showImages !== "boolean" ||
		typeof isError !== "boolean"
	)
		return undefined;
	return {
		args,
		toolCallId,
		// The typeof guard yields bare `Function`; wrap it instead of asserting
		// the () => void signature.
		invalidate: () => {
			invalidate();
		},
		state,
		cwd,
		executionStarted,
		argsComplete,
		isPartial,
		expanded,
		showImages,
		isError,
	};
}

/** Public renderer selection works even when a new Pi release fails the
 * fingerprint-gated compatibility patch. The native self shell suppresses
 * zero-line batch members. Never register or replace pi-teams' execution. */
export function registerTeammateToolRenderers(pi: ExtensionAPI): void {
	(pi as ExtensionAPI & PublicToolRendererHost).registerToolRenderer?.((name, next) => {
		if (!TEAM_TOOL_NAMES.has(name)) return next();
		return {
			renderShell: "self",
			// Pi 1.2 types the callback inputs as `Static<TParams>` (concretely
			// `unknown`) and `ToolRenderContext<TState, Static<TParams>>`; hosts
			// pass plain records. Narrow at the boundary instead of casting.
			renderCall: (args, theme, context) => {
				const boxed = boxedContext(context);
				return boxed && isRecord(args) ? renderBoxedToolCall(name, args, theme, boxed) : EMPTY_RENDER;
			},
			renderResult: (result, options, theme, context) => {
				const boxed = boxedContext(context);
				return boxed ? renderBoxedToolResult(name, result, options, theme, boxed) : EMPTY_RENDER;
			},
		};
	});
}
