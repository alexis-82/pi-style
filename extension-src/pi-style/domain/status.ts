import type { ResolvedTheme, SemanticToken } from "./theme.js";

export const STATUS_SEGMENT_IDS = [
	"pi",
	"model",
	"thinking",
	"model_effort",
	"path",
	"git",
	"context_pct",
	"context_bar",
	"context_total",
	"auto_compact",
	"token_in",
	"token_out",
	"cache_read",
	"cache_write",
	"cost",
	"time_spent",
	"time",
	"hostname",
	"session",
	"extension_statuses",
	"claude_line",
] as const;
export type StatusSegmentId = (typeof STATUS_SEGMENT_IDS)[number] | (string & {});
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ContextState = "low" | "medium" | "high" | "critical";

export interface GitSnapshot {
	readonly available: boolean;
	readonly branch: string | null;
	readonly staged: number;
	readonly unstaged: number;
	readonly untracked: number;
	readonly ahead?: number;
	readonly behind?: number;
	readonly refreshing: boolean;
	readonly error?: string;
}

export interface ContextSnapshot {
	readonly currentTokens?: number;
	readonly windowTokens?: number;
	readonly percent?: number;
	readonly state?: ContextState;
	readonly autoCompacting?: boolean;
	readonly customCompaction?: string;
}

export interface UsageSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly cost?: number;
	readonly currency?: string;
	readonly subscriptionMode?: "api" | "subscription" | "unknown";
	readonly streaming: boolean;
}

export interface RateLimitWindow {
	/** Utilization of the plan window, 0-100. */
	readonly percent: number;
	/** Unix epoch seconds when the window resets, when known. */
	readonly resetsAt?: number;
}

/** Subscription plan limits reported by the provider (e.g. Claude account 5h/7d windows). */
export interface RateLimitsSnapshot {
	readonly fiveHour?: RateLimitWindow;
	readonly weekly?: RateLimitWindow;
}

export interface ExtensionStatus {
	readonly key: string;
	readonly value: string;
}

export interface StatusSnapshot {
	readonly model?: string;
	/** Provider name for the active model (e.g. `deepseek`), when known. */
	readonly provider?: string;
	/** Whether the active model supports reasoning/thinking levels, when known. */
	readonly reasoning?: boolean;
	readonly thinkingLevel?: ThinkingLevel;
	readonly cwd?: string;
	readonly git?: GitSnapshot;
	readonly context?: ContextSnapshot;
	readonly usage?: UsageSnapshot;
	readonly rateLimits?: RateLimitsSnapshot;
	readonly hostname?: string;
	readonly sessionName?: string | undefined;
	/** Per-session editor frame color; independent of thinking effort. */
	readonly editorBorderColor?: string | undefined;
	readonly sessionId?: string | undefined;
	readonly sessionStartedAt?: number;
	readonly extensionStatuses?: readonly ExtensionStatus[];
}

export interface StatusSegmentOptions {
	readonly disabled?: boolean;
	readonly label?: string;
	readonly [key: string]: unknown;
}

export interface StatusCustomItem {
	readonly id: string;
	readonly statusKey: string;
	readonly label?: string;
	readonly priority?: number;
	readonly placement?: "left" | "right" | "secondary";
}

export interface SegmentContext {
	readonly snapshot: StatusSnapshot;
	readonly theme: ResolvedTheme;
	readonly options: Readonly<Record<string, StatusSegmentOptions | undefined>>;
	readonly width: number;
}

export interface SegmentRenderResult {
	readonly visible: boolean;
	readonly content: string;
	readonly compactContent?: string;
	readonly minWidth?: number;
	readonly truncatable?: boolean;
}

export interface StatusSegment {
	readonly id: StatusSegmentId;
	readonly defaultPriority: number;
	readonly essential?: boolean;
	readonly overflow?: "primary" | "secondary" | "drop";
	render(context: SegmentContext): SegmentRenderResult;
}

