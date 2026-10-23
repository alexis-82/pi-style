import { boundedDiagnostics, type ConfigDiagnostic } from "./config-diagnostics.js";
import { presetConfig } from "./config-presets.js";
import {
	type ConfigSources,
	type NormalizedPiStyleConfig,
	PI_STYLE_SCHEMA_VERSION,
	type PiStyleConfig,
} from "./config-types.js";
import { normalizeStatusLayout } from "./status-presets.js";

export const DEFAULT_CONFIG: NormalizedPiStyleConfig = Object.freeze({
	schemaVersion: PI_STYLE_SCHEMA_VERSION,
	enabled: true,
	preset: "default",
	placement: "below",
	startup: Object.freeze({ mode: "compact", showResources: false, alwaysExpanded: false }),
	statusLine: Object.freeze({
		enabled: true,
		separator: "|",
		layout: Object.freeze({
			left: ["claude_line"],
			right: [],
			secondary: [],
		}),
		disabledSegments: [],
		customItems: [],
		bottomMargin: 1,
		contextBarWidth: 10,
	}),
	editor: Object.freeze({ enabled: true, style: "dock", frame: "rounded", showMetadata: false, hint: "" }),
	messages: Object.freeze({
		enabled: true,
		assistantPrefix: true,
		specialBlocks: true,
		hideThinkingLabel: true,
		thoughtSummary: true,
		mergedTurnSummary: true,
		preserveCompactionTranscript: true,
		showImagePreviews: true,
		clipboardImages: true,
		previewMaxWidth: 30,
	}),
	tools: Object.freeze({
		enabled: true,
		style: "compact-box",
		maxCollapsedLines: 10,
		maxExpandedLines: 50,
		dimOutput: false,
		showElapsed: true,
		collapseAfterTurn: true,
		collapseMutatingTools: false,
		mergeChunkedReads: true,
	}),
	theme: Object.freeze({
		nerdFonts: "auto",
		terminalBackgroundSync: "auto",
		autoApply: "titanium",
		colors: {},
		glyphs: {},
	}),
	compatibility: Object.freeze({
		allowSafePatches: true,
		allowCorePatches: false,
		preferExistingEditor: true,
		preferExistingFooter: true,
	}),
	debug: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function merge(base: Record<string, unknown>, source: unknown): Record<string, unknown> {
	if (!isRecord(source)) return base;
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(source))
		result[key] =
			isRecord(value) && isRecord(result[key]) ? merge(result[key] as Record<string, unknown>, value) : value;
	return result;
}
function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.floor(value)))
		: fallback;
}
function stringEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
function strings(value: unknown, fallback: readonly string[]): readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : fallback;
}
function stringMap(value: unknown): Readonly<Record<string, string>> {
	return isRecord(value)
		? Object.fromEntries(
				Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			)
		: {};
}
function customItems(value: unknown): readonly import("./config-types.js").StatusCustomItemConfig[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is import("./config-types.js").StatusCustomItemConfig => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.statusKey !== "string") return false;
		return item.placement === undefined || ["left", "right", "secondary"].includes(item.placement as string);
	});
}

