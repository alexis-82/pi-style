import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

export interface FakeThemeOptions {
	name?: string;
	colorMode?: "truecolor" | "256color";
	colors?: Partial<Record<ThemeColor, string>>;
	backgrounds?: Partial<
		Record<
			"selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg",
			string
		>
	>;
}

export function createFakeTheme(options: FakeThemeOptions = {}): Theme {
	const colors = options.colors ?? {};
	const foregroundTokens: ThemeColor[] = [
		"accent",
		"border",
		"borderAccent",
		"borderMuted",
		"success",
		"error",
		"warning",
		"muted",
		"dim",
		"text",
		"thinkingText",
		"userMessageText",
		"customMessageText",
		"customMessageLabel",
		"toolTitle",
		"toolOutput",
		"mdHeading",
		"mdLink",
		"mdLinkUrl",
		"mdCode",
		"mdCodeBlock",
		"mdCodeBlockBorder",
		"mdQuote",
		"mdQuoteBorder",
		"mdHr",
		"mdListBullet",
		"toolDiffAdded",
		"toolDiffRemoved",
		"toolDiffContext",
		"syntaxComment",
		"syntaxKeyword",
		"syntaxFunction",
		"syntaxVariable",
		"syntaxString",
		"syntaxNumber",
		"syntaxType",
		"syntaxOperator",
		"syntaxPunctuation",
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"thinkingMax",
		"bashMode",
	];
	const foregrounds = Object.fromEntries(foregroundTokens.map((token) => [token, colors[token] ?? ""])) as Record<
		ThemeColor,
		string
	>;
	const backgrounds = {
		selectedBg: "",
		userMessageBg: "",
		customMessageBg: "",
		toolPendingBg: "",
		toolSuccessBg: "",
		toolErrorBg: "",
		...(options.backgrounds ?? {}),
	};
	return new Theme(foregrounds, backgrounds, options.colorMode ?? "truecolor", { name: options.name ?? "fake" });
}
