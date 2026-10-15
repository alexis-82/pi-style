import type { NormalizedPiStyleConfig } from "./config-types.js";

export type GlyphMode = "nerd" | "unicode" | "ascii";
export type SemanticToken =
	| "surface"
	| "surfaceRaised"
	| "surfaceMuted"
	| "text"
	| "muted"
	| "dim"
	| "accent"
	| "accentStrong"
	| "border"
	| "borderMuted"
	| "borderActive"
	| "success"
	| "warning"
	| "error"
	| "model"
	| "thinking"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "path"
	| "gitClean"
	| "gitDirty"
	| "contextLow"
	| "contextMedium"
	| "contextHigh"
	| "contextCritical"
	| "tokens"
	| "cache"
	| "cost"
	| "time"
	| "separator"
	| "hint";

/** Structural view of Pi's theme. fg/bg follow Pi's `(color, text) => string` shape. */
export interface ActiveTheme {
	fg?: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	colors?: Record<string, string>;
}

export interface ResolvedTheme {
	/** ANSI color prefix for a semantic token, or "" when uncolored. */
	readonly color: (token: SemanticToken) => string;
	/** Prefix + text + reset; returns plain text when the token is uncolored. */
	readonly apply: (token: SemanticToken, text: string) => string;
	/** Rainbow gradient text (used for high thinking levels); plain when uncolored. */
	readonly rainbow: (text: string) => string;
	readonly glyph: (name: keyof typeof GLYPHS.unicode) => string;
	readonly mode: GlyphMode;
	readonly noColor: boolean;
}

/**
 * Default semantic colors — hex values render without any Pi theme; theme names resolve through Pi's theme.
 */
const SEMANTIC_COLORS: Record<SemanticToken, string> = {
	surface: "",
	surfaceRaised: "",
	surfaceMuted: "",
	text: "text",
	muted: "muted",
	dim: "dim",
	accent: "accent",
	accentStrong: "accent",
	border: "border",
	borderMuted: "borderMuted",
	borderActive: "borderAccent",
	success: "success",
	warning: "warning",
	error: "error",
	model: "#d787af",
	thinking: "thinkingOff",
	thinkingMinimal: "thinkingMinimal",
	thinkingLow: "thinkingLow",
	thinkingMedium: "thinkingMedium",
	thinkingHigh: "thinkingHigh",
	thinkingXhigh: "thinkingXhigh",
	thinkingMax: "thinkingMax",
	path: "#00afaf",
	gitClean: "success",
	gitDirty: "warning",
	contextLow: "dim",
	contextMedium: "warning",
	contextHigh: "error",
	contextCritical: "error",
	tokens: "muted",
	cache: "muted",
	cost: "text",
	time: "muted",
	separator: "dim",
	hint: "#8a8a8a",
};

const GLYPHS = {
	nerd: {
		pi: "π",
		git: "\uE0A0",
		path: "\uF07B",
		context: "\u{F035B}",
		separator: "\uE0B0",
		powerlineLeft: "\uE0B0",
		powerlineRight: "\uE0B2",
		powerlineThinLeft: "\uE0B1",
		powerlineThinRight: "\uE0B3",
		batchOpen: "\u{F111}",
		bashPrompt: "\u{F12A}",
		eventRunning: "\uF10C",
		eventSettled: "\uF111",
		eventFailed: "✗",
		eventStopped: "○",
	},
	unicode: {
		pi: "π",
		git: "⎇",
		path: "⌂",
		context: "◫",
		separator: "│",
		powerlineLeft: "›",
		powerlineRight: "‹",
		powerlineThinLeft: "│",
		powerlineThinRight: "│",
		batchOpen: "●",
		bashPrompt: "$",
		eventRunning: "◌",
		eventSettled: "●",
		eventFailed: "✗",
		eventStopped: "○",
	},
	ascii: {
		pi: "pi",
		git: "git",
		path: "path",
		context: "ctx",
		separator: "|",
		powerlineLeft: ">",
		powerlineRight: "<",
		powerlineThinLeft: "|",
		powerlineThinRight: "|",
		batchOpen: "v",
		bashPrompt: "$",
		eventRunning: "~",
		eventSettled: "*",
		eventFailed: "x",
		eventStopped: "o",
	},
} as const;

function isHex(color: string): color is `#${string}` {
	return /^#[0-9a-fA-F]{6}$/.test(color);
}