export function normalizeConfig(
	input: unknown,
	defaults: NormalizedPiStyleConfig = DEFAULT_CONFIG,
): NormalizedPiStyleConfig {
	const value = merge(defaults as unknown as Record<string, unknown>, acceptedInput(input));
	const inputRecord = isRecord(input) ? input : {};
	const inputStatus = isRecord(inputRecord.statusLine) ? inputRecord.statusLine : {};
	const inputLayout = isRecord(inputStatus.layout) ? inputStatus.layout : undefined;
	const startup = isRecord(value.startup) ? value.startup : {};
	const status = isRecord(value.statusLine) ? value.statusLine : {};
	const editor = isRecord(value.editor) ? value.editor : {};
	const messages = isRecord(value.messages) ? value.messages : {};
	const tools = isRecord(value.tools) ? value.tools : {};
	const theme = isRecord(value.theme) ? value.theme : {};
	const compatibility = isRecord(value.compatibility) ? value.compatibility : {};
	const max =
		typeof tools.maxCollapsedLines === "number" &&
		Number.isFinite(tools.maxCollapsedLines) &&
		tools.maxCollapsedLines >= 0
			? Math.floor(tools.maxCollapsedLines)
			: defaults.tools.maxCollapsedLines;
	const maxExpanded =
		typeof tools.maxExpandedLines === "number" && Number.isFinite(tools.maxExpandedLines) && tools.maxExpandedLines >= 0
			? Math.min(Math.floor(tools.maxExpandedLines), 1000)
			: defaults.tools.maxExpandedLines;
	return Object.freeze({
		schemaVersion: PI_STYLE_SCHEMA_VERSION,
		enabled: bool(value.enabled, defaults.enabled),
		preset: stringEnum(value.preset, ["default", "minimal", "compact", "full", "ascii", "native"], defaults.preset),
		placement: stringEnum(value.placement, ["above", "below"], defaults.placement),
		startup: Object.freeze({
			mode: stringEnum(startup.mode, ["off", "compact", "overlay"], defaults.startup.mode),
			showResources: bool(startup.showResources, defaults.startup.showResources),
			alwaysExpanded: bool(startup.alwaysExpanded, defaults.startup.alwaysExpanded),
		}),
		statusLine: Object.freeze({
			enabled: bool(status.enabled, defaults.statusLine.enabled),
			separator: typeof status.separator === "string" ? status.separator : defaults.statusLine.separator,
			layout: normalizeStatusLayout(
				stringEnum(value.preset, ["default", "minimal", "compact", "full", "ascii", "native"], defaults.preset),
				inputLayout
					? {
							left:
								inputLayout.left === undefined ? undefined : strings(inputLayout.left, defaults.statusLine.layout.left),
							right:
								inputLayout.right === undefined
									? undefined
									: strings(inputLayout.right, defaults.statusLine.layout.right),
							secondary:
								inputLayout.secondary === undefined
									? undefined
									: strings(inputLayout.secondary, defaults.statusLine.layout.secondary),
						}
					: undefined,
			),
			disabledSegments: strings(status.disabledSegments, defaults.statusLine.disabledSegments),
			customItems: customItems(status.customItems),
			bottomMargin: boundedInt(status.bottomMargin, defaults.statusLine.bottomMargin, 0, 4),
			contextBarWidth: boundedInt(status.contextBarWidth, defaults.statusLine.contextBarWidth, 4, 40),
		}),
		editor: Object.freeze({
			enabled: bool(editor.enabled, defaults.editor.enabled),
			style: stringEnum(editor.style, ["compact", "boxed", "dock", "native"], defaults.editor.style),
			frame: stringEnum(
				editor.frame,
				["auto", "halfblock", "line", "solid", "outline", "rounded", "native"],
				defaults.editor.frame,
			),
			showMetadata: bool(editor.showMetadata, defaults.editor.showMetadata),
			hint: typeof editor.hint === "string" ? editor.hint : defaults.editor.hint,
		}),
		messages: Object.freeze({
			enabled: bool(messages.enabled, defaults.messages.enabled),
			assistantPrefix: bool(messages.assistantPrefix, defaults.messages.assistantPrefix),
			specialBlocks: bool(messages.specialBlocks, defaults.messages.specialBlocks),
			hideThinkingLabel: bool(messages.hideThinkingLabel, defaults.messages.hideThinkingLabel),
			thoughtSummary: bool(messages.thoughtSummary, defaults.messages.thoughtSummary),
			mergedTurnSummary: bool(messages.mergedTurnSummary, defaults.messages.mergedTurnSummary),
			preserveCompactionTranscript: bool(
				messages.preserveCompactionTranscript,
				defaults.messages.preserveCompactionTranscript,
			),
			showImagePreviews: bool(messages.showImagePreviews, defaults.messages.showImagePreviews),
			clipboardImages: bool(messages.clipboardImages, defaults.messages.clipboardImages),
			previewMaxWidth: boundedInt(messages.previewMaxWidth, defaults.messages.previewMaxWidth, 8, 60),
		}),
		tools: Object.freeze({
			enabled: bool(tools.enabled, defaults.tools.enabled),
			style: typeof tools.style === "string" ? tools.style : defaults.tools.style,
			maxCollapsedLines: max,
			maxExpandedLines: maxExpanded,
			dimOutput: bool(tools.dimOutput, defaults.tools.dimOutput),
			showElapsed: bool(tools.showElapsed, defaults.tools.showElapsed),
			collapseAfterTurn: bool(tools.collapseAfterTurn, defaults.tools.collapseAfterTurn),
			collapseMutatingTools: bool(tools.collapseMutatingTools, defaults.tools.collapseMutatingTools),
			mergeChunkedReads: bool(tools.mergeChunkedReads, defaults.tools.mergeChunkedReads),
		}),
		theme: Object.freeze({
			nerdFonts: stringEnum(theme.nerdFonts, ["auto", "on", "off"], defaults.theme.nerdFonts),
			terminalBackgroundSync: stringEnum(
				theme.terminalBackgroundSync,
				["auto", "on", "off"],
				defaults.theme.terminalBackgroundSync,
			),
			autoApply:
				typeof theme.autoApply === "string" && theme.autoApply.trim() !== ""
					? theme.autoApply
					: defaults.theme.autoApply,
			colors: stringMap(theme.colors),
			glyphs: stringMap(theme.glyphs),
		}),
		compatibility: Object.freeze({
			allowSafePatches: bool(compatibility.allowSafePatches, defaults.compatibility.allowSafePatches),
			allowCorePatches: bool(compatibility.allowCorePatches, defaults.compatibility.allowCorePatches),
			preferExistingEditor: bool(compatibility.preferExistingEditor, defaults.compatibility.preferExistingEditor),
			preferExistingFooter: bool(compatibility.preferExistingFooter, defaults.compatibility.preferExistingFooter),
		}),
		debug: bool(value.debug, defaults.debug),
	});
}

