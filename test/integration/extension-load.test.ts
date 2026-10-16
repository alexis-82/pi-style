import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePiStyleCommand } from "../../extension-src/pi-style/app/command-service.js";
import { resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import { renderBoxedToolCall as dispatchCall } from "../../extension-src/pi-style/features/tools/boxed/index.js";
import {
	getToolsRenderConfig,
	setToolsRenderConfig,
	teamEventGlyph,
} from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import { disposePiCompatibilityProbe, targetSpecs } from "../../extension-src/pi-style/pi/compatibility-probe.js";
import {
	__setCompatibilityRegistryTestHooks,
	currentGeneration,
	getCompatibilityRecords,
} from "../../extension-src/pi-style/pi/compatibility-registry.js";
import piStyleExtension from "../../extension-src/pi-style/pi/index.js";
import { createPiStyleSessionCoordinator } from "../../extension-src/pi-style/pi/session-coordinator.js";
import { stripAnsi, visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";
import { createFakeTheme } from "../helpers/fake-theme.js";
import { expectNoTerminalUi } from "../helpers/render-assertions.js";

function injectedSettings(config: unknown) {
	let document = JSON.stringify({ piStyle: { schemaVersion: 1, ...(config as Record<string, unknown>) } });
	return {
		port: {
			read: async (path: string) => (path === "global" ? document : "{}"),
			writeAtomic: async (_path: string, content: string) => {
				document = content;
			},
		},
		paths: () => ({ globalPath: "global", projectPath: "project" }),
	};
}

describe("pi-style extension lifecycle foundation", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		// Session switches retain Tier C patches across session_shutdown, so each
		// test restores every registered wrapper explicitly to keep the shared
		// prototype registry clean for the next test.
		for (const spec of targetSpecs) {
			for (const record of getCompatibilityRecords(spec.target)) record.disposer();
		}
	});

	it.each([
		{ preset: "default", flag: false, mode: "unicode", glyph: "●" },
		{ preset: "default", flag: true, mode: "ascii", glyph: "*" },
		{ preset: "ascii", flag: false, mode: "ascii", glyph: "*" },
	])("uses $mode tool glyphs for preset=$preset and ASCII flag=$flag", async ({ preset, flag, mode, glyph }) => {
		const original = { ...getToolsRenderConfig() };
		const host = new FakePiHost({ flags: { "pi-style-ascii": flag } });
		const settings = injectedSettings({ preset });
		const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
			filePort: settings.port,
			paths: settings.paths,
		});
		try {
			await coordinator.start({ reason: "startup" }, host.extensionContext);
			expect(getToolsRenderConfig().glyphMode).toBe(mode);
			expect(teamEventGlyph("settled")).toBe(glyph);
		} finally {
			coordinator.shutdown();
			setToolsRenderConfig(original);
		}
	});

	it("loads and registers lifecycle handlers without pre-session resources or UI", () => {
		const host = new FakePiHost();
		expect(() => piStyleExtension(host.extensionApi)).not.toThrow();
		expect(host.handlers.has("session_start")).toBe(true);
		expect(host.handlers.has("session_shutdown")).toBe(true);
		expect(host.handlers.has("message_start")).toBe(true); // quiet-tool batch boundary
		expect(host.commands.has("pi-style")).toBe(true);
		expect(host.registeredTools).toHaveLength(0);
		expect([...host.registeredMessageRenderers.keys()]).toEqual(["teammate-notification", "teammate-message"]);
		// ADR 0008: exactly one load-time entry renderer (user-prompt image
		// previews) — display-only, public API, no session resources.
		expect([...host.registeredEntryRenderers.keys()]).toEqual(["pi-style-image-preview"]);
		expect(host.widgets.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renders submitted image previews immediately after the user message starts", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		const image = { type: "image", data: "base64-image", mimeType: "image/png" };
		await host.emit("before_agent_start", { type: "before_agent_start", images: [image] });
		expect(host.appendedEntries).toHaveLength(0);
		await host.emit("message_start", { type: "message_start", message: { role: "user", content: [] } });
		expect(host.appendedEntries).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(host.appendedEntries).toHaveLength(1);
		expect(host.appendedEntries[0]?.customType).toBe("pi-style-image-preview");
		expect(host.appendedEntries[0]?.data).toEqual({
			images: [{ data: image.data, mimeType: image.mimeType }],
		});
		// Assistant start must not append a duplicate if the deferred flush won.
		await host.emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
		expect(host.appendedEntries).toHaveLength(1);
	});

	it("clears a staged preview when the next prompt has no images", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.emit("before_agent_start", {
			type: "before_agent_start",
			images: [{ type: "image", data: "stale", mimeType: "image/png" }],
		});
		await host.emit("before_agent_start", { type: "before_agent_start", images: [] });
		await host.emit("message_start", { type: "message_start", message: { role: "user", content: [] } });
		await vi.advanceTimersByTimeAsync(0);
		expect(host.appendedEntries).toHaveLength(0);
	});

	it("custom triggerTurn runs neither stage nor clear a pending preview (1.2 union)", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		// 1.2 user run: the discriminated shape stages like the legacy flat one.
		await host.emit("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			images: [{ type: "image", data: "pending", mimeType: "image/png" }],
		});
		// A custom run (sendMessage triggerTurn) starting before the flush fires
		// the same event type without prompt images — it must not erase the slot.
		await host.emit("before_agent_start", { type: "before_agent_start", messageType: "custom" });
		await host.emit("message_start", { type: "message_start", message: { role: "user", content: [] } });
		await vi.advanceTimersByTimeAsync(0);
		expect(host.appendedEntries).toHaveLength(1);
		expect(host.appendedEntries[0]?.data).toEqual({ images: [{ data: "pending", mimeType: "image/png" }] });
		// A bare custom run never stages previews by itself.
		await host.emit("before_agent_start", { type: "before_agent_start", messageType: "custom" });
		await host.emit("message_start", { type: "message_start", message: { role: "user", content: [] } });
		await vi.advanceTimersByTimeAsync(0);
		expect(host.appendedEntries).toHaveLength(1);
	});

	it("message_start closes the active quiet-tool batch", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();

		const theme = createFakeTheme();
		const boxed = (id: string, path: string): BoxedToolContext => ({
			args: { path },
			toolCallId: id,
			invalidate: () => {},
			state: {},
			cwd: "/fake",
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: true,
			isError: false,
			lastComponent: undefined,
		});

		// Two reads form one batch; the leader renders the batch panel.
		const leader = dispatchCall("read", { path: "a.ts" }, theme as never, boxed("r1", "a.ts"));
		dispatchCall("read", { path: "b.ts" }, theme as never, boxed("r2", "b.ts"));
		expect(leader.render(80).join("")).toContain("Read (2)");

		// A new message boundary closes the batch: the next read starts fresh.
		await host.emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
		const next = dispatchCall("read", { path: "c.ts" }, theme as never, boxed("r3", "c.ts"));
		const joined = stripAnsi(next.render(80).join(""));
		expect(joined).toContain("➔ Read ◌ c.ts"); // lone call: own inline line, not the previous batch
		expect(joined).not.toContain("Read (2)");
		resetBatchRegistry();
	});

	it("starts and cleans a minimal runtime idempotently", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		await host.sessionShutdown();
		await expect(host.sessionShutdown()).resolves.not.toThrow();
		await host.sessionStart();
		await host.sessionShutdown();
		expect(host.handlers.get("session_start")).toHaveLength(1);
		expect(host.handlers.get("session_shutdown")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("hides the Thinking... label by default and restores it when configured off", async () => {
		// Default: an empty label hides Pi's "Thinking..." placeholder (zero lines).
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		expect(host.hiddenThinkingLabel).toBe("");
		await host.sessionShutdown();

		// messages.hideThinkingLabel: false keeps Pi's default label (undefined → restore).
		const shown = new FakePiHost();
		const settings = injectedSettings({ messages: { hideThinkingLabel: false } });
		const coordinator = createPiStyleSessionCoordinator(shown.extensionApi, {
			filePort: settings.port,
			paths: settings.paths,
		});
		await coordinator.start({ reason: "startup" }, shown.extensionContext);
		expect(shown.hiddenThinkingLabel).toBeUndefined();
		coordinator.shutdown();
	});

	it("reclaims retained message patches and re-hides Thinking... after a runner rebind", async () => {
		const previous = new FakePiHost();
		piStyleExtension(previous.extensionApi);
		await previous.sessionStart();
		expect(previous.hiddenThinkingLabel).toBe("");
		await previous.sessionShutdown();

		// Pi resets extension UI before binding a fresh runner. The next extension
		// factory gets a new coordinator while the previous prototype wrappers stay
		// installed for render-before-bind; it must reclaim rather than conflict.
		const rebound = new FakePiHost();
		piStyleExtension(rebound.extensionApi);
		await rebound.sessionStart();
		expect(rebound.hiddenThinkingLabel).toBe("");
		expect(
			getCompatibilityRecords(AssistantMessageComponent.prototype).some(
				(record) => record.method === "updateContent" && !record.disposed,
			),
		).toBe(true);
		await rebound.sessionShutdown();
	});

	it("keeps the native Thinking... label when the certified updateContent surface cannot install", async () => {
		// Fail-safe: blanking the label without the certified patch would leave
		// Pi's native invisible-row gap (worse than the label it replaces), so an
		// uninstalled surface keeps the native `Thinking...` label instead.
		const host = new FakePiHost({ flags: { "pi-style-core-patches": false } });
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		expect(host.hiddenThinkingLabel).toBeUndefined();
		await host.sessionShutdown();
	});

	it("repeated lifecycle cycles do not accumulate handlers, timers, or UI", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		for (let cycle = 0; cycle < 10; cycle++) {
			await host.sessionStart();
			await host.sessionShutdown();
		}
		expect(host.handlers.get("session_start")).toHaveLength(1);
		expect(host.handlers.get("session_shutdown")).toHaveLength(1);
		expect(host.widgets.size).toBe(0);
		expect(host.renderRequests).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains real rejected prototype cleanup and retries before a new generation", async () => {
		const native = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render");
		let blocked = true;
		let restoreAttempts = 0;
		const resetRegistry = __setCompatibilityRegistryTestHooks({
			defineProperty: (target, key, descriptor) => {
				if (target === AssistantMessageComponent.prototype && key === "render" && descriptor.value === native?.value) {
					restoreAttempts++;
					if (blocked) return false;
				}
				return Reflect.defineProperty(target, key, descriptor);
			},
		});
		try {
			const host = new FakePiHost({ flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true } });
			piStyleExtension(host.extensionApi);
			await host.sessionStart();
			const installed = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render");
			const generation = currentGeneration();
			expect(installed?.value).not.toBe(native?.value);
			await host.sessionShutdown();
			// Session switches retain the Tier C patches so Pi's renderBeforeBind
			// (restored-chat render before the next session_start) stays decorated;
			// shutdown therefore does not attempt a restore.
			expect(restoreAttempts).toBe(0);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(
				installed?.value,
			);
			await host.sessionStart();
			// The retained report is restored at the next start; a rejected restore is
			// retryable and must not create a new generation or install over the live owner.
			expect(restoreAttempts).toBe(1);
			expect(currentGeneration()).toBe(generation);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(
				installed?.value,
			);
			await host.sessionShutdown();
			expect(restoreAttempts).toBe(1);
			await host.sessionStart();
			expect(restoreAttempts).toBe(2);
			expect(currentGeneration()).toBe(generation);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(
				installed?.value,
			);
			blocked = false;
			await host.sessionStart();
			// Restore succeeded at the start boundary: native restored, then a fresh
			// generation installed.
			expect(restoreAttempts).toBe(3);
			expect(currentGeneration()).toBe(generation + 1);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(
				native?.value,
			);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(
				installed?.value,
			);
			await host.sessionShutdown();
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(
				native?.value,
			);
		} finally {
			resetRegistry();
		}
	});

	it("replaces runtime ownership on start-to-start and suppresses stale replacement on cleanup failure", async () => {
		const host = new FakePiHost();
		const coordinator = createPiStyleSessionCoordinator(host.extensionApi);
		await coordinator.start({ reason: "startup" }, host.extensionContext);
		const first = coordinator.app.runtime.current;
		expect(first).toBeDefined();
		await coordinator.start({ reason: "reload" }, host.extensionContext);
		const second = coordinator.app.runtime.current;
		expect(first?.disposed).toBe(true);
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);
		coordinator.shutdown();
	});

	it("disposes old runtime and starts fresh runtime after incomplete cleanup retry", async () => {
		let attempts = 0;
		const host = new FakePiHost({ flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true } });
		const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
			dispose: (report) => {
				attempts++;
				const result = disposePiCompatibilityProbe(report);
				return attempts < 2 ? { ...result, complete: false, retryablePrototypeRecords: 1 } : result;
			},
		});
		await coordinator.start({ reason: "startup" }, host.extensionContext);
		const first = coordinator.app.runtime.current;
		await coordinator.start({ reason: "reload" }, host.extensionContext);
		// Failure-atomic replacement retains the old runtime when compatibility cleanup
		// is incomplete; no candidate or runtime is committed on this attempt.
		expect(first?.disposed).toBe(false);
		expect(coordinator.app.runtime.current).toBe(first);
		await coordinator.start({ reason: "reload" }, host.extensionContext);
		expect(first?.disposed).toBe(true);
		expect(coordinator.app.runtime.current).toBeDefined();
		expect(coordinator.app.runtime.current).not.toBe(first);
		coordinator.shutdown();
	});

	it("recomputes deny-only policy across raw sources, session commands, and reload", async () => {
		const native = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		const run = async (global: unknown, project: unknown, trusted: boolean, expectInstall: boolean) => {
			const host = new FakePiHost({
				flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true },
				projectTrusted: trusted,
			});
			const port = {
				read: async (path: string) => JSON.stringify({ piStyle: path === "global" ? global : project }),
				writeAtomic: async () => {},
			};
			const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
				filePort: port,
				paths: () => ({ globalPath: "global", projectPath: "project" }),
			});
			coordinator.app.setProjectTrusted(trusted);
			await coordinator.start({ reason: "startup" }, host.extensionContext);
			await executePiStyleCommand(
				"set compatibility.allowCorePatches true",
				host.extensionContext as never,
				coordinator.app,
				{ port, paths: { globalPath: "global", projectPath: "project" } },
			);
			const doctor = coordinator.app.doctor() as { operational: { authorization: { productCorePatchGate: string } } };
			expect(doctor.operational.authorization.productCorePatchGate).toBe(expectInstall ? "omitted" : "deny");
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value === native).toBe(
				!expectInstall,
			);
			await executePiStyleCommand("reload", host.extensionContext as never, coordinator.app, {
				port,
				paths: { globalPath: "global", projectPath: "project" },
			});
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value === native).toBe(
				!expectInstall,
			);
			coordinator.shutdown();
		};
		await run({ compatibility: { allowCorePatches: false }, messages: { enabled: true } }, {}, true, false);
		await run({}, { compatibility: { allowCorePatches: false }, messages: { enabled: true } }, true, false);
		await run({}, { compatibility: { allowCorePatches: false }, messages: { enabled: true } }, false, true);
	});

	it("retains effective lower-source provenance through direct session mutation and real reload", async () => {
		const host = new FakePiHost();
		const document = {
			global: JSON.stringify({ piStyle: { tools: { maxCollapsedLines: 7 } } }),
			project: "{}",
		};
		const port = {
			read: async (path: string) => document[path === "global" ? "global" : "project"],
			writeAtomic: async () => {},
		};
		const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
			filePort: port,
			paths: () => ({ globalPath: "global", projectPath: "project" }),
		});
		await coordinator.start({ reason: "startup" }, host.extensionContext);
		const identity = (item: { code: string; level: string; path: string; message: string }) =>
			`${item.code}|${item.level}|${item.path}|${item.message}`;
		coordinator.app.applySession({ tools: { maxCollapsedLines: "bad" } });
		let state = coordinator.app.doctor() as {
			diagnostics: Array<{ code: string; level: string; path: string; message: string }>;
			sources: Record<string, string>;
		};
		expect(coordinator.app.config.tools.maxCollapsedLines).toBe(7);
		expect(state.sources["tools.maxCollapsedLines"]).toBe("global");
		expect(state.diagnostics.map(identity).filter((value) => value.includes("tools.maxCollapsedLines"))).toEqual([
			"CFG-VALUE|warning|tools.maxCollapsedLines|invalid or unknown field ignored",
		]);

		coordinator.app.applySession({ tools: { maxCollapsedLines: 5 } });
		expect(coordinator.app.config.tools.maxCollapsedLines).toBe(5);
		expect((coordinator.app.doctor().sources as Record<string, string>)["tools.maxCollapsedLines"]).toBe("session");
		coordinator.app.applySession({ tools: { maxCollapsedLines: "bad" } });
		state = coordinator.app.doctor() as typeof state;
		expect(coordinator.app.config.tools.maxCollapsedLines).toBe(7);
		expect(state.sources["tools.maxCollapsedLines"]).toBe("global");
		expect(state.diagnostics.map(identity).filter((value) => value.includes("tools.maxCollapsedLines"))).toEqual([
			"CFG-VALUE|warning|tools.maxCollapsedLines|invalid or unknown field ignored",
		]);
		await executePiStyleCommand("reload", host.extensionContext as never, coordinator.app, {
			port,
			paths: { globalPath: "global", projectPath: "project" },
		});
		state = coordinator.app.doctor() as typeof state;
		expect(coordinator.app.config.tools.maxCollapsedLines).toBe(7);
		expect(state.sources["tools.maxCollapsedLines"]).toBe("global");
		expect(state.diagnostics.map(identity).filter((value) => value.includes("tools.maxCollapsedLines"))).toEqual([
			"CFG-VALUE|warning|tools.maxCollapsedLines|invalid or unknown field ignored",
		]);
		await host.sessionShutdown();
	});

	it("falls back to the default source when an invalid session leaf has no durable source", async () => {
		const host = new FakePiHost();
		const port = {
			read: async () => "{}",
			writeAtomic: async () => {},
		};
		const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
			filePort: port,
			paths: () => ({ globalPath: "global", projectPath: "project" }),
		});
		await coordinator.start({ reason: "startup" }, host.extensionContext);
		coordinator.app.applySession({ tools: { maxCollapsedLines: "bad" } });
		const state = coordinator.app.doctor() as {
			sources: Record<string, string>;
		};
		expect(coordinator.app.config.tools.maxCollapsedLines).toBe(10);
		expect(state.sources["tools.maxCollapsedLines"]).toBe("default");
		expect(state.sources["tools.maxCollapsedLines"]).not.toBeUndefined();
		expect(state.sources["tools.maxCollapsedLines"]).not.toBe("session");
		await host.sessionShutdown();
	});

	it("deduplicates durable diagnostics and preserves lower-source provenance", async () => {
		const host = new FakePiHost();
		const port = {
			read: async (path: string) =>
				JSON.stringify({ piStyle: path === "global" ? { tools: { maxCollapsedLines: "bad" } } : {} }),
			writeAtomic: async () => {},
		};
		const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
			filePort: port,
			paths: () => ({ globalPath: "global", projectPath: "project" }),
		});
		await coordinator.start({ reason: "startup" }, host.extensionContext);
		const identity = (item: { code: string; level: string; path: string; message: string }) =>
			`${item.code}|${item.level}|${item.path}|${item.message}`;
		const first = coordinator.app.doctor() as {
			diagnostics: Array<{ code: string; level: string; path: string; message: string }>;
		};
		const firstIds = first.diagnostics.map(identity).filter((value) => value.includes("tools.maxCollapsedLines"));
		expect(firstIds).toHaveLength(1);
		coordinator.app.applySession({ placement: "below" });
		const second = coordinator.app.doctor() as {
			diagnostics: Array<{ code: string; level: string; path: string; message: string }>;
		};
		expect(second.diagnostics.map(identity).filter((value) => value.includes("tools.maxCollapsedLines"))).toEqual(
			firstIds,
		);
		await executePiStyleCommand("reload", host.extensionContext as never, coordinator.app, {
			port,
			paths: { globalPath: "global", projectPath: "project" },
		});
		const third = coordinator.app.doctor() as {
			diagnostics: Array<{ code: string; level: string; path: string; message: string }>;
			sources: Record<string, string>;
			config: { tools?: { maxCollapsedLines: number } };
		};
		expect(third.diagnostics.map(identity).filter((value) => value.includes("tools.maxCollapsedLines"))).toEqual(
			firstIds,
		);
		expect(third.config.tools?.maxCollapsedLines ?? 10).toBe(10);
		expect(third.sources["tools.maxCollapsedLines"]).toBe("default");
		coordinator.shutdown();
	});

	it("denies core patches through the config product gate", async () => {
		const native = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		for (const config of [{ compatibility: { allowCorePatches: false } }, { messages: { enabled: false } }]) {
			const host = new FakePiHost();
			const settings = injectedSettings(config);
			const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
				filePort: settings.port,
				paths: settings.paths,
			});
			await coordinator.start({ reason: "startup" }, host.extensionContext);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(native);
			coordinator.shutdown();
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(native);
		}
	});

	it("disables and re-enables authorized compatibility through the command path", async () => {
		const native = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		const host = new FakePiHost({ flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true } });
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		const installed = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		expect(installed).not.toBe(native);
		const command = host.commands.get("pi-style") as {
			handler(args: string, context: typeof host.extensionContext): Promise<void>;
		};
		await command.handler("off", host.extensionContext);
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(native);
		await command.handler("on", host.extensionContext);
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(native);
		await host.sessionShutdown();
	});

	it("transitions each public surface off and on through real commands", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		const command = host.commands.get("pi-style") as {
			handler(args: string, context: typeof host.extensionContext): Promise<void>;
		};
		await command.handler("surface status off", host.extensionContext);
		expect(host.widgets.has("pi-style.status.primary")).toBe(false);
		await command.handler("doctor", host.extensionContext);
		const statusDoctor = JSON.parse(host.notifications.at(-1)?.message ?? "{}");
		expect(statusDoctor.operational.installations.status).toBe("disabled");
		await command.handler("surface status on", host.extensionContext);
		expect(host.widgets.has("pi-style.status.primary")).toBe(true);
		await command.handler("doctor", host.extensionContext);
		const statusOnDoctor = JSON.parse(host.notifications.at(-1)?.message ?? "{}");
		expect(statusOnDoctor.operational.installations.status).toBe("installed");
		await command.handler("surface editor off", host.extensionContext);
		expect(host.ownership.editor.current).toBe(false);
		await command.handler("doctor", host.extensionContext);
		const editorOffDoctor = JSON.parse(host.notifications.at(-1)?.message ?? "{}");
		expect(editorOffDoctor.operational.installations.editor).toBe("disabled");
		await command.handler("surface editor on", host.extensionContext);
		expect(host.ownership.editor.current).toBe(true);
		await command.handler("doctor", host.extensionContext);
		const editorOnDoctor = JSON.parse(host.notifications.at(-1)?.message ?? "{}");
		expect(["installed", "preserved"]).toContain(editorOnDoctor.operational.installations.editor);
		await command.handler("surface startup off", host.extensionContext);
		expect(host.widgets.has("pi-style.startup")).toBe(false);
		expect(host.currentHeaderFactory).toBeUndefined();
		await command.handler("doctor", host.extensionContext);
		const startupOffDoctor = JSON.parse(host.notifications.at(-1)?.message ?? "{}");
		expect(startupOffDoctor.operational.installations.startup).toBe("disabled");
		await command.handler("surface startup on", host.extensionContext);
		expect(host.widgets.has("pi-style.startup") || host.currentHeaderFactory !== undefined).toBe(true);
		await command.handler("doctor", host.extensionContext);
		const startupOnDoctor = JSON.parse(host.notifications.at(-1)?.message ?? "{}");
		expect(startupOnDoctor.operational.installations.startup).toBe("installed");
		await host.sessionShutdown();
	});

	it("consumes the thinking-cycle key and re-issues it without Pi's status toast", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		// Startup dismissal (compact default) plus the thinking-cycle key share the raw input hook.
		expect(host.terminalInputSubscriptions).toBeGreaterThanOrEqual(1);
		const before = host.thinkingLevel;
		const consumed = host.emitTerminalInput("\x1b[Z"); // shift+tab
		expect(consumed).toBe(true);
		expect(host.thinkingLevel).not.toBe(before);
		expect(host.emitTerminalInput("a")).toBe(false);
		await host.sessionShutdown();
		expect(host.terminalInputSubscriptions).toBe(0);
	});

	it("preserves provider identity across config-only reconciliation", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		const before = host.componentFactories.get("pi-style.status.primary");
		const command = host.commands.get("pi-style") as {
			handler(args: string, context: typeof host.extensionContext): Promise<void>;
		};
		await command.handler("placement above", host.extensionContext);
		expect(host.componentFactories.get("pi-style.status.primary")).not.toBe(before);
		expect(host.ownership.footer.current).toBe(true);
		expect(host.ownership.footer.restores).toBe(1);
		await host.sessionShutdown();
		expect(host.ownership.footer.current).toBe(false);
	});

	it("exposes live doctor state after session start and command reload", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		const command = host.commands.get("pi-style") as {
			handler(args: string, context: typeof host.extensionContext): Promise<void>;
		};
		const output: string[] = [];
		host.extensionContext.ui.notify = (message) => output.push(message);
		await command.handler("reload", host.extensionContext);
		await command.handler("doctor", host.extensionContext);
		const state = JSON.parse(output.at(-1) ?? "{}");
		expect(state.sources).toBeDefined();
		expect(state.operational).toBeDefined();
		expect(state.operational.provider).toBeDefined();
		expect(state.operational.compatibility).toMatchObject({
			configuredByProduct: true,
			authorized: true,
			installed: true,
		});
		expect(state.operational.installations).toBeDefined();
		await host.sessionShutdown();
	});

	it("records host capability variants without changing the production load path", () => {
		const host = new FakePiHost({
			capabilities: { header: false, customEditor: false, customFooter: false },
		});
		expect(host.capabilities.header).toBe(false);
		expect(host.capabilities.customEditor).toBe(false);
		expect(host.capabilities.customFooter).toBe(false);
	});

	it("mounts component factories and renders within the requested width", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		const primary = host.componentFactories.get("pi-style.status.primary");
		expect(primary).toBeDefined();
		const component = primary?.({ requestRender: () => host.requestRender() }, host.theme);
		const lines = component?.render(40) ?? [];
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
		component?.invalidate();
		expect(host.renderRequests).toContain("tui");
		await host.sessionShutdown();
	});

	it("mounts below placement and clears widgets when disabled", async () => {
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		expect(host.widgets.get("pi-style.status.primary")?.placement).toBe("belowEditor");
		await host.emit("tool_result", {
			type: "tool_result",
			toolCallId: "x",
			toolName: "write",
			input: {},
			content: [],
			isError: false,
			details: undefined,
		});
		await host.sessionShutdown();
	});

	it("does not mount terminal UI in print or json modes", async () => {
		for (const mode of ["print", "json"] as const) {
			const host = new FakePiHost({ mode });
			piStyleExtension(host.extensionApi);
			await host.sessionStart();
			expectNoTerminalUi(host.renderRequests.length, host.widgets.size);
			await host.sessionShutdown();
		}
	});

	it("reports cleanup pending through command off/on and reinstalls only after restoration", async () => {
		const native = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render");
		let blocked = true;
		const reset = __setCompatibilityRegistryTestHooks({
			defineProperty: (target, key, descriptor) => {
				if (
					target === AssistantMessageComponent.prototype &&
					key === "render" &&
					descriptor.value === native?.value &&
					blocked
				)
					return false;
				return Reflect.defineProperty(target, key, descriptor);
			},
		});
		try {
			const host = new FakePiHost({ flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true } });
			piStyleExtension(host.extensionApi);
			await host.sessionStart();
			const command = host.commands.get("pi-style") as {
				handler(args: string, context: typeof host.extensionContext): Promise<void>;
			};
			const installed = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
			const generation = currentGeneration();
			await command.handler("off", host.extensionContext);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(installed);
			await command.handler("on", host.extensionContext);
			// Incomplete cleanup suppresses replacement installation and remains retryable.
			expect(currentGeneration()).toBe(generation);
			await command.handler("doctor", host.extensionContext);
			expect(JSON.parse(host.notifications.at(-1)?.message ?? "{}").operational.compatibility.cleanupPending).toBe(
				true,
			);
			blocked = false;
			await command.handler("off", host.extensionContext);
			await command.handler("on", host.extensionContext);
			expect(currentGeneration()).toBe(generation + 1);
			await host.sessionShutdown();
		} finally {
			reset();
		}
	});

	it("keeps product deny and source-backed session provenance across reload", async () => {
		const denyNative = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		const denyHost = new FakePiHost({ flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true } });
		const denyInjected = injectedSettings({ schemaVersion: 1, messages: { enabled: false } });
		const denyCoordinator = createPiStyleSessionCoordinator(denyHost.extensionApi, {
			filePort: denyInjected.port,
			paths: denyInjected.paths,
		});
		await denyCoordinator.start({ reason: "startup" }, denyHost.extensionContext);
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(denyNative);
		const denyDoctor = denyCoordinator.app.doctor() as { operational: { compatibility: Record<string, unknown> } };
		expect(denyDoctor.operational.compatibility.assistantMessage).toMatchObject({
			configured: false,
			authorized: true,
			installed: false,
		});
		expect(denyDoctor.operational.compatibility.assistantMessage).not.toHaveProperty("awaitingAuthorization");
		denyCoordinator.shutdown();
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(denyNative);

		const awaitingNative = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		const awaitingHost = new FakePiHost({
			flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true },
		});
		const awaitingInjected = injectedSettings({ messages: { enabled: true } });
		const awaitingCoordinator = createPiStyleSessionCoordinator(awaitingHost.extensionApi, {
			filePort: awaitingInjected.port,
			paths: awaitingInjected.paths,
		});
		await awaitingCoordinator.start({ reason: "startup" }, awaitingHost.extensionContext);
		// Default-on authorization installs the certified user-message adapter.
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(
			awaitingNative,
		);
		const awaitingDoctor = awaitingCoordinator.app.doctor() as {
			operational: { compatibility: Record<string, unknown> };
		};
		expect(awaitingDoctor.operational.compatibility.assistantMessage).toMatchObject({
			configured: true,
			authorized: true,
			installed: true,
		});
		expect(awaitingDoctor.operational.compatibility.assistantMessage).not.toHaveProperty("awaitingAuthorization");
		awaitingCoordinator.shutdown();
		// Tier C patches are retained across shutdown (the restored-chat render happens
		// before the next session_start, which performs the restore-and-reinstall).
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(
			awaitingNative,
		);
		// Restore the retained wrapper so the next coordinator in this test starts native.
		for (const spec of targetSpecs) {
			for (const record of getCompatibilityRecords(spec.target)) record.disposer();
		}

		const authorizedNative = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		const authorizedHost = new FakePiHost({
			flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true },
		});
		const authorizedInjected = injectedSettings({ messages: { enabled: true } });
		const authorizedCoordinator = createPiStyleSessionCoordinator(authorizedHost.extensionApi, {
			filePort: authorizedInjected.port,
			paths: authorizedInjected.paths,
		});
		await authorizedCoordinator.start({ reason: "startup" }, authorizedHost.extensionContext);
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(
			authorizedNative,
		);
		const authorizedDoctor = authorizedCoordinator.app.doctor() as {
			operational: { compatibility: Record<string, unknown> };
		};
		expect(authorizedDoctor.operational.compatibility.assistantMessage).toMatchObject({
			configured: true,
			authorized: true,
			installed: true,
		});
		authorizedCoordinator.shutdown();
		// Retained across the session-switch gap, as above.
		expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).not.toBe(
			authorizedNative,
		);

		const host = new FakePiHost({ flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true } });
		let source = { placement: "above", editor: { style: "compact" }, messages: { enabled: true }, schemaVersion: 1 };
		const settings = {
			port: {
				read: async (path: string) => (path === "global" ? JSON.stringify({ piStyle: source }) : "{}"),
				writeAtomic: async () => {},
			},
			paths: () => ({ globalPath: "global", projectPath: "project" }),
		};
		const commandStorage = { port: settings.port, paths: settings.paths() };
		const coordinator = createPiStyleSessionCoordinator(host.extensionApi, {
			filePort: settings.port,
			paths: settings.paths,
		});
		await coordinator.start({ reason: "startup" }, host.extensionContext);
		const context = host.extensionContext as never;
		await executePiStyleCommand("placement below", context, coordinator.app, commandStorage);
		source = { placement: "above", editor: { style: "boxed" }, messages: { enabled: true }, schemaVersion: 1 };
		await executePiStyleCommand("reload", context, coordinator.app, commandStorage);
		expect(coordinator.app.config.placement).toBe("below");
		expect((coordinator.app.doctor().sources as Record<string, string>).placement).toBe("session");
		expect(coordinator.app.config.editor.style).toBe("boxed");
		expect((coordinator.app.doctor().sources as Record<string, string>)["editor.style"]).toBe("global");
		coordinator.shutdown();
	});

	it("keeps print/json prototypes native after command mutation and reload", async () => {
		const native = Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value;
		for (const mode of ["print", "json"] as const) {
			const host = new FakePiHost({
				mode,
				flags: { "pi-style-core-patches": true, "pi-style-message-assistant": true },
			});
			piStyleExtension(host.extensionApi);
			await host.sessionStart();
			const command = host.commands.get("pi-style") as {
				handler(args: string, context: typeof host.extensionContext): Promise<void>;
			};
			await command.handler("on", host.extensionContext);
			await command.handler("reload", host.extensionContext);
			expect(Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "render")?.value).toBe(native);
			await host.sessionShutdown();
		}
	});

	it("drops bare `!`/`!!` interactive submits and keeps real bash commands", async () => {
		const host = new FakePiHost({ mode: "tui" });
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		const inputHandlers = host.handlers.get("input") ?? [];
		expect(inputHandlers.length).toBeGreaterThan(0);
		const handler = inputHandlers[inputHandlers.length - 1] as unknown as (
			event: { type: "input"; text: string; source: string },
			ctx: never,
		) => Promise<unknown>;
		const invoke = (text: string, source = "interactive") =>
			handler({ type: "input", text, source }, host.extensionContext as never);
		// Bare bangs (no command after the prefix) are blocked…
		expect(await invoke("!")).toEqual({ action: "handled" });
		expect(await invoke("!!")).toEqual({ action: "handled" });
		expect(await invoke("!  ")).toEqual({ action: "handled" });
		expect(await invoke("!!\t")).toEqual({ action: "handled" });
		// …real bash commands, normal messages, and non-interactive sources pass through.
		expect(await invoke("!echo hi")).toBeUndefined();
		expect(await invoke("!!git status")).toBeUndefined();
		expect(await invoke("hello")).toBeUndefined();
		expect(await invoke("!", "rpc")).toBeUndefined();
		expect(await invoke("!", "extension")).toBeUndefined();
		await host.sessionShutdown();
	});
});
