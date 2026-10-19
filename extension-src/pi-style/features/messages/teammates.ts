// pi-teams custom-message presentation. The message's content remains intact for
// the model and for hosts without pi-style; only this native TUI view changes.
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { fgHex, isHexColor, stripAnsi, visibleWidth } from "../../shared/ansi.js";
import type { BoxTheme } from "../../shared/box.js";
import { safeTruncateToWidth } from "../../shared/render-budget.js";
import { teamEventGlyph } from "../tools/boxed/session-config.js";
import { formatDuration, formatTokens, normalizePreview } from "../tools/boxed/shared.js";
import { settleTeammateRun } from "../tools/boxed/team-run-labels.js";

export const TEAMMATE_MESSAGE_TYPES = new Set(["teammate-notification", "teammate-message"]);

const clean = (value: unknown, max = 280): string =>
	typeof value === "string"
		? stripAnsi(value)
				.replace(/\p{Cc}/gu, " ")
				.trim()
				.slice(0, max)
		: "";
const lines = (value: string, max = 2000): string[] =>
	stripAnsi(value)
		.split("\n")
		.map((line) => clean(line, max));
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Hanging dim detail block (same rule as the team tool cards): the first
 *  non-blank row carries the `└─` branch and the rest align under it. */
function hangingRows(theme: BoxTheme, rows: readonly string[], indent = ""): string[] {
	const first = rows.findIndex((row) => row.trim() !== "");
	return rows.map((row, index) => {
		if (!row.trim()) return "";
		return `${theme.fg("dim", `${indent}${index === first ? "└─" : "  "}`)} ${theme.fg("dim", row)}`;
	});
}

// If the runtime omits a teammate color, highlight the reference with the
// theme's generic accent instead of fabricating an identity-specific color.
const styledTeammate = (
	theme: { fg(color: string, text: string): string; getColorMode?(): string },
	label: string,
	color: unknown,
): string => (typeof color === "string" && isHexColor(color) ? fgHex(theme, color, label) : theme.fg("accent", label));

