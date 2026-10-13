import { describe, expect, it } from "vitest";
import { RenderScheduler } from "../../extension-src/pi-style/app/render-scheduler.js";
import {
	__getMessageDecorationTestState,
	__resetMessageDecorationTestState,
	decorateMessageRender,
} from "../../extension-src/pi-style/features/messages/index.js";

const snapshot = { assistantPrefix: "│ ", assistantEnabled: true, collapseHiddenThinking: false } as const;

describe("synthetic message rendering benchmark", () => {
	it("profiles repeated finished and streaming transcript decoration", () => {
		const lines = Array.from({ length: 400 }, (_, i) => `message line ${i} ${"x".repeat(i % 30)}`);
		const finished = {};
		const streaming = { isStreaming: true };
		const measure = (instance: object, count: number) => {
			const start = performance.now();
			for (let i = 0; i < count; i++) decorateMessageRender(() => lines, instance, [120], snapshot);
			return performance.now() - start;
		};
		const finishedMs = measure(finished, 20);
		const finishedStats = __getMessageDecorationTestState();
		__resetMessageDecorationTestState();
		const streamingMs = measure(streaming, 20);
		const streamingStats = __getMessageDecorationTestState();
		console.info(
			JSON.stringify({
				benchmark: "message-decoration-400-lines-20-passes",
				finishedMs,
				streamingMs,
				finishedStats,
				streamingStats,
			}),
		);
		expect(finishedStats.cacheHits).toBe(19);
		expect(streamingStats.cacheHits).toBe(0);
	});

	it("profiles scheduler coalescing and confirms one render for a burst", async () => {
		let renders = 0;
		const scheduler = new RenderScheduler({ requestRender: () => renders++ }, 1);
		const start = performance.now();
		for (let i = 0; i < 1000; i++) scheduler.schedule("coalesced");
		await new Promise((resolve) => setTimeout(resolve, 20));
		console.info(
			JSON.stringify({ benchmark: "scheduler-1000-coalesced", elapsedMs: performance.now() - start, renders }),
		);
		expect(renders).toBe(1);
		scheduler.cancel();
	});
});