export interface StatusLayout {
	readonly left: readonly StatusSegmentId[];
	readonly right: readonly StatusSegmentId[];
	readonly secondary: readonly StatusSegmentId[];
}

export interface StatusRenderResult {
	readonly primary: string;
	readonly secondary?: string;
	readonly lines: readonly string[];
	readonly visibleSegments: readonly StatusSegmentId[];
}

function segment(
	id: StatusSegmentId,
	priority: number,
	render: StatusSegment["render"],
	essential = false,
): StatusSegment {
	return { id, defaultPriority: priority, essential, overflow: essential ? "primary" : "secondary", render };
}

export function createBuiltinSegments(): ReadonlyMap<StatusSegmentId, StatusSegment> {
	const segments: StatusSegment[] = [
		segment("pi", 10, ({ theme }) => ({
			visible: true,
			content: theme.apply("accent", `${theme.glyph("pi")} pi`),
			compactContent: theme.apply("accent", theme.glyph("pi")),
		})),
		segment(
			"model",
			100,
			({ snapshot, theme }) => ({
				visible: Boolean(snapshot.model),
				content: theme.apply("model", snapshot.model ?? ""),
				compactContent: theme.apply("model", snapshot.model ?? ""),
				truncatable: true,
			}),
			true,
		),
		segment(
			"model_effort",
			40,
			({ snapshot, theme }) => {
				const model = snapshot.model;
				if (!model) return { visible: false, content: "" };
				const label = snapshot.provider ? `(${snapshot.provider}) ${model}` : model;
				const styledLabel = theme.apply("model", label);
				const effort = effortLevel(snapshot);
				if (!effort) {
					return { visible: true, content: styledLabel, compactContent: theme.apply("model", model) };
				}
				return {
					visible: true,
					content: `${styledLabel} ${theme.apply("separator", "•")} ${styleEffort(theme, effort)}`,
					compactContent: theme.apply("model", model),
				};
			},
			false,
		),
		segment(
			"thinking",
			95,
			({ snapshot, theme }) => {
				const level = snapshot.thinkingLevel;
				if (!level) return { visible: false, content: "" };
				const label = thinkingLabel(level);
				const text = `think:${label}`;
				const compactText = `t:${label}`;
				if (level === "high" || level === "xhigh" || level === "max") {
					return { visible: true, content: theme.rainbow(text), compactContent: theme.rainbow(compactText) };
				}
				const token =
					level === "minimal"
						? "thinkingMinimal"
						: level === "low"
							? "thinkingLow"
							: level === "medium"
								? "thinkingMedium"
								: "thinking";
				return {
					visible: true,
					content: theme.apply(token, text),
					compactContent: theme.apply(token, compactText),
				};
			},
			true,
		),
		segment("path", 80, ({ snapshot, theme }) => {
			const name = snapshot.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? snapshot.cwd;
			return {
				visible: Boolean(snapshot.cwd),
				content: theme.apply("path", name ?? ""),
				compactContent: theme.apply("path", name ?? ""),
				truncatable: true,
			};
		}),
		segment("git", 75, ({ snapshot, theme }) => {
			const git = snapshot.git;
			if (!git?.available || !git.branch) return { visible: false, content: "" };
			const counts = `${git.staged ? ` +${git.staged}` : ""}${git.unstaged ? ` *${git.unstaged}` : ""}${git.untracked ? ` ?${git.untracked}` : ""}`;
			const token = git.staged || git.unstaged || git.untracked ? "gitDirty" : "gitClean";
			return {
				visible: true,
				content: theme.apply(token, `${theme.glyph("git")} ${git.branch}${counts}`),
				compactContent: theme.apply(token, `${theme.glyph("git")} ${git.branch}`),
			};
		}),
		segment(
			"context_pct",
			90,
			({ snapshot, theme }) => {
				const percent = contextPercent(snapshot.context ?? {});
				const state = contextState(percent);
				const token =
					state === "critical"
						? "contextCritical"
						: state === "high"
							? "contextHigh"
							: state === "medium"
								? "contextMedium"
								: "contextLow";
				return {
					visible: percent !== undefined,
					content: percent === undefined ? "" : theme.apply(token, `ctx:${Math.round(percent)}%`),
					compactContent: percent === undefined ? "" : theme.apply(token, `${Math.round(percent)}%`),
				};
			},
			true,
		),
		segment("context_bar", 70, ({ snapshot, theme, options }) => {
			const percent = contextPercent(snapshot.context ?? {});
			if (percent === undefined) return { visible: false, content: "" };
			const token = contextBarToken(percent);
			const width = (options.context_bar?.width as number | undefined) ?? CONTEXT_BAR_WIDTH;
			// Pipe-delimited context block: `[█████░░░░░] | 47% used | 235K/1.0M`.
			// Uses plain `|` (not the tall `│`) so the inline block stays visually short.
			// No boundary pipes: the status renderer's segment separator already
			// delimits the block, and extra pipes would double it up.
			const pipe = theme.apply("separator", "|");
			const bar = `${theme.apply("muted", "[")}${theme.apply(token, contextBar(percent, width))}${theme.apply("muted", "]")}`;
			const parts = [bar, `${theme.apply(token, `${Math.round(percent)}%`)}${theme.apply("muted", " used")}`];
			const current = snapshot.context?.currentTokens;
			const window = snapshot.context?.windowTokens;
			if (current !== undefined && window !== undefined)
				parts.push(theme.apply("muted", `${formatTokens(current)}/${formatTokens(window)}`));
			return {
				visible: true,
				content: parts.join(` ${pipe} `),
				compactContent: theme.apply(token, `${Math.round(percent)}%`),
			};
		}),
		segment("context_total", 60, ({ snapshot, theme }) => ({
			visible: snapshot.context?.currentTokens !== undefined && snapshot.context.windowTokens !== undefined,
			content:
				snapshot.context?.currentTokens !== undefined && snapshot.context.windowTokens !== undefined
					? theme.apply("contextLow", `${snapshot.context.currentTokens}/${snapshot.context.windowTokens}`)
					: "",
		})),
		segment("auto_compact", 55, ({ snapshot, theme }) => ({
			visible: Boolean(snapshot.context?.autoCompacting || snapshot.context?.customCompaction),
			content: theme.apply("warning", snapshot.context?.customCompaction ?? "compacting"),
			compactContent: theme.apply("warning", "compact"),
		})),
		segment("token_in", 50, ({ snapshot, theme }) => ({
			visible: snapshot.usage?.inputTokens !== undefined,
			content: theme.apply("tokens", `in:${snapshot.usage?.inputTokens ?? 0}`),
			compactContent: theme.apply("tokens", `i:${snapshot.usage?.inputTokens ?? 0}`),
		})),
		segment("token_out", 50, ({ snapshot, theme }) => ({
			visible: snapshot.usage?.outputTokens !== undefined,
			content: theme.apply("tokens", `out:${snapshot.usage?.outputTokens ?? 0}`),
			compactContent: theme.apply("tokens", `o:${snapshot.usage?.outputTokens ?? 0}`),
		})),
		segment("cache_read", 40, ({ snapshot, theme }) => ({
			visible: Boolean(snapshot.usage?.cacheReadTokens),
			content: theme.apply("cache", `cache:${snapshot.usage?.cacheReadTokens ?? 0}`),
			compactContent: theme.apply("cache", `cr:${snapshot.usage?.cacheReadTokens ?? 0}`),
		})),
		segment("cache_write", 35, ({ snapshot, theme }) => ({
			visible: Boolean(snapshot.usage?.cacheWriteTokens),
			content: theme.apply("cache", `cw:${snapshot.usage?.cacheWriteTokens ?? 0}`),
		})),
		segment("cost", 65, ({ snapshot, theme }) => {
			const cost = snapshot.usage?.cost;
			const content = cost === undefined || cost <= 0 ? "" : theme.apply("cost", `$${cost.toFixed(3)}`);
			return { visible: Boolean(content), content, compactContent: content };
		}),
		segment("time_spent", 25, ({ snapshot, theme }) => ({
			visible: snapshot.sessionStartedAt !== undefined,
			content:
				snapshot.sessionStartedAt === undefined
					? ""
					: theme.apply("time", formatElapsed(Date.now() - snapshot.sessionStartedAt)),
			compactContent:
				snapshot.sessionStartedAt === undefined
					? ""
					: theme.apply("time", formatElapsed(Date.now() - snapshot.sessionStartedAt)),
		})),
		segment("time", 20, ({ theme }) => {
			const text = theme.apply("time", clockTime());
			return { visible: true, content: text, compactContent: text };
		}),
		segment("hostname", 20, ({ snapshot, theme }) => ({
			visible: Boolean(snapshot.hostname),
			content: theme.apply("muted", snapshot.hostname ?? ""),
		})),
		segment("session", 20, ({ snapshot, theme }) => ({
			visible: Boolean(snapshot.sessionName || snapshot.sessionId),
			content: theme.apply("muted", snapshot.sessionName ?? snapshot.sessionId ?? ""),
		})),
		segment("extension_statuses", 30, ({ snapshot, theme }) => {
			const statuses = snapshot.extensionStatuses;
			if (!statuses || statuses.length === 0) return { visible: false, content: "" };
			// Values already carry their display label (extensions publish via
			// `ctx.ui.setStatus(key, text)` where text is the visible string).
			// Mirror Pi's native footer: sort by key, join the values only.
			const text = [...statuses]
				.sort((a, b) => a.key.localeCompare(b.key))
				.map((item) => item.value)
				.join(" ");
			return { visible: true, content: theme.apply("muted", text) };
		}),
		segment(
			"claude_line",
			100,
			({ snapshot, theme, options }) => {
				// Mirrors the Claude Code status line: `Model ctx [bar] N% project (git branch)`.
				const parts: string[] = [];
				if (snapshot.model) parts.push(`${CL.bold}${CL.white}${snapshot.model}${CL.reset}`);
				const percent = contextPercent(snapshot.context ?? {});
				const width = (options.context_bar?.width as number | undefined) ?? CONTEXT_BAR_WIDTH;
				if (percent !== undefined) parts.push(claudeBarSegment("ctx", percent, width));
				const { fiveHour, weekly } = snapshot.rateLimits ?? {};
				if (fiveHour) parts.push(claudeBarSegment("5h", fiveHour.percent, width, CL.yellow, CL.yellowBg));
				if (weekly) parts.push(claudeBarSegment("weekly", weekly.percent, width, CL.purple, CL.purpleBg));
				const countdown = fiveHour?.resetsAt === undefined ? "" : resetCountdown(fiveHour.resetsAt);
				if (countdown) parts.push(`${CL.white}${countdown}${CL.reset}`);
				const name = snapshot.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
				const branch = snapshot.git?.available ? snapshot.git.branch : null;
				let where = name ? `${CL.bold}${CL.cyan}${name}${CL.reset}` : "";
				if (branch) {
					const git = `${CL.gray}(${CL.reset}${CL.white}${theme.glyph("git")}${CL.reset} ${CL.green}${branch}${CL.reset}${CL.gray})${CL.reset}`;
					where = where ? `${where} ${git}` : git;
				}
				if (where) parts.push(where);
				const compact = [
					snapshot.model ? `${CL.bold}${CL.white}${snapshot.model}${CL.reset}` : "",
					percent === undefined ? "" : `${CL.bold}${CL.green}${Math.round(percent)}%${CL.reset}`,
					name ? `${CL.bold}${CL.cyan}${name}${CL.reset}` : "",
				].filter(Boolean);
				return { visible: parts.length > 0, content: parts.join(" "), compactContent: compact.join(" ") };
			},
			true,
		),
	];
	return new Map(segments.map((item) => [item.id, item]));
}