export function resolveConfig(sources: ConfigSources): NormalizedPiStyleConfig {
	return resolveConfigDetailed(sources).config;
}

const PRESET_NAMES = ["default", "minimal", "compact", "full", "ascii", "native"] as const;
const ENUMS: Readonly<Record<string, readonly string[]>> = {
	preset: PRESET_NAMES,
	placement: ["above", "below"],
	"startup.mode": ["off", "compact", "overlay"],
	"editor.style": ["compact", "boxed", "dock", "native"],
	"editor.frame": ["auto", "halfblock", "line", "solid", "outline", "rounded", "native"],
	"theme.nerdFonts": ["auto", "on", "off"],
	"theme.terminalBackgroundSync": ["auto", "on", "off"],
};
const BOOL_PATHS = new Set([
	"enabled",
	"startup.showResources",
	"startup.alwaysExpanded",
	"statusLine.enabled",
	"editor.enabled",
	"editor.showMetadata",
	"messages.enabled",
	"messages.assistantPrefix",
	"messages.specialBlocks",
	"messages.hideThinkingLabel",
	"messages.thoughtSummary",
	"messages.mergedTurnSummary",
	"messages.preserveCompactionTranscript",
	"messages.showImagePreviews",
	"messages.clipboardImages",
	"tools.enabled",
	"tools.showElapsed",
	"tools.dimOutput",
	"tools.collapseAfterTurn",
	"tools.collapseMutatingTools",
	"tools.mergeChunkedReads",
	"compatibility.allowSafePatches",
	"compatibility.allowCorePatches",
	"compatibility.preferExistingEditor",
	"compatibility.preferExistingFooter",
	"debug",
]);
const STRING_ARRAY_PATHS = new Set([
	"statusLine.layout.left",
	"statusLine.layout.right",
	"statusLine.layout.secondary",
	"statusLine.disabledSegments",
]);
const MAP_PATHS = new Set(["theme.colors", "theme.glyphs"]);
const CONTAINER_PATHS = new Set([
	"startup",
	"statusLine",
	"statusLine.layout",
	"editor",
	"messages",
	"tools",
	"theme",
	"compatibility",
]);
function validCustomItem(item: unknown): boolean {
	if (!isRecord(item) || typeof item.id !== "string" || typeof item.statusKey !== "string") return false;
	if (Object.keys(item).some((key) => !["id", "statusKey", "label", "priority", "placement"].includes(key)))
		return false;
	if (item.label !== undefined && typeof item.label !== "string") return false;
	if (item.priority !== undefined && (typeof item.priority !== "number" || !Number.isFinite(item.priority)))
		return false;
	return (
		item.placement === undefined ||
		item.placement === "left" ||
		item.placement === "right" ||
		item.placement === "secondary"
	);
}
function validLeaf(path: string, value: unknown): boolean {
	if (BOOL_PATHS.has(path)) return typeof value === "boolean";
	if (ENUMS[path]) return typeof value === "string" && ENUMS[path].includes(value);
	if (path === "theme.autoApply") return typeof value === "string" && value !== "";
	if (path === "statusLine.separator" || path === "tools.style" || path === "editor.hint")
		return typeof value === "string";
	if (path === "tools.maxCollapsedLines" || path === "tools.maxExpandedLines")
		return typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (path === "messages.previewMaxWidth")
		return typeof value === "number" && Number.isFinite(value) && value >= 8 && value <= 60;
	if (path === "statusLine.bottomMargin" || path === "statusLine.contextBarWidth")
		return typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (STRING_ARRAY_PATHS.has(path)) return Array.isArray(value) && value.every((item) => typeof item === "string");
	if (MAP_PATHS.has(path)) return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
	if (path === "statusLine.customItems") return Array.isArray(value) && value.every(validCustomItem);
	return false;
}
export interface ConfigLayerResult {
	readonly accepted: unknown;
	readonly diagnostics: readonly ConfigDiagnostic[];
	readonly paths: ReadonlySet<string>;
}
function cloneLeaf(value: unknown): unknown {
	return Array.isArray(value)
		? value.map((item) => (isRecord(item) ? { ...item } : item))
		: isRecord(value)
			? { ...value }
			: value;
}
export function validateConfigLayer(input: unknown): ConfigLayerResult {
	const diagnostics: ConfigDiagnostic[] = [];
	const paths = new Set<string>();
	const walk = (value: unknown, prefix: string): unknown => {
		if (!isRecord(value)) return value;
		const result: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (path === "schemaVersion") {
				if (nestedValue === undefined || nestedValue === PI_STYLE_SCHEMA_VERSION) result[key] = nestedValue;
				else
					diagnostics.push({
						code: "CFG-SCHEMA",
						level: "warning",
						path,
						message: "unsupported schema version ignored",
					});
				continue;
			}
			if (path === "statusLine.customItems" && Array.isArray(nestedValue)) {
				const acceptedItems: Record<string, unknown>[] = [];
				for (const [index, item] of nestedValue.entries()) {
					if (!isRecord(item)) {
						diagnostics.push({
							code: "CFG-VALUE",
							level: "warning",
							path: `${path}[${index}]`,
							message: "custom item must be an object",
						});
						continue;
					}
					const allowed = ["id", "statusKey", "label", "priority", "placement"];
					let valid = typeof item.id === "string" && typeof item.statusKey === "string";
					if (typeof item.id !== "string")
						diagnostics.push({
							code: "CFG-VALUE",
							level: "warning",
							path: `${path}[${index}].id`,
							message: "required custom item field is invalid or missing",
						});
					if (typeof item.statusKey !== "string")
						diagnostics.push({
							code: "CFG-VALUE",
							level: "warning",
							path: `${path}[${index}].statusKey`,
							message: "required custom item field is invalid or missing",
						});
					for (const field of Object.keys(item)) {
						if (!allowed.includes(field)) {
							diagnostics.push({
								code: "CFG-VALUE",
								level: "warning",
								path: `${path}[${index}].${field}`,
								message: "unknown custom item field ignored",
							});
							valid = false;
						}
					}
					if (item.label !== undefined && typeof item.label !== "string") {
						diagnostics.push({
							code: "CFG-VALUE",
							level: "warning",
							path: `${path}[${index}].label`,
							message: "invalid custom item field ignored",
						});
						valid = false;
					}
					if (item.priority !== undefined && (typeof item.priority !== "number" || !Number.isFinite(item.priority))) {
						diagnostics.push({
							code: "CFG-VALUE",
							level: "warning",
							path: `${path}[${index}].priority`,
							message: "invalid custom item field ignored",
						});
						valid = false;
					}
					if (item.placement !== undefined && !["left", "right", "secondary"].includes(item.placement as string)) {
						diagnostics.push({
							code: "CFG-VALUE",
							level: "warning",
							path: `${path}[${index}].placement`,
							message: "invalid custom item field ignored",
						});
						valid = false;
					}
					if (valid) {
						acceptedItems.push({ ...item });
						paths.add(`${path}[${index}].id`);
						paths.add(`${path}[${index}].statusKey`);
					}
				}
				result[key] = acceptedItems;
				paths.add(path);
				continue;
			}
			if (validLeaf(path, nestedValue)) {
				result[key] = cloneLeaf(nestedValue);
				paths.add(path);
				continue;
			}
			if (
				isRecord(nestedValue) &&
				CONTAINER_PATHS.has(path) &&
				!MAP_PATHS.has(path) &&
				path !== "statusLine.customItems"
			) {
				const child = walk(nestedValue, path);
				if (isRecord(child) && Object.keys(child).length > 0) result[key] = child;
				continue;
			}
			if (path !== "statusLine.customItems" || !Array.isArray(nestedValue))
				diagnostics.push({ code: "CFG-VALUE", level: "warning", path, message: "invalid or unknown field ignored" });
			if (path === "statusLine.customItems" && Array.isArray(nestedValue))
				for (const [index, item] of nestedValue.entries()) {
					if (!isRecord(item)) continue;
					for (const field of ["id", "statusKey", "label", "priority", "placement"]) {
						if (Object.hasOwn(item, field)) {
							const fieldValue = item[field];
							const valid =
								field === "id" || field === "statusKey" || field === "label"
									? typeof fieldValue === "string"
									: field === "priority"
										? typeof fieldValue === "number" && Number.isFinite(fieldValue)
										: fieldValue === "left" || fieldValue === "right" || fieldValue === "secondary";
							if (!valid)
								diagnostics.push({
									code: "CFG-VALUE",
									level: "warning",
									path: `${path}[${index}].${field}`,
									message: "invalid custom item field ignored",
								});
						}
					}
					for (const field of Object.keys(item))
						if (!["id", "statusKey", "label", "priority", "placement"].includes(field))
							diagnostics.push({
								code: "CFG-VALUE",
								level: "warning",
								path: `${path}[${index}].${field}`,
								message: "unknown custom item field ignored",
							});
				}
		}
		return result;
	};
	return { accepted: walk(input, ""), diagnostics: boundedDiagnostics(diagnostics), paths };
}
function acceptedInput(input: unknown): unknown {
	return validateConfigLayer(input).accepted;
}

