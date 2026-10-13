import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { decorateMessageUpdate } from "../../extension-src/pi-style/features/messages/index.js";
import {
	disposePiCompatibilityProbe,
	probePiCompatibility,
	TRUSTED_NATIVE_FINGERPRINTS,
	targetSpecs,
} from "../../extension-src/pi-style/pi/compatibility-probe.js";
import { getCompatibilityRecords } from "../../extension-src/pi-style/pi/compatibility-registry.js";

const COLLAPSE_SNAPSHOT = {
	assistantPrefix: "│ ",
	assistantEnabled: true,
	collapseHiddenThinking: true,
} as const;

afterEach(() => {
	for (const spec of targetSpecs) {
		for (const record of getCompatibilityRecords(spec.target)) record.disposer();
	}
});

function assistantMessage(
	content: AssistantMessage["content"],
): ConstructorParameters<typeof AssistantMessageComponent>[0] {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function thinkingThenAnswer(): ConstructorParameters<typeof AssistantMessageComponent>[0] {
	return assistantMessage([
		{ type: "thinking", thinking: "Let me think carefully about this problem step by step." },
		{ type: "text", text: "Final answer." },
	]);
}

function stripAnsi(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index++) {
		if (value[index] !== "\x1b") {
			output += value[index];
			continue;
		}
		if (value[index + 1] === "]") {
			index += 2;
			while (index < value.length && value.charCodeAt(index) !== 7) index++;
			continue;
		}
		if (value[index + 1] === "[") {
			index += 2;
			while (index < value.length && (value.charCodeAt(index) < 64 || value.charCodeAt(index) > 126)) index++;
		}
	}
	return output;
}

// pi-coding-agent resolves its own nested pi-tui copy, so class identity across
// the module boundary is not shared; assert on the public component shape instead.
// Pi 0.85.0 wraps thinking-run components in a render-transparent MouseRegion.
function unwrapMouseRegion(child: unknown): unknown {
	const candidate = child as { handleMouse?: unknown; child?: unknown } | undefined;
	if (typeof candidate?.handleMouse !== "function" || candidate.child === undefined) return child;
	return candidate.child;
}
function isSpacerLike(child: unknown): boolean {
	return typeof (child as { setLines?: unknown }).setLines === "function";
}
function isTextLike(child: unknown): boolean {
	return typeof (unwrapMouseRegion(child) as { setCustomBgFn?: unknown }).setCustomBgFn === "function";
}
function isMarkdownLike(child: unknown): boolean {
	const candidate = unwrapMouseRegion(child);
	return (
		typeof (candidate as { setText?: unknown }).setText === "function" &&
		!isTextLike(candidate) &&
		!isSpacerLike(candidate)
	);
}