/** Cached clock text: the minute-precision string only changes once per minute. */
let clockCache: { minuteKey: number; value: string } | undefined;
function clockTime(): string {
	const now = new Date();
	const minuteKey = now.getHours() * 60 + now.getMinutes();
	if (clockCache?.minuteKey !== minuteKey) {
		clockCache = { minuteKey, value: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
	}
	return clockCache.value;
}

const CONTEXT_BAR_WIDTH = 10;

/** Fixed 256-color palette shared with the Claude Code status line script. */
const CL = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	gray: "\x1b[90m",
	white: "\x1b[97m",
	green: "\x1b[38;5;78m",
	yellow: "\x1b[38;5;220m",
	purple: "\x1b[38;5;135m",
	cyan: "\x1b[38;5;45m",
	greenBg: "\x1b[48;5;78m",
	yellowBg: "\x1b[48;5;220m",
	purpleBg: "\x1b[48;5;135m",
	emptyBg: "\x1b[48;5;238m",
} as const;

function claudeBarSegment(
	label: string,
	percent: number,
	width = CONTEXT_BAR_WIDTH,
	color: string = CL.green,
	fillBg: string = CL.greenBg,
): string {
	const clamped = Math.max(0, Math.min(100, percent));
	let filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
	if (clamped > 0 && filled === 0) filled = 1;
	const bar =
		`${CL.gray}[${CL.reset}` +
		`${fillBg}${" ".repeat(filled)}${CL.reset}` +
		`${CL.emptyBg}${" ".repeat(width - filled)}${CL.reset}` +
		`${CL.gray}]${CL.reset}`;
	return `${CL.white}${label}${CL.reset} ${bar} ${CL.bold}${color}${Math.round(clamped)}%${CL.reset}`;
}