export function hexToAnsiPrefix(hex: string): string {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Rainbow gradient for high thinking levels. */
const RAINBOW_COLORS = [
	"#b281d6",
	"#d787af",
	"#febc38",
	"#e4c00f",
	"#89d281",
	"#00afaf",
	"#178fb9",
	"#b281d6",
] as const;

function rainbowAnsi(text: string): string {
	let result = "";
	let colorIndex = 0;
	for (const char of text) {
		if (char === " " || char === ":") {
			result += char;
		} else {
			result += hexToAnsiPrefix(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length] ?? "#b281d6") + char;
			colorIndex++;
		}
	}
	return `${result}\x1b[0m`;
}

function colorPrefixFor(
	active: ActiveTheme | undefined,
	config: NormalizedPiStyleConfig,
	noColor: boolean,
	token: SemanticToken,
): string {
	if (noColor) return "";
	const raw = config.theme.colors[token] ?? SEMANTIC_COLORS[token];
	if (!raw) return "";
	if (isHex(raw)) return hexToAnsiPrefix(raw);
	if (active?.fg) {
		try {
			// Pi's fg returns `\x1b[38;5;Nm` + text + `\x1b[39m`; keep only the prefix.
			const styled = active.fg(raw, "");
			return styled.endsWith("\x1b[39m") ? styled.slice(0, -5) : styled;
		} catch {
			return "";
		}
	}
	return "";
}

function envKeyFor(env: Record<string, string | undefined>): string {
	return `${env.PI_STYLE_NERD_FONTS ?? ""}\u0000${env.GHOSTTY_RESOURCES_DIR ? "1" : "0"}\u0000${env.TERM_PROGRAM ?? ""}`;
}

const glyphModeCache = new WeakMap<object, Map<string, GlyphMode>>();

export function detectGlyphMode(
	config: NormalizedPiStyleConfig,
	env: Record<string, string | undefined> = {},
): GlyphMode {
	// Memoized per config object; the env-derived key keeps the result correct
	// when the same config is resolved against different environments.
	let byEnv = glyphModeCache.get(config);
	if (!byEnv) {
		byEnv = new Map();
		glyphModeCache.set(config, byEnv);
	}
	const envKey = envKeyFor(env);
	const cached = byEnv.get(envKey);
	if (cached !== undefined) return cached;
	const mode = computeGlyphMode(config, env);
	byEnv.set(envKey, mode);
	return mode;
}

function computeGlyphMode(config: NormalizedPiStyleConfig, env: Record<string, string | undefined>): GlyphMode {
	if (env.PI_STYLE_NERD_FONTS === "1") return "nerd";
	if (env.PI_STYLE_NERD_FONTS === "0") return "unicode";
	if (config.theme.nerdFonts === "on") return "nerd";
	if (config.theme.nerdFonts === "off") return "unicode";
	if (env.GHOSTTY_RESOURCES_DIR) return "nerd";
	// Conservative heuristic: known terminals commonly ship with a Nerd Font. An explicit override stays authoritative.
	const term = (env.TERM_PROGRAM ?? "").toLowerCase();
	if (["iterm", "wezterm", "kitty", "ghostty", "alacritty", "warp"].some((name) => term.includes(name))) {
		return "nerd";
	}
	return config.preset === "ascii" ? "ascii" : "unicode";
}

export function resolveTheme(
	active: ActiveTheme | undefined,
	config: NormalizedPiStyleConfig,
	env: Record<string, string | undefined> = {},
): ResolvedTheme {
	const noColor = Object.hasOwn(env, "NO_COLOR") && env.NO_COLOR !== "" && config.theme.colors.colorOverride !== "on";
	const mode = config.preset === "ascii" ? "ascii" : detectGlyphMode(config, env);
	// Lazy per-instance prefix memo: repeated apply(token, ...) calls stop
	// re-running colorPrefixFor (and Pi's active.fg()) for the same token.
	const prefixes = new Map<SemanticToken, string>();
	const color = (token: SemanticToken): string => {
		const cached = prefixes.get(token);
		if (cached !== undefined) return cached;
		const prefix = colorPrefixFor(active, config, noColor, token);
		prefixes.set(token, prefix);
		return prefix;
	};
	return {
		mode,
		noColor,
		color,
		apply: (token, text) => {
			const prefix = color(token);
			return prefix ? `${prefix}${text}\x1b[0m` : text;
		},
		rainbow: (text) => (noColor ? text : rainbowAnsi(text)),
		glyph: (name) => config.theme.glyphs[name] ?? GLYPHS[mode][name],
	};
}
export { GLYPHS };
