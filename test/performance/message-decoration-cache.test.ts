import { afterEach, describe, expect, it } from "vitest";
import {
	__getMessageDecorationTestState,
	__resetMessageDecorationTestState,
	decorateMessageRender,
} from "../../extension-src/pi-style/features/messages/index.js";

const SNAPSHOT = {
	assistantPrefix: "│ ",
	assistantEnabled: true,
	collapseHiddenThinking: false,
} as const;

afterEach(() => {
	__resetMessageDecorationTestState();
});

function finalizedTranscript(lineCount: number): string[] {
	return Array.from({ length: lineCount }, (_, index) => {
		if (index === 0) return "  intro";
		if (index === lineCount - 1) return `final line ${index}`;
		return `line ${index.toString().padStart(3, "0")} content ${"x".repeat((index % 7) + 1)}`;
	});
}

describe("message decoration cache bounds", () => {
	it.each([100, 200, 400])("reuses finalized %i-line transcripts without extra decoration passes", (lineCount) => {
		const instance = {};
		const nativeLines = finalizedTranscript(lineCount);
		const render = () => nativeLines;

		for (let iteration = 0; iteration < 6; iteration++) {
			const output = decorateMessageRender(render, instance, [120], SNAPSHOT) as string[];
			expect(output).toHaveLength(lineCount);
			expect(output[0]).toContain("│ ");
		}

		const state = __getMessageDecorationTestState();
		expect(state.decoratePasses).toBe(1);
		expect(state.cacheHits).toBe(5);
		expect(state.cacheMisses).toBe(1);
		expect(state.lineCacheMisses).toBeLessThanOrEqual(lineCount + 2);
	});

	it("does not cache a render while the assistant component is streaming", () => {
		const instance = { isStreaming: true };
		const nativeLines = finalizedTranscript(12);
		const render = () => nativeLines;

		for (let iteration = 0; iteration < 3; iteration++) {
			decorateMessageRender(render, instance, [120], SNAPSHOT);
		}

		expect(__getMessageDecorationTestState().cacheHits).toBe(0);
	});

	it("keeps separate width entries without reprocessing on repeated revisits", () => {
		const instance = {};
		const nativeLines = finalizedTranscript(240);
		const render = () => nativeLines;

		for (const width of [100, 132, 100, 132, 100, 132]) {
			decorateMessageRender(render, instance, [width], SNAPSHOT);
		}

		const state = __getMessageDecorationTestState();
		expect(state.decoratePasses).toBe(2);
		expect(state.cacheHits).toBe(4);
		expect(state.cacheMisses).toBe(2);
	});
});
