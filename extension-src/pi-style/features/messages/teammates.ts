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
/** Collapsed link rows hang from a `└` (ADR 0012 §4); the hyperlink capability
 *  logic inside resultLinkRows is reused untouched. */
function treeLinkRows(rows: string[]): string[] {
	return rows.map((row, index) => (index === 0 && row.startsWith("  ") ? `  └ ${row.slice(2)}` : row));
}
/** Grouped head (ADR 0012 §4): `<glyph> N teammates finished · 2 ✓ · 1 ✗` —
 *  count segments render only when nonzero; zero counts are omitted. */
function groupHead(reports: readonly Report[], theme: BoxTheme): string {
	const count = (outcome: string): number => reports.filter((report) => report.outcome === outcome).length;
	const completed = count("completed");
	const failed = count("failed");
	const stopped = count("stopped");
	const glyph =
		failed > 0
			? theme.fg("error", teamEventGlyph("failed"))
			: completed > 0
				? theme.fg("success", teamEventGlyph("settled"))
				: theme.fg("dim", teamEventGlyph("stopped"));
	const segments = [
		completed > 0 ? `${completed} ✓` : "",
		failed > 0 ? `${failed} ✗` : "",
		stopped > 0 ? `${stopped} ○` : "",
	].filter(Boolean);
	return `${glyph} ${reports.length} teammates finished${segments.length > 0 ? ` · ${segments.join(" · ")}` : ""}`;
}
function resultLinkRows(path: string, width: number, expanded: boolean): string[] {
	const rawPath = stripAnsi(path)
		.replace(/\p{Cc}/gu, " ")
		.trim();
	const safePath = rawPath.length > 2000 ? `${rawPath.slice(0, 1999)}…` : rawPath;
	if (getCapabilities().hyperlinks) {
		const label = expanded ? safePath : "result.md";
		return [safeTruncateToWidth(`  ↗ ${hyperlink(label, pathToFileURL(path).href)}`, width)];
	}
	if (!expanded)
		return [
			safeTruncateToWidth(
				width < 16 ? `  ↗ ${clean(safePath, 120)}` : `  ↗ result.md · ${clean(safePath, 220)}`,
				width,
			),
		];
	const firstWidth = Math.max(1, width - 4);
	const chunks: string[] = [];
	let chunk = "";
	for (const character of safePath) {
		if (chunk && visibleWidth(chunk + character) > firstWidth) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) chunks.push(chunk);
	if (chunks.length === 0) chunks.push("(empty path)");
	return chunks.map((chunk, index) => `${index === 0 ? "  ↗ " : "    "}${chunk}`);
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
				const output: string[] = [];
				if (reports.length === 1) {
					const report = reports[0];
					if (!report) return [];
					output.push(reportHead(report, theme));
					if (report.preview)
						output.push(theme.fg("dim", `  └ ${normalizePreview(report.preview) || clean(report.preview, 180)}`));
					if (report.resultFile)
						output.push(
							...treeLinkRows(resultLinkRows(report.resultFile, width, options.expanded)).map((line) =>
								theme.fg("dim", line),
							),
						);
					if (options.expanded) {
						output.length = 0;
						output.push(reportHead(report, theme));
						const linkRows = report.resultFile ? resultLinkRows(report.resultFile, width, true) : [];
						const previewLines = report.preview ? lines(report.preview) : [];
						const fixedRows = 1 + linkRows.length + 1;
						const previewBudget = Math.max(0, 200 - fixedRows - Number(previewLines.length > 200 - fixedRows));
						output.push(...previewLines.slice(0, previewBudget).map((line) => `  ${line}`));
						if (previewLines.length > previewBudget)
							output.push(`  … ${previewLines.length - previewBudget} preview lines omitted`);
						output.push(...linkRows);
						output.push(`  outcome: ${report.outcome}`);
					}
				} else if (options.expanded) {
					output.push(groupHead(reports, theme));
					const reportLines = reports.map((report) => ({
						report,
						previewLines: lines(report.preview),
						linkRows: report.resultFile ? resultLinkRows(report.resultFile, width, true) : [],
					}));
					// Critical rows do not compete with artifact paths or successful
					// previews: retain every member header and one explanatory line per
					// failed member before allocating any ordinary rows.
					for (const item of reportLines) output.push(reportHead(item.report, theme));
					for (const item of reportLines) {
						if (item.report.outcome !== "failed") continue;
						const name = `@${item.report.name.replace(/^@/, "")}`;
						const diagnostic = item.previewLines[0] ?? "(no output)";
						output.push(`  ${name}:`);
						output.push(`    ${diagnostic}`);
						if (item.previewLines.length > 1)
							output.push(`  … ${item.previewLines.length - 1} failed preview lines omitted for ${name}`);
					}
					const ordinaryPreviewLines = reportLines
						.filter((item) => item.report.outcome !== "failed")
						.reduce((total, item) => total + item.previewLines.length, 0);
					const artifactRows = reportLines.reduce((total, item) => total + item.linkRows.length, 0);
					let budget = Math.max(0, 200 - output.length);
					const needsOmissionNotice = artifactRows + ordinaryPreviewLines > budget;
					if (needsOmissionNotice && budget > 0) budget--;
					let omittedArtifactRows = 0;
					let omittedPreviewRows = 0;
					for (const item of reportLines) {
						if (item.linkRows.length === 0) continue;
						const take = Math.min(budget, item.linkRows.length);
						output.push(...item.linkRows.slice(0, take));
						budget -= take;
						omittedArtifactRows += item.linkRows.length - take;
					}
					for (const item of reportLines) {
						if (item.report.outcome === "failed") continue;
						const name = `@${item.report.name.replace(/^@/, "")}`;
						const take = Math.min(budget, item.previewLines.length);
						output.push(
							...item.previewLines
								.slice(0, take)
								.map((line, index) => `  ${index === 0 ? `${name}: ` : "    "}${line}`),
						);
						budget -= take;
						omittedPreviewRows += item.previewLines.length - take;
					}
					if (needsOmissionNotice && output.length < 200)
						output.push(
							width < 24
								? "… omitted"
								: `  … omitted ${omittedArtifactRows} artifact path rows and ${omittedPreviewRows} noncritical preview lines to keep failure receipts visible`,
						);
				} else {
					output.push(groupHead(reports, theme));
					// Every failure keeps its own `└` reason row (loud); successes may
					// compress to one name list (ADR 0012 §4).
					for (const report of reports) {
						if (report.outcome !== "failed") continue;
						output.push(
							theme.fg(
								"error",
								`  └ ${teamEventGlyph("failed")} @${report.name.replace(/^@/, "")} · ${clean(report.preview, 120)}`,
							),
						);
					}
					const successes = reports.filter((report) => report.outcome !== "failed");
					if (successes.length > 0) {
						const names = successes.map((report) => `@${report.name.replace(/^@/, "")}`);
						const visibleNames = names.slice(0, 3);
						const more = names.length - visibleNames.length;
						output.push(
							theme.fg(
								"dim",
								`  ├─ ${teamEventGlyph("settled")} ${visibleNames.join(", ")}${more > 0 ? ` … +${more} more` : ""}`,
							),
						);
					}
					if (reports[0]?.resultFile)
						output.push(
							...treeLinkRows(resultLinkRows(reports[0].resultFile, width, false)).map((line) => theme.fg("dim", line)),
						);
				}
				if (options.expanded && output.length > 200) {
					const omitted = output.length - 199;
					output.splice(199);
					output.push(`… ${omitted} additional notification rows omitted`);
				}
				return output.slice(0, options.expanded ? 200 : 4).map((line) => safeTruncateToWidth(line, width));
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
				// Expanded: the identical head minus the hint, then the full body as
				// `│ `-railed quote rows (2-space indent + rail on every physical
				// line including blanks), verbatim after the clean/lines guards.
				const rails = contentLines.map((line) => (line.trim() ? `  │ ${line}` : "  │"));
				return [headLine, ...rails].map((line) => safeTruncateToWidth(line, width));
			},
		};
	});
}
