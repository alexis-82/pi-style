// Boxed read tool renderer
// (renderCall/renderResult only; no tool re-registration).
//
// Read calls render boxless: a lone read is a single inline line
// (`➔ Read <path>`), consecutive reads group into one tree panel (see
// batch.ts), and sequential same-file continuation chunks (large-file reads
// split by pi's 2000-line/50KB truncation) merge into ONE expanding inline
// line per file (`tools.mergeChunkedReads`, ADR 0010) — see batch.ts.

import { stripAnsi } from "../../../shared/ansi.js";
import { getTextOutput } from "../../../shared/box.js";
import {
	type BatchToolMeta,
	EMPTY_BATCH_COMPONENT,
	emptyBatchResult,
	type ReadChunkInfo,
	registerBatchCall,
	registerBatchResult,
	renderBatchAwareCall,
	renderStandaloneMemberCall,
} from "./batch.js";
import { renderFallbackResult } from "./fallback.js";
import {
	type BoxedToolContext,
	type BoxedToolDefinition,
	type BoxedToolResult,
	displayPath,
	noteExecutionStart,
	parseReadLineNumber,
	pathRangeDetail,
	truncationOutputLines,
} from "./shared.js";

const READ_META: BatchToolMeta = Object.freeze({
	toolName: "read",
	label: "Read",
});

function toLineNumber(value: unknown): number | undefined {
	const number = parseReadLineNumber(value);
	return number !== undefined && number >= 1 ? Math.floor(number) : undefined;
}

/** Chunk coordinates of one read call — the ADR 0010 merge key (`path` is the
 *  normalized display path; `end` only when a limit was requested). */
function readChunkInfo(
	rawPath: string,
	offset: unknown,
	limit: unknown,
	context: BoxedToolContext,
): ReadChunkInfo | undefined {
	if (!rawPath) return undefined;
	const start = toLineNumber(offset) ?? 1;
	const lineLimit = toLineNumber(limit);
	return {
		path: displayPath(rawPath, context),
		start,
		...(lineLimit !== undefined ? { end: start + lineLimit - 1 } : {}),
	};
}

/** A native continuation notice (`[Showing lines X-Y of Z. Use offset=N to
 *  continue.]` / `[N more lines in file. …]`) terminates the text — appended by
 *  the read tool, not part of the file content. */
const READ_CONTINUATION_NOTICE = /\n\n\[[^\]\n]*continue\.\]\s*$/;

/** Actual output line count of a settled read result: the truncation details'
 *  count when the native tool truncated (byte/line caps), else the counted
 *  text lines of a complete read — offset-only reads have no requested end, so
 *  this is what pins their chunk extent. */
function countReadOutputLines(result: BoxedToolResult): number | undefined {
	const details = result.details as { truncation?: unknown } | undefined;
	if (details?.truncation !== undefined) return truncationOutputLines(result);
	const text = getTextOutput(result);
	if (!text || READ_CONTINUATION_NOTICE.test(text)) return undefined;
	return text.split("\n").length;
}

export const readTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const rawPath = String(args?.path ?? args?.file_path ?? "");
		const detail = pathRangeDetail(rawPath, args?.offset, args?.limit, context);
		const chunk = readChunkInfo(rawPath, args?.offset, args?.limit, context);
		const { isLeader, batch } = registerBatchCall(READ_META, detail, context, chunk ? { chunk } : {});
		// Ctrl+O expansion bypasses the batch panel: every member renders its own
		// row (the registry still records the member, so collapsing restores it).
		if (context.expanded) return renderStandaloneMemberCall(theme, READ_META.label, detail);
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return renderBatchAwareCall(theme, batch);
	},
	result(result, options, theme, context) {
		// The strip is only needed for error text — keep it off the success path
		// (result renderers re-fire on every repaint/scroll).
		const errorText = context.isError ? stripAnsi(getTextOutput(result)).trimEnd() || undefined : undefined;
		const readOutputLines = !options.isPartial && !context.isError ? countReadOutputLines(result) : undefined;
		registerBatchResult(
			READ_META,
			{
				isPartial: Boolean(options.isPartial),
				isError: Boolean(context.isError),
				errorText,
				...(readOutputLines !== undefined ? { readOutputLines } : {}),
			},
			context,
		);
		// Ctrl+O expansion renders the full read output per member instead of the
		// zero-height batch placeholder (same budget/footer as other tools).
		if (options.expanded && !options.isPartial)
			return renderFallbackResult(READ_META.label, result, options, theme, context);
		return emptyBatchResult();
	},
};
