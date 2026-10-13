import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../../extension-src/pi-style/domain/config-normalization.js";
import { createCompatibilityCoordinator } from "../../extension-src/pi-style/pi/compatibility-coordinator.js";
import {
	disposePiCompatibilityProbe,
	probePiCompatibility,
	retainPiCompatibilityProbe,
} from "../../extension-src/pi-style/pi/compatibility-probe.js";

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

describe("certified native presentation buffering", () => {
	it("coalesces native rebuilds and renders final delta, invalidation and completion", () => {
		initTheme("dark", false);
		const report = probePiCompatibility("0.85.0", {
			config: normalizeConfig(),
		});
		try {
			expect(
				report.recordSnapshots
					.filter((record) => record.subtype === "native-assistant-message")
					.every((record) => record.shape === "installed"),
			).toBe(true);
			const component = new AssistantMessageComponent(message("initial"));
			const internal = component as unknown as { contentContainer: { clear(): void }; lastMessage: AssistantMessage };
			const rebuild = vi.spyOn(internal.contentContainer, "clear");
			for (let i = 0; i < 1000; i++) component.updateContent(message(`delta ${i}`), true);
			expect(rebuild).not.toHaveBeenCalled();
			expect(internal.lastMessage.content[0]).toMatchObject({ text: "delta 999" });
			expect(component.render(120).join("\n")).toContain("delta 999");
			expect(rebuild).toHaveBeenCalledTimes(1);
			component.updateContent(message("complete"), false);
			expect(component.render(120).join("\n")).toContain("complete");
			component.setOutputPad(3);
			expect(rebuild).toHaveBeenCalledTimes(3);
			component.updateContent(message("pending on disposal"), true);
			disposePiCompatibilityProbe(report);
			expect(component.render(120).join("\n")).toContain("pending on disposal");
		} finally {
			disposePiCompatibilityProbe(report);
		}
	});

	it("installs optimization-only configuration through session authorization", () => {
		initTheme("dark", false);
		const coordinator = createCompatibilityCoordinator();
		coordinator.captureAuthorization(true, true, false, false, false);
		try {
			const config = normalizeConfig({
				messages: {
					assistantPrefix: false,
					hideThinkingLabel: false,
					specialBlocks: false,
					preserveCompactionTranscript: false,
				},
				tools: { enabled: false },
			});
			const report = coordinator.install(config, true);
			expect(report).toBeDefined();
			expect(
				report?.recordSnapshots
					.filter((record) => record.subtype === "native-assistant-message")
					.every((record) => record.shape === "installed"),
			).toBe(true);
			const component = new AssistantMessageComponent(message("initial"));
			component.updateContent(message("next"), true);
			expect(component.render(120).join("\n")).toContain("next");
		} finally {
			coordinator.dispose();
		}
	});

	it("disables buffering and caching when only one retained wrapper can be reclaimed", () => {
		initTheme("dark", false);
		const config = normalizeConfig();
		const first = probePiCompatibility("0.85.0", { config });
		const installedRender = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render");
		if (!installedRender) throw new Error("missing assistant render descriptor");
		let second: ReturnType<typeof probePiCompatibility> | undefined;
		try {
			const component = new AssistantMessageComponent(message("initial"));
			component.render(120); // Seed the finished native cache.
			Object.defineProperty(AssistantMessageComponent.prototype, "render", {
				...installedRender,
				value: function (this: AssistantMessageComponent, width: number) {
					return installedRender.value.call(this, width);
				},
			});
			retainPiCompatibilityProbe(first);
			second = probePiCompatibility("0.85.0", { config });
			// Old renderer survives under the foreign wrapper, updater is replaced.
			component.updateContent(message("fresh"), false);
			expect(component.render(120).join("\n")).toContain("fresh");
			component.updateContent(message("streaming after conflict"), true);
			expect(component.render(120).join("\n")).toContain("streaming after conflict");
		} finally {
			Object.defineProperty(AssistantMessageComponent.prototype, "render", installedRender);
			disposePiCompatibilityProbe(first);
			if (second) disposePiCompatibilityProbe(second);
		}
	});

	it("benchmarks synthetic native streaming rebuilds and finished-render cache", () => {
		initTheme("dark", false);
		const measure = (enabled: boolean) => {
			const report = probePiCompatibility("0.85.0", {
				config: normalizeConfig(),
				assistantPresentation: enabled,
			});
			try {
				const component = new AssistantMessageComponent(message("initial"));
				const internal = component as unknown as {
					contentContainer: { clear(): void; render(width: number): string[] };
				};
				const rebuild = vi.spyOn(internal.contentContainer, "clear");
				const lines = Array.from({ length: 200 }, (_, i) => `line ${i} **markdown**`).join("\n");
				const start = performance.now();
				for (let i = 0; i < 100; i++) component.updateContent(message(`${lines}\ndelta ${i}`), true);
				component.render(120);
				const streamingMs = performance.now() - start;
				const rebuilds = rebuild.mock.calls.length;
				component.updateContent(message(lines), false);
				const nativeRender = vi.spyOn(internal.contentContainer, "render");
				const finishedStart = performance.now();
				for (let i = 0; i < 20; i++) component.render(120);
				return {
					streamingMs,
					rebuilds,
					finishedMs: performance.now() - finishedStart,
					finishedNativeRenders: nativeRender.mock.calls.length,
				};
			} finally {
				disposePiCompatibilityProbe(report);
			}
		};
		const baseline = measure(false);
		const optimized = measure(true);
		console.info(
			JSON.stringify({
				benchmark: "synthetic-native-100-deltas-200-lines-and-20-finished-renders",
				baseline,
				optimized,
			}),
		);
		expect(baseline.rebuilds).toBe(100);
		expect(optimized.rebuilds).toBe(1);
		expect(baseline.finishedNativeRenders).toBe(20);
		expect(optimized.finishedNativeRenders).toBe(1);
	});

	it("leaves unauthorized native updates immediate", () => {
		initTheme("dark", false);
		const report = probePiCompatibility("0.85.0", { config: normalizeConfig(), assistantPresentation: false });
		try {
			const component = new AssistantMessageComponent(message("initial"));
			const internal = component as unknown as { contentContainer: { clear(): void } };
			const rebuild = vi.spyOn(internal.contentContainer, "clear");
			for (let i = 0; i < 10; i++) component.updateContent(message(String(i)), true);
			expect(rebuild).toHaveBeenCalledTimes(10);
		} finally {
			disposePiCompatibilityProbe(report);
		}
	});
});