describe("hidden-thinking label collapse", () => {
	it("keeps the top padding for a thinking-only message while it is still streaming", () => {
		initTheme("dark", false);
		const message = assistantMessage([{ type: "thinking", thinking: "Streaming thought." }]);
		const comp = new AssistantMessageComponent(message, true, undefined, "", 1);
		decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, comp, [message, true], COLLAPSE_SNAPSHOT);
		// The streaming message is the chat's trailing block: its pad keeps the
		// live thinking separated from the tool block above it.
		expect(comp.contentContainer.children).toHaveLength(1);
		expect(isSpacerLike(comp.contentContainer.children[0])).toBe(true);
	});
	it("renders an empty label as one invisible row, proving the gap the collapse removes", () => {
		initTheme("dark", false);
		const native = new AssistantMessageComponent(thinkingThenAnswer(), true, undefined, "", 1);
		expect(native.contentContainer.children).toHaveLength(4);
		expect(isSpacerLike(native.contentContainer.children[0])).toBe(true);
		expect(isTextLike(native.contentContainer.children[1])).toBe(true);
		expect(isSpacerLike(native.contentContainer.children[2])).toBe(true);
		expect(isMarkdownLike(native.contentContainer.children[3])).toBe(true);
		// The empty label Text still renders one full-width line (ANSI-wrapped),
		// so the visible layout is [blank][invisible][blank][answer].
		expect(native.render(40)).toHaveLength(4);
		expect(stripAnsi(native.render(40).join("\n")).split("\n")[1].trim()).toBe("");
	});

	it("drops the invisible label row and its trailing spacer, keeping the shared top padding", () => {
		initTheme("dark", false);
		const comp = new AssistantMessageComponent(thinkingThenAnswer(), true, undefined, "", 1);
		decorateMessageUpdate(
			AssistantMessageComponent.prototype.updateContent,
			comp,
			[thinkingThenAnswer()],
			COLLAPSE_SNAPSHOT,
		);
		expect(comp.contentContainer.children).toHaveLength(2);
		expect(isSpacerLike(comp.contentContainer.children[0])).toBe(true);
		expect(isMarkdownLike(comp.contentContainer.children[1])).toBe(true);
		const lines = comp.render(40);
		expect(lines).toHaveLength(2);
		expect(stripAnsi(lines[0]).trim()).toBe("");
		expect(stripAnsi(lines[1])).toContain("Final answer.");
	});

	it("leaves the layout untouched while the label is visible", () => {
		initTheme("dark", false);
		const comp = new AssistantMessageComponent(thinkingThenAnswer(), true, undefined, "Thinking...", 1);
		decorateMessageUpdate(
			AssistantMessageComponent.prototype.updateContent,
			comp,
			[thinkingThenAnswer()],
			COLLAPSE_SNAPSHOT,
		);
		expect(comp.contentContainer.children).toHaveLength(4);
	});

	it("leaves the layout untouched when collapse is disabled in the snapshot", () => {
		initTheme("dark", false);
		const comp = new AssistantMessageComponent(thinkingThenAnswer(), true, undefined, "", 1);
		decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, comp, [thinkingThenAnswer()], {
			assistantPrefix: "│ ",
			assistantEnabled: true,
			collapseHiddenThinking: false,
		});
		expect(comp.contentContainer.children).toHaveLength(4);
	});

	it("leaves the layout untouched while the thinking block is expanded (hideThinkingBlock off)", () => {
		initTheme("dark", false);
		const comp = new AssistantMessageComponent(thinkingThenAnswer(), false, undefined, "", 1);
		decorateMessageUpdate(
			AssistantMessageComponent.prototype.updateContent,
			comp,
			[thinkingThenAnswer()],
			COLLAPSE_SNAPSHOT,
		);
		expect(comp.contentContainer.children.length).toBeGreaterThan(2);
	});

	it("collapses a finalized thinking-only message to zero lines (no stacking blank gaps)", () => {
		initTheme("dark", false);
		const message = assistantMessage([{ type: "thinking", thinking: "Only thinking here." }]);
		const comp = new AssistantMessageComponent(message, true, undefined, "", 1);
		decorateMessageUpdate(AssistantMessageComponent.prototype.updateContent, comp, [message], COLLAPSE_SNAPSHOT);
		// Fully hidden finalized messages keep no children at all: the native top
		// Spacer(1) would leave one blank line per tool-cycle message, stacking
		// into the large blank gaps between the run's summary rows.
		expect(comp.contentContainer.children).toHaveLength(0);
		expect(comp.render(40)).toHaveLength(0);
	});

	it("installs the certified updateContent patch and collapses through the real probe", () => {
		initTheme("dark", false);
		expect(TRUSTED_NATIVE_FINGERPRINTS["native-assistant-message:updateContent"]).toBeDefined();
		const markers = new Set<string>();
		const report = probePiCompatibility("0.83.0", {
			markers,
			messageSnapshot: COLLAPSE_SNAPSHOT,
		});
		expect(
			report.recordSnapshots.find(
				(record) => record.subtype === "native-assistant-message" && record.method === "updateContent",
			)?.shape,
		).toBe("installed");
		const comp = new AssistantMessageComponent(thinkingThenAnswer(), true, undefined, "", 1);
		expect(comp.contentContainer.children).toHaveLength(2);
		expect(isSpacerLike(comp.contentContainer.children[0])).toBe(true);
		expect(isMarkdownLike(comp.contentContainer.children[1])).toBe(true);
		expect(markers).toContain("native-assistant-message:delegated");
		disposePiCompatibilityProbe(report);
	});

	it("keeps native thinking labels while the automatic presentation adapter is installed", () => {
		initTheme("dark", false);
		const report = probePiCompatibility("0.83.0", {
			config: {
				messages: { enabled: true, assistantPrefix: true, specialBlocks: true, hideThinkingLabel: false },
				tools: { enabled: true, style: "marker", maxCollapsedLines: 0, maxExpandedLines: 0, dimOutput: false },
				preset: "default",
			},
			messageSnapshot: { assistantPrefix: "│ ", assistantEnabled: true, collapseHiddenThinking: false },
		});
		expect(
			report.recordSnapshots.find(
				(record) => record.subtype === "native-assistant-message" && record.method === "updateContent",
			)?.shape,
		).toBe("installed");
		const comp = new AssistantMessageComponent(thinkingThenAnswer(), true);
		expect(comp.render(120).join("\n")).toContain("Thinking...");
		disposePiCompatibilityProbe(report);
	});
});
