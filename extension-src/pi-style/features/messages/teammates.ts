// pi-teams custom-message presentation. The message's content remains intact for
// the model and for hosts without pi-style; only this native TUI view changes.
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { fgHex, isHexColor, stripAnsi, visibleWidth } from "../../shared/ansi.js";
import type { BoxTheme } from "../../shared/box.js";
import { safeTruncateToWidth } from "../../shared/render-budget.js";
import { getToolsRenderConfig } from "../tools/boxed/session-config.js";

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
function statusLabel(outcome: string): string {
	return outcome === "completed" ? "finished" : outcome;
}
function reportHead(report: Report, theme: BoxTheme, width = Number.POSITIVE_INFINITY): string {
	const color = report.outcome === "completed" ? "success" : report.outcome === "failed" ? "error" : "dim";
	const identity = styledTeammate(theme, `@${report.name.replace(/^@/, "")}`, report.color);
	return width < 24
		? `${theme.fg(color, "●")} ${statusLabel(report.outcome)} ${identity}`
		: `${theme.fg(color, "●")} ${identity} ${statusLabel(report.outcome)}`;
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
		return {
			invalidate() {},
			render(width) {
				if (width < 8) return [];
				const output: string[] = [];
				if (reports.length === 1) {
					const report = reports[0];
					if (!report) return [];
					output.push(reportHead(report, theme, width));
					if (report.preview)
						output.push(theme.fg("dim", `  └─ ${clean(report.preview, options.expanded ? 2000 : 180)}`));
					if (report.resultFile)
						output.push(
							...resultLinkRows(report.resultFile, width, options.expanded).map((line) => theme.fg("dim", line)),
						);
					if (options.expanded) {
						output.length = 0;
						output.push(reportHead(report, theme, width));
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
					output.push(`${reports.length} teammate reports`);
					const reportLines = reports.map((report) => ({
						report,
						previewLines: lines(report.preview),
						linkRows: report.resultFile ? resultLinkRows(report.resultFile, width, true) : [],
					}));
					// Critical rows do not compete with artifact paths or successful
					// previews: retain every member header and one explanatory line per
					// failed member before allocating any ordinary rows.
					for (const item of reportLines) output.push(reportHead(item.report, theme, width));
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
					const failed = reports.filter((report) => report.outcome === "failed");
					output.push(
						`${reports.length} teammate reports · ${failed.length} failed${failed.length ? `: ${failed.map((report) => `@${report.name.replace(/^@/, "")}`).join(", ")}` : ""}`,
					);
					const visible =
						reports.length <= 2
							? reports
							: [...failed.slice(0, 1), reports.find((r) => r.outcome !== "failed")]
									.filter((r): r is Report => !!r)
									.slice(0, 2);
					for (const report of visible)
						output.push(
							`${reportHead(report, theme, width)}${report.preview ? ` · ${clean(report.preview, 80)}` : ""}`,
						);
					if (reports[0]?.resultFile)
						output.push(...resultLinkRows(reports[0].resultFile, width, false).map((line) => theme.fg("dim", line)));
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
		const contentLines = lines(body);
		return {
			invalidate() {},
			render(width) {
				if (width < 8) return [];
				const label = getToolsRenderConfig().nerdFonts ? "\uf086" : "✉";
				const sender = `${styledTeammate(theme, `@${from}`, data.color)} → lead`;
				const visible = options.expanded ? contentLines : [clean(body, 220)];
				return visible
					.slice(0, options.expanded ? contentLines.length : 1)
					.map((line, index) =>
						safeTruncateToWidth(
							`${index === 0 ? `${theme.fg("muted", label)} ${sender} · ` : "  "}${theme.fg("dim", line)}`,
							width,
						),
					);
			},
		};
	});
}
