import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "../../extension-src/pi-style/app/render-scheduler.js";
import piStyleExtension, { __setCompatibilityTestHooks } from "../../extension-src/pi-style/pi/index.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

describe("scheduler timers and fake-host runtime resources", () => {
	afterEach(() => vi.useRealTimers());
	it("coalesces update bursts and leaves no timers after disposal", async () => {
		vi.useFakeTimers();
		let renders = 0;
		const scheduler = new RenderScheduler({ requestRender: () => renders++ }, 1);
		for (let index = 0; index < 1000; index++) scheduler.schedule("coalesced");
		expect(renders).toBe(0);
		await vi.advanceTimersByTimeAsync(16);
		expect(renders).toBe(1);
		scheduler.cancel();
		scheduler.schedule("deferred");
		await vi.runAllTimersAsync();
		expect(renders).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("immediate input repaint supersedes pending presentation timers but preserves retries", async () => {
		vi.useFakeTimers();
		let renders = 0;
		const scheduler = new RenderScheduler({ requestRender: () => renders++ }, 1);
		scheduler.schedule("coalesced");
		scheduler.schedule("deferred");
		scheduler.schedule("delayed-retry");
		scheduler.schedule("immediate");
		scheduler.schedule("coalesced");
		await vi.advanceTimersByTimeAsync(0);
		expect(renders).toBe(1);
		await vi.advanceTimersByTimeAsync(50);
		expect(renders).toBe(1);
		await vi.advanceTimersByTimeAsync(50);
		expect(renders).toBe(2);
		scheduler.cancel();
	});

	it("repeated fake-host sessions restore widgets, handlers, factories, and terminal subscriptions", async () => {
		// The assertion scope is fake-host resources; Git cache and late completion
		// behavior are covered by the dedicated provider tests.
		vi.useRealTimers();
		const host = new FakePiHost({
			gitRunner: {
				run: async (_args, _cwd, _timeout, signal) => {
					if (signal?.aborted) return { stdout: "", stderr: "aborted", code: 1 };
					return { stdout: "## main\\n", stderr: "", code: 0 };
				},
			},
		});
		const resetHooks = __setCompatibilityTestHooks({ gitRunner: host.gitRunner });
		try {
			piStyleExtension(host.extensionApi);
			const initialHandlers = [...host.handlers.entries()].map(([event, handlers]) => [event, handlers.length]);
			for (let cycle = 0; cycle < 10; cycle++) {
				await host.sessionStart();
				await host.sessionShutdown();
				expect(host.widgets.size).toBe(0);
				expect(host.componentFactories.size).toBe(0);
				expect([...host.registeredMessageRenderers.keys()]).toEqual(["teammate-notification", "teammate-message"]);
				// ADR 0008: the single load-time image-preview entry renderer stays
				// registered (public API, no unregister; display-only mapping).
				expect([...host.registeredEntryRenderers.keys()]).toEqual(["pi-style-image-preview"]);
			}
			expect([...host.handlers.entries()].map(([event, handlers]) => [event, handlers.length])).toEqual(
				initialHandlers,
			);
			expect(host.terminalInputSubscriptions).toBe(0);
		} finally {
			resetHooks();
		}
	});
});