type Report = {
	name: string;
	identity: string;
	outcome: string;
	preview: string;
	resultFile?: string;
	color?: unknown;
	/** Producer-published run identity + timing (ADR 0012 §4/§5); absent
	 *  fields are omitted silently, never fabricated. */
	agentId?: string;
	durationMs?: number;
	totalTokens?: number;
};
const optionalNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
/** Producer-published run identity + timing; absent fields are omitted. */
const runMeta = (source: Record<string, unknown>) => {
	const agentId = typeof source.agentId === "string" && source.agentId ? source.agentId : undefined;
	const durationMs = optionalNumber(source.durationMs);
	const totalTokens = optionalNumber(source.totalTokens);
	return {
		...(agentId !== undefined ? { agentId } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
	};
};
function notificationReports(content: string, details: Record<string, unknown>): Report[] {
	const ownName = clean(details.teammateName ?? details.agentId, 64) || "teammate";
	const ownIdentity = typeof details.teammateName === "string" && details.teammateName ? `@${ownName}` : ownName;
	const ownOutcome = clean(details.outcome, 24) || "completed";
	const peers = Array.isArray(details.others)
		? details.others.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
		: [];
	if (!peers.length) {
		const body = content
			.split("\n")
			.slice(2)
			.filter((line) => !line.startsWith("full result:"))
			.join("\n")
			.trim();
		return [
			{
				name: ownName,
				identity: ownIdentity,
				outcome: ownOutcome,
				preview: body || "(no output)",
				...(typeof details.resultFile === "string" ? { resultFile: details.resultFile } : {}),
				color: details.color,
				...runMeta(details),
			},
		];
	}
	const entries: Report[] = [
		{
			name: ownName,
			identity: ownIdentity,
			outcome: ownOutcome,
			preview: "",
			...(typeof details.resultFile === "string" ? { resultFile: details.resultFile } : {}),
			color: details.color,
			...runMeta(details),
		},
	];
	for (const peer of peers) {
		const name = clean(peer.teammateName ?? peer.agentId, 64) || "teammate";
		const identity = typeof peer.teammateName === "string" && peer.teammateName ? `@${name}` : name;
		entries.push({
			name,
			identity,
			outcome: clean(peer.outcome, 24) || "unknown",
			preview: "(no output)",
			...(typeof peer.resultFile === "string" ? { resultFile: peer.resultFile } : {}),
			color: peer.color,
			...runMeta(peer),
		});
	}
	// The producer inserts unescaped previews, so section-like preview lines can
	// imitate a later header. Accept attribution only when every boundary is an
	// exact one-to-one match for the metadata order and outcome; otherwise fail
	// closed rather than assigning quoted text to a peer.
	const markers = [...content.matchAll(/(^|\n)(@?[^\s\n]+) \((completed|failed|stopped)\):\n/gm)].map((match) => ({
		start: (match.index ?? 0) + (match[1]?.length ?? 0),
		bodyStart: (match.index ?? 0) + match[0].length,
		identity: match[2] ?? "",
		outcome: match[3] ?? "",
	}));
	const valid =
		content.startsWith(`${entries.length} teammates reported from the same launch batch:\n\n`) &&
		markers.length === entries.length &&
		markers.every(
			(marker, index) => marker.identity === entries[index]?.identity && marker.outcome === entries[index]?.outcome,
		);
	if (!valid) {
		for (const report of entries) report.preview = "(grouped preview unavailable: ambiguous section boundaries)";
		return entries;
	}
	for (let index = 0; index < entries.length; index++) {
		const report = entries[index];
		const marker = markers[index];
		const next = markers[index + 1];
		if (!report || !marker) continue;
		let preview = content.slice(marker.bodyStart, next?.start ?? content.length).replace(/\n+$/, "");
		if (report.resultFile) {
			const trailer = `\nfull result: ${report.resultFile}`;
			if (!preview.endsWith(trailer)) {
				for (const entry of entries) entry.preview = "(grouped preview unavailable: ambiguous section boundaries)";
				return entries;
			}
			preview = preview.slice(0, -trailer.length);
		}
		report.preview = preview.trim() || "(no output)";
	}
	return entries;
}
/** Outcome glyph (ADR 0012 §1/§4): completed → `●` (success tint), failed →
 *  `✗` (error), stopped → `○` (dim). */
function outcomeGlyph(outcome: string, theme: BoxTheme): string {
	if (outcome === "failed") return theme.fg("error", teamEventGlyph("failed"));
	if (outcome === "stopped") return theme.fg("dim", teamEventGlyph("stopped"));
	return theme.fg("success", teamEventGlyph("settled"));
}
/** `<glyph> @name · 2m 03s · ↓146.5k tokens` — duration/tokens render only
 *  from producer details; absent fields are omitted silently (ADR 0012 §4). */
function reportHead(report: Report, theme: BoxTheme): string {
	const identity = styledTeammate(theme, `@${report.name.replace(/^@/, "")}`, report.color);
	const tokens = formatTokens(report.totalTokens);
	const tail = [formatDuration(report.durationMs), tokens !== undefined ? `${tokens} tokens` : undefined]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	return `${outcomeGlyph(report.outcome, theme)} ${identity}${tail ? ` · ${tail}` : ""}`;
}
/** `result: result.md` (collapsed) or `result: <full path>` (expanded). Rows
 *  carry the caller's indent so the card can hang them under its block. */
function resultRows(path: string, width: number, expanded: boolean, indent = ""): string[] {
	const rawPath = stripAnsi(path)
		.replace(/\p{Cc}/gu, " ")
		.trim();
	const safePath = rawPath.length > 2000 ? `${rawPath.slice(0, 1999)}…` : rawPath;
	const prefix = "result: ";
	if (getCapabilities().hyperlinks) {
		const label = expanded ? safePath : "result.md";
		return [safeTruncateToWidth(`${indent}${prefix}${hyperlink(label, pathToFileURL(path).href)}`, width)];
	}
	if (!expanded) return [safeTruncateToWidth(`${indent}${prefix}${clean(safePath, 400)}`, width)];
	// Chunk against the real remaining width so the indent never overflows.
	const budget = Math.max(1, width - visibleWidth(indent) - prefix.length);
	const chunks: string[] = [];
	let chunk = "";
	for (const character of safePath) {
		if (chunk && visibleWidth(chunk + character) > budget) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) chunks.push(chunk);
	if (chunks.length === 0) chunks.push("(empty path)");
	return chunks.map((value, index) => `${indent}${index === 0 ? prefix : " ".repeat(prefix.length)}${value}`);
}
/** One teammate card: head + hanging dim preview + its result path. No aggregate
 *  header — a batch message simply renders one card per teammate (revised). */
function reportCard(report: Report, width: number, expanded: boolean, theme: BoxTheme): string[] {
	const head = reportHead(report, theme);
	const result = report.resultFile ? resultRows(report.resultFile, width, expanded, "   ") : [];
	if (!expanded) {
		const preview = normalizePreview(report.preview) || clean(report.preview, 180);
		return [head, theme.fg("dim", `└─ ${preview}`), ...result.map((row) => theme.fg("dim", row))];
	}
	const previewLines = report.preview ? lines(report.preview) : [];
	const room = Math.max(0, 200 - 1 - result.length);
	const budget = Math.max(0, room - Number(previewLines.length > room));
	const rows = [head, ...hangingRows(theme, previewLines.slice(0, budget))];
	if (previewLines.length > budget) rows.push(theme.fg("dim", `   … ${previewLines.length - budget} lines omitted`));
	rows.push(...result.map((row) => theme.fg("dim", row)));
	return rows;
}
export function registerTeammateMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("teammate-notification", (message, options, theme): Component => {
		const data = record(message.details);
		const content = typeof message.content === "string" ? message.content : "";
		if (!["completed", "failed", "stopped"].includes(String(data.outcome))) return new Text(content, 0, 0);
		const reports = notificationReports(content, data);
		// ADR 0012 §5: the notification renderer settles the remembered Agent run
		// in the same process, flipping the live spawn row to its terminal glyph.
		for (const report of reports)
			if (report.agentId)
				settleTeammateRun(report.agentId, {
					outcome: report.outcome === "failed" || report.outcome === "stopped" ? report.outcome : "completed",
					...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
					...(report.totalTokens !== undefined ? { totalTokens: report.totalTokens } : {}),
				});
		return {
			invalidate() {},
			render(width) {
				if (width < 8) return [];
				// One card per teammate; a batch message renders N cards with one blank
				// row between them, so there is no aggregate "N teammates finished" row.
				const cards = reports.map((report) => reportCard(report, width, options.expanded, theme));
				const output = cards.flatMap((card, index) => (index === 0 ? card : ["", ...card]));
				if (output.length > 200) {
					const omitted = output.length - 199;
					output.splice(199);
					output.push(theme.fg("dim", width < 24 ? "… omitted" : `… ${omitted} rows omitted`));
				}
				return output.slice(0, 200).map((line) => safeTruncateToWidth(line, width));
			},
		};
	});
	pi.registerMessageRenderer("teammate-message", (message, options, theme): Component => {
		const data = record(message.details);
		const from = clean(data.from, 64) || "teammate";
		const body = typeof message.content === "string" ? message.content.replace(/^Message from @[^\n]+:\s*/, "") : "";
		const hasBody = body.trim() !== "";
		const contentLines = lines(body);
		return {
			invalidate() {},
			render(width) {
				if (width < 8) return [];
				// Minimal disclosure (ADR 0012 §9): the collapsed line answers only
				// "who → whom" — no preview, no envelope glyph. `@name` keeps its
				// color from `details.color`.
				const headLine = `${theme.fg("muted", teamEventGlyph("settled"))} Message from ${styledTeammate(theme, `@${from}`, data.color)}`;
				if (!options.expanded)
					return [safeTruncateToWidth(`${headLine}${hasBody ? theme.fg("dim", " (Ctrl+O to expand)") : ""}`, width)];
				// Expanded: the identical head minus the hint, then the body as a
				// hanging dim block (no rail glyph), verbatim after the clean/lines
				// guards.
				return [headLine, ...hangingRows(theme, contentLines)].map((line) => safeTruncateToWidth(line, width));
			},
		};
	});
}