/** `2h05m` until the given epoch-seconds reset; empty once it has passed. */
function resetCountdown(resetsAt: number): string {
	const secs = Math.floor(resetsAt - Date.now() / 1000);
	if (secs <= 0) return "";
	return `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}m`;
}

function contextBar(percent: number, width = CONTEXT_BAR_WIDTH): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Bar colors: green under 50%, yellow from 50% to 70%, red above 70%. */
function contextBarToken(percent: number): SemanticToken {
	if (percent > 70) return "error";
	if (percent >= 50) return "warning";
	return "success";
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) {
		const thousands = value / 1_000;
		return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
	}
	return String(value);
}

function effortLevel(snapshot: StatusSnapshot): ThinkingLevel | undefined {
	const level = snapshot.thinkingLevel;
	if (!level) return undefined;
	// Reasoning models always surface an effort level (defaulting to off); other
	// models only show a level when one is actively set.
	if (snapshot.reasoning === true) return level;
	return level === "off" ? undefined : level;
}

function styleEffort(theme: ResolvedTheme, level: ThinkingLevel): string {
	if (level === "high" || level === "xhigh" || level === "max") return theme.rainbow(level);
	const token =
		level === "minimal"
			? "thinkingMinimal"
			: level === "low"
				? "thinkingLow"
				: level === "medium"
					? "thinkingMedium"
					: "thinking";
	return theme.apply(token, level);
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function thinkingLabel(level: ThinkingLevel): string {
	return level === "minimal" ? "min" : level === "medium" ? "med" : level;
}

export function contextState(percent: number | undefined): ContextState | undefined {
	if (percent === undefined || !Number.isFinite(percent)) return undefined;
	if (percent >= 90) return "critical";
	if (percent >= 75) return "high";
	if (percent >= 50) return "medium";
	return "low";
}

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string)
		? (value as ThinkingLevel)
		: "off";
}

export function contextPercent(
	value: Pick<ContextSnapshot, "currentTokens" | "windowTokens" | "percent">,
): number | undefined {
	const percent =
		value.percent ??
		(value.currentTokens !== undefined && value.windowTokens
			? (value.currentTokens / value.windowTokens) * 100
			: undefined);
	return percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
}

export function contextSemanticToken(state: ContextState): SemanticToken {
	return state === "critical"
		? "contextCritical"
		: state === "high"
			? "contextHigh"
			: state === "medium"
				? "contextMedium"
				: "contextLow";
}