export function resolveConfigDetailed(sources: ConfigSources): {
	readonly config: NormalizedPiStyleConfig;
	readonly diagnostics: readonly ConfigDiagnostic[];
	readonly sources: Readonly<Record<string, string>>;
} {
	const diagnostics: ConfigDiagnostic[] = [];
	const layerResults = new Map<string, ConfigLayerResult>();
	const layers: readonly [string, unknown][] = [
		["global", sources.global],
		["project", sources.projectTrusted === false ? undefined : sources.project],
		["session", sources.session],
	];
	for (const [name, value] of layers) {
		const result = validateConfigLayer(value);
		layerResults.set(name, result);
		diagnostics.push(...result.diagnostics);
	}
	const defaults = sources.defaults ?? DEFAULT_CONFIG;
	let merged: unknown = defaults;
	const presetCandidates = [
		["session", sources.session],
		["project", sources.projectTrusted === false ? undefined : sources.project],
		["global", sources.global],
		["default", defaults],
	] as const;
	let selectedPreset: unknown;
	for (const [, source] of presetCandidates) {
		const candidate = isRecord(source) ? source.preset : undefined;
		if (candidate === undefined) continue;
		if (typeof candidate === "string" && (PRESET_NAMES as readonly string[]).includes(candidate)) {
			selectedPreset = candidate;
			break;
		}
		diagnostics.push({
			code: "CFG-ENUM",
			level: "warning",
			path: "preset",
			message: "unsupported value; lower-precedence preset used",
		});
	}
	merged = merge(isRecord(merged) ? merged : {}, presetConfig(selectedPreset));
	for (const name of ["global", "project"] as const)
		merged = merge(isRecord(merged) ? merged : {}, layerResults.get(name)?.accepted);
	const env = sources.environment ?? {};
	const envPatch: PiStyleConfig = {};
	if (env.PI_STYLE_DISABLED === "1") envPatch.enabled = false;
	if (env.PI_STYLE_NERD_FONTS === "1" || env.PI_STYLE_NERD_FONTS === "0")
		envPatch.theme = { nerdFonts: env.PI_STYLE_NERD_FONTS === "1" ? "on" : "off" };
	if (env.PI_STYLE_EDITOR && ["native", "compact", "boxed", "dock"].includes(env.PI_STYLE_EDITOR))
		envPatch.editor = { style: env.PI_STYLE_EDITOR };
	if (env.PI_STYLE_THEME !== undefined && env.PI_STYLE_THEME !== "")
		envPatch.theme = { ...(envPatch.theme ?? {}), autoApply: env.PI_STYLE_THEME };
	if (env.PI_STYLE_OSC11 === "1" || env.PI_STYLE_OSC11 === "0")
		envPatch.theme = { ...(envPatch.theme ?? {}), terminalBackgroundSync: env.PI_STYLE_OSC11 === "1" ? "on" : "off" };
	if (env.PI_STYLE_DEBUG === "1") envPatch.debug = true;
	if (env.PI_STYLE_STATUS === "above" || env.PI_STYLE_STATUS === "below") envPatch.placement = env.PI_STYLE_STATUS;
	if (env.PI_STYLE_STATUS === "off") envPatch.statusLine = { enabled: false };
	if (env.PI_STYLE_DISABLED !== undefined && env.PI_STYLE_DISABLED !== "1")
		diagnostics.push({
			code: "CFG-ENV",
			level: "warning",
			path: "PI_STYLE_DISABLED",
			message: "expected 1; override ignored",
		});
	if (env.PI_STYLE_NERD_FONTS !== undefined && !["0", "1"].includes(env.PI_STYLE_NERD_FONTS))
		diagnostics.push({
			code: "CFG-ENV",
			level: "warning",
			path: "PI_STYLE_NERD_FONTS",
			message: "expected 0 or 1; override ignored",
		});
	if (env.PI_STYLE_STATUS !== undefined && !["above", "below", "off"].includes(env.PI_STYLE_STATUS))
		diagnostics.push({
			code: "CFG-ENV",
			level: "warning",
			path: "PI_STYLE_STATUS",
			message: "expected above, below, or off; override ignored",
		});
	if (env.PI_STYLE_EDITOR !== undefined && !["native", "compact", "boxed", "dock"].includes(env.PI_STYLE_EDITOR))
		diagnostics.push({
			code: "CFG-ENV",
			level: "warning",
			path: "PI_STYLE_EDITOR",
			message: "unknown editor style; override ignored",
		});
	for (const [key, value] of Object.entries(env))
		if (
			value !== undefined &&
			key.startsWith("PI_STYLE_") &&
			![
				"PI_STYLE_DISABLED",
				"PI_STYLE_NERD_FONTS",
				"PI_STYLE_EDITOR",
				"PI_STYLE_OSC11",
				"PI_STYLE_DEBUG",
				"PI_STYLE_STATUS",
				"PI_STYLE_THEME",
			].includes(key)
		)
			diagnostics.push({
				code: "CFG-ENV",
				level: "warning",
				path: key,
				message: "unsupported environment override ignored",
			});
	merged = merge(isRecord(merged) ? merged : {}, envPatch);
	merged = merge(isRecord(merged) ? merged : {}, layerResults.get("session")?.accepted);
	const sourceMap: Record<string, string> = {};
	const sourcePath = (value: unknown, prefix: string, sourceName: string) => {
		if (!isRecord(value)) return;
		for (const [key, nested] of Object.entries(value)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (validLeaf(path, nested)) {
				sourceMap[path] = sourceName;
				if (path === "statusLine.customItems" && Array.isArray(nested))
					for (const [index, item] of nested.entries())
						if (isRecord(item))
							for (const field of ["id", "statusKey", "label", "priority", "placement"])
								if (Object.hasOwn(item, field)) sourceMap[`${path}[${index}].${field}`] = sourceName;
				continue;
			}
			if (isRecord(nested)) sourcePath(nested, path, sourceName);
		}
	};
	sourcePath(defaults, "", "default");
	sourcePath(
		presetConfig(selectedPreset),
		"",
		`preset:${typeof selectedPreset === "string" ? selectedPreset : "default"}`,
	);
	sourcePath(layerResults.get("global")?.accepted, "", "global");
	if (sources.projectTrusted !== false) sourcePath(layerResults.get("project")?.accepted, "", "project");
	sourcePath(envPatch, "", "environment");
	sourcePath(layerResults.get("session")?.accepted, "", "session");
	return { config: normalizeConfig(merged), diagnostics: boundedDiagnostics(diagnostics), sources: sourceMap };
}
