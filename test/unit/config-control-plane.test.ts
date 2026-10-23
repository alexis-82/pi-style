const ESC = "\x1b";

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { executePiStyleCommand } from "../../extension-src/pi-style/app/command-service.js";
import { readScopedConfig, writeScopedConfig } from "../../extension-src/pi-style/app/config-storage.js";
import { createDoctor } from "../../extension-src/pi-style/app/doctor.js";
import { createPiStyleApp } from "../../extension-src/pi-style/app/index.js";
import { isTierCAuthorized } from "../../extension-src/pi-style/domain/config-authorization.js";
import { migrateConfig } from "../../extension-src/pi-style/domain/config-migrations.js";
import {
	DEFAULT_CONFIG,
	normalizeConfig,
	resolveConfigDetailed,
} from "../../extension-src/pi-style/domain/config-normalization.js";
import { createPiConfigFilePort } from "../../extension-src/pi-style/pi/config-host.js";
import { createConfigSourceAdapter, resolveProductGate } from "../../extension-src/pi-style/pi/config-session.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

describe("configuration control plane and composition", () => {
	it("covers the complete product gate matrix across trust and raw layers", () => {
		const values = [undefined, true, false, "invalid"] as const;
		for (const trusted of [true, false])
			for (const global of values)
				for (const project of values)
					for (const session of values) {
						const make = (value: unknown) =>
							value === undefined ? undefined : { compatibility: { allowCorePatches: value } };
						const expected =
							global === false || session === false || (trusted && project === false) ? "deny" : "omitted";
						expect(resolveProductGate(make(global), make(project), make(session), trusted).corePatchGate).toBe(
							expected,
						);
					}
	});
	it.each([
		[undefined, undefined, undefined, true, "omitted"],
		[{ compatibility: { allowCorePatches: true } }, undefined, undefined, true, "omitted"],
		[{ compatibility: { allowCorePatches: false } }, undefined, undefined, true, "deny"],
		[{ compatibility: { allowCorePatches: false } }, { compatibility: {} }, undefined, true, "deny"],
		[{ compatibility: { allowCorePatches: "bad" } }, undefined, undefined, true, "omitted"],
		[undefined, { compatibility: { allowCorePatches: false } }, undefined, false, "omitted"],
		[
			undefined,
			{ compatibility: { allowCorePatches: false } },
			{ compatibility: { allowCorePatches: true } },
			true,
			"deny",
		],
	] as const)("resolves product policy as deny-only raw leaf (%j)", (global, project, session, trusted, gate) => {
		expect(resolveProductGate(global, project, session, trusted)).toEqual({ corePatchGate: gate });
	});
	it("reports exact custom item shape diagnostics and retains only valid mixed items", () => {
		const shapes = [
			[1, ["statusLine.customItems[0]"]],
			[{ statusKey: "k" }, ["statusLine.customItems[0].id"]],
			[{ id: "x" }, ["statusLine.customItems[0].statusKey"]],
		] as const;
		for (const [item, paths] of shapes) {
			const result = resolveConfigDetailed({ session: { statusLine: { customItems: [item] } } });
			expect(
				result.diagnostics
					.map((diagnostic) => diagnostic.path)
					.filter((path) => path === "statusLine.customItems[0]" || path.startsWith("statusLine.customItems[0].")),
			).toEqual(paths);
			expect(result.config.statusLine.customItems).toEqual([]);
		}
		const mixed = resolveConfigDetailed({
			session: { statusLine: { customItems: [{ id: "ok", statusKey: "k" }, { id: 1 }] } },
		});
		expect(mixed.config.statusLine.customItems).toEqual([{ id: "ok", statusKey: "k" }]);
	});
	it("reports exact custom item field diagnostics and drops malformed items", () => {
		const result = resolveConfigDetailed({
			session: {
				statusLine: { customItems: [{ id: "x", statusKey: "k", label: "ok", priority: "bad", placement: "left" }] },
			},
		});
		expect(
			result.diagnostics.map((item) => item.path).filter((path) => path.startsWith("statusLine.customItems[0]")),
		).toEqual(["statusLine.customItems[0].priority"]);
		expect(result.config.statusLine.customItems).toEqual([]);
		expect(result.diagnostics.map((item) => item.path)).not.toEqual(
			expect.arrayContaining([
				"statusLine.customItems[0].id",
				"statusLine.customItems[0].statusKey",
				"statusLine.customItems[0].label",
				"statusLine.customItems[0].placement",
			]),
		);
		const unknown = resolveConfigDetailed({
			session: { statusLine: { customItems: [{ id: "x", statusKey: "k", color: "red" }] } },
		});
		expect(
			unknown.diagnostics.map((item) => item.path).filter((path) => path.startsWith("statusLine.customItems[0]")),
		).toEqual(["statusLine.customItems[0].color"]);
		expect(unknown.config.statusLine.customItems).toEqual([]);
		expect(unknown.diagnostics.map((item) => item.path)).not.toEqual(
			expect.arrayContaining(["statusLine.customItems[0].id", "statusLine.customItems[0].statusKey"]),
		);
	});
	it("validates every public leaf with exact invalid fallback diagnostics", () => {
		const cases: Array<[string, unknown, unknown]> = [
			["enabled", true, "bad"],
			["preset", "compact", "bad"],
			["placement", "below", "bad"],
			["startup.mode", "overlay", "bad"],
			["startup.showResources", false, "bad"],
			["statusLine.enabled", false, "bad"],
			["statusLine.separator", "sep", 3],
			["statusLine.layout.left", [], "bad"],
			["statusLine.layout.right", ["x"], [1]],
			["statusLine.layout.secondary", [], [null]],
			["statusLine.disabledSegments", [], [1]],
			[
				"statusLine.customItems[0].id",
				[{ id: "i", statusKey: "k", label: "", priority: 0, placement: "left" }],
				[{ id: 1 }],
			],
			["editor.enabled", false, "bad"],
			["editor.style", "dock", "bad"],
			["editor.frame", "rounded", "bad"],
			["editor.showMetadata", false, "bad"],
			["editor.hint", "Ask Pi anything", 3],
			["messages.enabled", false, "bad"],
			["messages.assistantPrefix", false, "bad"],
			["messages.specialBlocks", false, "bad"],
			["messages.showImagePreviews", false, "bad"],
			["messages.clipboardImages", false, "bad"],
			["messages.previewMaxWidth", 30, "bad"],
			["tools.enabled", false, "bad"],
			["tools.style", "wide", 1],
			["tools.maxCollapsedLines", 0, -1],
			["tools.showElapsed", false, "bad"],
			["tools.collapseAfterTurn", false, "bad"],
			["tools.collapseMutatingTools", false, "bad"],
			["theme.nerdFonts", "off", "bad"],
			["theme.terminalBackgroundSync", "on", "bad"],
			["theme.autoApply", "titanium", 3],
			["theme.colors", {}, { x: 1 }],
			["theme.glyphs", { x: "" }, { x: 1 }],
			["compatibility.allowSafePatches", false, "bad"],
			["compatibility.allowCorePatches", false, "bad"],
			["compatibility.preferExistingEditor", false, "bad"],
			["compatibility.preferExistingFooter", false, "bad"],
			["debug", true, "bad"],
		];
		for (const [path, valid, invalid] of cases) {
			const make = (value: unknown) =>
				path.startsWith("statusLine.customItems[")
					? { statusLine: { customItems: value } }
					: (path.split(".").reduceRight((nested, key) => ({ [key]: nested }), value) as unknown);
			const result = resolveConfigDetailed({ global: make(valid), session: make(invalid) });
			expect(
				result.diagnostics.some(
					(item) => item.path === path || (path.startsWith("statusLine.customItems[") && item.path.startsWith(path)),
				),
				path,
			).toBe(true);
			if (!path.startsWith("statusLine.customItems[")) expect(result.sources[path]).toBe("global");
		}
		const unknown = resolveConfigDetailed({ session: { startup: { unknown: { nested: true } } } });
		expect(unknown.diagnostics.some((item) => item.path === "startup.unknown")).toBe(true);
	});
	it.each([
		["enabled", { enabled: "bad" }, { enabled: true }, true],
		["placement", { placement: "bad" }, { placement: "below" }, true],
		["startup.mode", { startup: { mode: "bad" } }, { startup: { mode: "overlay" } }, true],
		[
			"statusLine.layout.left",
			{ statusLine: { layout: { left: "bad" } } },
			{ statusLine: { layout: { left: [] } } },
			true,
		],
		["theme.glyphs", { theme: { glyphs: [] } }, { theme: { glyphs: { branch: "" } } }, true],
		["debug", { debug: "bad" }, { debug: true }, true],
	] as const)(
		"falls through invalid higher-precedence %s to accepted lower source",
		(path, invalid, lower, expectedDiagnostic) => {
			const result = resolveConfigDetailed({ global: lower, session: invalid });
			const actual =
				path === "enabled"
					? result.config.enabled
					: path === "placement"
						? result.config.placement
						: path === "startup.mode"
							? result.config.startup.mode
							: path === "statusLine.layout.left"
								? result.config.statusLine.layout.left
								: path === "theme.glyphs"
									? result.config.theme.glyphs
									: result.config.debug;
			expect(actual).toEqual(
				path === "theme.glyphs"
					? { branch: "" }
					: path === "statusLine.layout.left"
						? []
						: path === "startup.mode"
							? "overlay"
							: path === "placement"
								? "below"
								: true,
			);
			expect(result.diagnostics.length).toBeGreaterThan(expectedDiagnostic ? 0 : -1);
			expect(result.sources[path]).toBe("global");
		},
	);
	it("resolves preset, precedence, provenance, and explicit empty arrays", () => {
		const result = resolveConfigDetailed({
			global: { preset: "minimal", editor: { style: "boxed" } },
			project: { statusLine: { layout: { left: [] } } },
			projectTrusted: true,
			environment: { PI_STYLE_EDITOR: "dock" },
			session: { editor: { style: "native" } },
		});
		expect(result.config.preset).toBe("minimal");
		expect(result.config.editor.style).toBe("native");
		expect(result.config.statusLine.layout.left).toEqual([]);
		expect(result.sources["editor.style"]).toBe("session");
		expect(result.sources["statusLine.layout.left"]).toBe("project");
		expect(result.sources["editor.frame"]).toContain("preset:");
	});

	it("maps collapseAfterTurn by preset: off for minimal/native, on otherwise", () => {
		for (const preset of ["default", "compact", "full", "ascii"] as const)
			expect(resolveConfigDetailed({ global: { preset } }).config.tools.collapseAfterTurn).toBe(true);
		for (const preset of ["minimal", "native"] as const)
			expect(resolveConfigDetailed({ global: { preset } }).config.tools.collapseAfterTurn).toBe(false);
		expect(
			resolveConfigDetailed({ global: { tools: { collapseAfterTurn: false } } }).config.tools.collapseAfterTurn,
		).toBe(false);
	});

	it("maps collapseMutatingTools: off by default for every preset, explicit on wins", () => {
		for (const preset of ["default", "minimal", "compact", "full", "ascii", "native"] as const)
			expect(resolveConfigDetailed({ global: { preset } }).config.tools.collapseMutatingTools).toBe(false);
		expect(
			resolveConfigDetailed({ global: { tools: { collapseMutatingTools: true } } }).config.tools.collapseMutatingTools,
		).toBe(true);
	});

	it("reports malformed leaf fields and preserves explicit empty arrays", () => {
		const result = resolveConfigDetailed({
			global: {
				placement: "bad",
				editor: { style: "bad", frame: "bad" },
				startup: { mode: "bad" },
				statusLine: { layout: "bad", customItems: {} },
				theme: { colors: [] },
			},
		});
		expect(result.diagnostics.map((item) => item.path)).toEqual(
			expect.arrayContaining([
				"placement",
				"editor.style",
				"editor.frame",
				"startup.mode",
				"statusLine.layout",
				"statusLine.customItems",
				"theme.colors",
			]),
		);
	});

	it("keeps environment and session overlays in the shared source pipeline", async () => {
		const previous = process.env.PI_STYLE_STATUS;
		process.env.PI_STYLE_STATUS = "below";
		try {
			const files = new Map([
				["global", JSON.stringify({ piStyle: { placement: "above" } })],
				["project", "{}"],
			]);
			const adapter = createConfigSourceAdapter(
				{ getFlag: (name) => name === "pi-style-ascii" },
				{ read: async (path) => files.get(path) ?? "{}", writeAtomic: async () => {} },
				() => ({ globalPath: "global", projectPath: "project" }),
			);
			adapter.setSession("/fake", true);
			const loaded = await adapter.load();
			expect(loaded.config).toMatchObject({ placement: "below", preset: "default" });
			expect(loaded.sources.placement).toBe("environment");
		} finally {
			if (previous === undefined) delete process.env.PI_STYLE_STATUS;
			else process.env.PI_STYLE_STATUS = previous;
		}
	});

	it("retains session command overrides across source reload", async () => {
		let source = { placement: "above", preset: "default" };
		const app = createPiStyleApp(undefined, {
			load: async () => ({ config: source, diagnostics: [], sources: { placement: "global" } }),
		});
		app.applySession({ placement: "below", preset: "ascii" });
		await app.reload();
		expect(app.config).toMatchObject({ placement: "below", preset: "ascii" });
		source = { placement: "above", preset: "compact" };
		await app.reload();
		expect(app.config).toMatchObject({ placement: "below", preset: "ascii" });
		expect(app.doctor().sources).toMatchObject({ placement: "session" });
	});

	it("uses one injected source adapter for trusted and untrusted reload inputs", async () => {
		const files = new Map([
			["global", JSON.stringify({ piStyle: { placement: "below" } })],
			["project", JSON.stringify({ piStyle: { enabled: false } })],
		]);
		const adapter = createConfigSourceAdapter(
			{ getFlag: (name) => name === "pi-style-core-patches" },
			{ read: async (path) => files.get(path) ?? "{}", writeAtomic: async () => {} },
			() => ({ globalPath: "global", projectPath: "project" }),
		);
		adapter.setSession("/fake", true);
		expect((await adapter.load()).config).toMatchObject({ placement: "below", enabled: false });
		adapter.setSession("/fake", false);
		expect((await adapter.load()).config).toMatchObject({ placement: "below", enabled: true });
	});

	it("fails future schemas closed and warns once for unversioned input", () => {
		expect(migrateConfig({ enabled: true }).diagnostics[0]?.code).toBe("CFG-002");
		const future = migrateConfig({ schemaVersion: 99, enabled: false });
		expect(future.readOnly).toBe(true);
		expect(future.config).toBeUndefined();
	});

	it("treats missing settings files as writable empty scopes", async () => {
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
		const read = await readScopedConfig(
			{
				read: async () => {
					throw missing;
				},
				writeAtomic: async () => {},
			},
			"/missing/settings.json",
		);
		expect(read).toEqual({ value: undefined, readOnly: false, diagnostics: [] });
	});

	it("writes only piStyle and preserves unrelated settings, while malformed input is protected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-style-phase6-"));
		const path = join(dir, "settings.json");
		await writeFile(path, JSON.stringify({ other: { keep: true }, extensions: { x: 1 } }));
		const filePort = createPiConfigFilePort();
		await writeScopedConfig(filePort, path, { schemaVersion: 1, enabled: false, theme: { colors: { keep: "yes" } } });
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			other: { keep: true },
			piStyle: { enabled: false, theme: { colors: { keep: "yes" } } },
		});
		await writeFile(path, "{bad");
		await expect(writeScopedConfig(filePort, path, { enabled: true })).rejects.toThrow("refusing");
		const read = await readScopedConfig(filePort, path);
		expect(read.readOnly).toBe(true);
	});

	it("defaults theme autoApply to titanium with preset and env overrides", () => {
		expect(resolveConfigDetailed({}).config.theme.autoApply).toBe("titanium");
		// The native preset keeps the user's active Pi theme.
		expect(resolveConfigDetailed({ global: { preset: "native" } }).config.theme.autoApply).toBe("off");
		expect(resolveConfigDetailed({ session: { theme: { autoApply: "off" } } }).config.theme.autoApply).toBe("off");
		expect(
			resolveConfigDetailed({ global: { theme: { autoApply: "titanium-light/titanium" } } }).config.theme.autoApply,
		).toBe("titanium-light/titanium");
		const env = resolveConfigDetailed({ environment: { PI_STYLE_THEME: "off" } });
		expect(env.config.theme.autoApply).toBe("off");
		expect(env.sources["theme.autoApply"]).toBe("environment");
		expect(env.diagnostics.length).toBe(0);
	});

	it("keeps untrusted project configuration out of effective resolution", () => {
		const result = resolveConfigDetailed({ project: { enabled: false }, projectTrusted: false });
		expect(result.config.enabled).toBe(DEFAULT_CONFIG.enabled);
	});

	it("doctor exposes bounded state without raw host objects", () => {
		const state = createDoctor({
			config: DEFAULT_CONFIG,
			diagnostics: [],
			surfaces: { status: "active", messages: "unavailable" },
			piVersion: "0.83.0",
		});
		expect(state.surfaces).toMatchObject({ messages: "unavailable" });
		expect(state).not.toHaveProperty("targets");
	});

	it("keeps Tier C deny-only without original session authorization", () => {
		const config = normalizeConfig({ enabled: true, messages: { enabled: true } });
		expect(isTierCAuthorized({ coreFlag: false, surfaceFlag: true, surface: "messages", config })).toBe(false);
		expect(isTierCAuthorized({ coreFlag: true, surfaceFlag: true, surface: "messages", config })).toBe(true);
		expect(
			isTierCAuthorized({
				coreFlag: true,
				surfaceFlag: true,
				surface: "messages",
				config: normalizeConfig({ enabled: false }),
			}),
		).toBe(false);
	});

	it("applies session mutations without disk writes and remains safe headless", () => {
		const app = createPiStyleApp();
		app.applySession({ enabled: false });
		expect(app.config.enabled).toBe(false);
		app.applySession({ enabled: true });
		expect(app.config.enabled).toBe(true);
	});

	it("persists command mutations without leaking session authorization fields", async () => {
		const app = createPiStyleApp({
			compatibility: { allowCorePatches: true },
			messages: { enabled: true },
			tools: { enabled: true },
		});
		const writes: string[] = [];
		const port = {
			read: async () => JSON.stringify({}),
			writeAtomic: async (_path: string, content: string): Promise<void> => {
				writes.push(content);
			},
		};
		const host = { ui: { select: async () => undefined, notify: () => {} }, cwd: "/tmp", isProjectTrusted: () => true };
		await executePiStyleCommand("persist global surface messages on", host, app, {
			port,
			paths: { globalPath: "global", projectPath: "project" },
		});
		const stored = JSON.parse(writes[0] ?? "{}").piStyle as Record<string, unknown>;
		expect(stored).toEqual({ messages: { enabled: true } });
		expect(stored).not.toHaveProperty("compatibility");
	});

	it("keeps selector commands session-only and blocks untrusted project persistence", async () => {
		const app = createPiStyleApp();
		const command = (args: string, context: ExtensionCommandContext) =>
			executePiStyleCommand(
				args,
				{ ui: context.ui, cwd: context.cwd ?? "/tmp", isProjectTrusted: context.isProjectTrusted },
				app,
				{
					port: { read: async () => "{}", writeAtomic: async () => {} },
					paths: { globalPath: "/tmp/global", projectPath: "/tmp/project" },
				},
			);
		const notify: string[] = [];
		const ctx = {
			ui: { select: async () => "compact", notify: (message: string) => notify.push(message) },
			isProjectTrusted: () => false,
			cwd: "/tmp",
		} as unknown as ExtensionCommandContext;
		await command("preset", ctx);
		expect(app.config.preset).toBe("compact");
		await command("persist project on", ctx);
		expect(notify.at(-1)).toContain("trusted project");
	});

	it("reconciles real FakePiHost public slots through off/on transitions", () => {
		const host = new FakePiHost();
		const app = createPiStyleApp();
		app.sessionStart({
			mode: "tui",
			hasUI: true,
			ui: host.extensionContext.ui,
			cwd: "/fake",
			projectTrusted: true,
			...(host.gitRunner ? { gitRunner: host.gitRunner } : {}),
		});
		const providers = app.runtime.current?.providerIdentity;
		expect(providers).toBeDefined();
		expect(host.widgets.has("pi-style.status.primary")).toBe(true);
		expect(host.ownership.editor.current).toBe(true);
		expect(host.ownership.footer.current).toBe(true);
		app.applySession({ enabled: false });
		expect(app.runtime.current?.providerIdentity.git).toBe(providers?.git);
		expect(host.widgets.has("pi-style.status.primary")).toBe(false);
		expect(host.ownership.editor.current).toBe(false);
		expect(host.ownership.footer.current).toBe(false);
		const laterEditor = (() => undefined) as never;
		host.extensionContext.ui.setEditorComponent?.(laterEditor);
		app.applySession({ enabled: true });
		expect(host.ownership.editor.current).toBe(true);
		expect(host.ownership.editor.restores).toBe(1);
		expect(host.ownership.footer.current).toBe(true);
		app.sessionShutdown();
		expect(host.ownership.footer.current).toBe(false);
	});

	it("rebuilds placement and custom status layout while owning the footer", () => {
		const host = new FakePiHost();
		const app = createPiStyleApp({
			statusLine: {
				layout: { left: ["pi"], right: [], secondary: [] },
				customItems: [{ id: "custom", statusKey: "opaque" }],
			},
		});
		app.sessionStart({ mode: "tui", hasUI: true, ui: host.extensionContext.ui });
		expect(host.widgets.get("pi-style.status.primary")?.placement).toBe("belowEditor");
		expect(host.ownership.footer.current).toBe(true);
		app.applySession({ placement: "above" });
		expect(host.widgets.get("pi-style.status.primary")?.placement).toBe("aboveEditor");
		expect(host.ownership.footer.current).toBe(true);
		expect(host.ownership.footer.restores).toBe(1);
	});

	it("hides extension statuses and reports recovery when the provider fails", () => {
		const host = new FakePiHost();
		const app = createPiStyleApp({ statusLine: { layout: { left: ["extension_statuses"] } } });
		app.sessionStart({
			mode: "tui",
			hasUI: true,
			ui: host.extensionContext.ui,
			extensionStatusProvider: () => {
				throw new Error("provider down");
			},
		});
		app.update({}, "immediate");
		expect(host.ownership.footer.current).toBe(true);
		expect(host.notifications.some((item) => item.message.includes("recovery required"))).toBe(true);
		expect(app.doctor()).toMatchObject({ operational: { provider: { status: "unavailable" } } });
	});

	it("uses an injected extension-status provider while owning the footer", () => {
		const host = new FakePiHost();
		const app = createPiStyleApp({ statusLine: { layout: { left: ["extension_statuses"] } } });
		app.sessionStart({
			mode: "tui",
			hasUI: true,
			ui: host.extensionContext.ui,
			cwd: "/fake",
			...(host.gitRunner ? { gitRunner: host.gitRunner } : {}),
			extensionStatusProvider: () => [{ key: "opaque", value: "safe" }],
		});
		app.update({}, "immediate");
		expect(host.ownership.footer.current).toBe(true);
		expect(host.widgets.has("pi-style.status.primary")).toBe(true);
		const factory = host.componentFactories.get("pi-style.status.primary");
		const rendered =
			factory?.({ requestRender: () => {} }, host.theme)
				.render(120)
				.join(" ") ?? "";
		expect(rendered).toContain("safe");
		expect(app.doctor()).toMatchObject({ operational: { provider: { status: "available" } } });
	});

	it("renders the configured bottom margin and context bar width", () => {
		const host = new FakePiHost();
		const app = createPiStyleApp({ statusLine: { bottomMargin: 2, contextBarWidth: 6 } });
		app.sessionStart({
			mode: "tui",
			hasUI: true,
			ui: host.extensionContext.ui,
			cwd: "/fake",
			model: { name: "model", provider: "provider" },
		});
		app.update({ context: { percent: 50, windowTokens: 1_000_000 } }, "immediate");
		const factory = host.componentFactories.get("pi-style.status.primary");
		const lines = factory?.({ requestRender: () => {} }, host.theme).render(120) ?? [];
		// The two trailing rows are the configured bottom margin.
		expect(lines.slice(-2)).toEqual(["", ""]);
		const plain = lines[0] ?? "";
		const stripped = plain.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
		// contextBarWidth 6 renders a 6-cell background bar: 50% → 3 filled cells.
		expect(stripped).toMatch(/ctx \[ {6}\] 50%/);
		expect(plain).toContain(`${ESC}[48;5;78m   ${ESC}[0m${ESC}[48;5;238m   ${ESC}[0m`);
	});

	it("keeps print and json sessions inert", () => {
		for (const mode of ["print", "json"] as const) {
			const host = new FakePiHost({ mode });
			const app = createPiStyleApp();
			app.sessionStart({ mode, hasUI: false, ui: host.extensionContext.ui });
			expect(host.widgets.size).toBe(0);
			expect(host.ownership.footer.current).toBe(false);
			app.sessionShutdown();
		}
	});

	it("executes the complete session and persistence command grammar", async () => {
		const app = createPiStyleApp();
		const writes: string[] = [];
		const host = {
			ui: {
				select: async () => undefined,
				notify: (message: string) => {
					notifications.push(message);
				},
			},
			cwd: "/tmp",
			isProjectTrusted: () => true,
		};
		const notifications: string[] = [];
		const storage = {
			port: {
				read: async () => JSON.stringify({ piStyle: { theme: { colors: { keep: "yes" } } }, other: { keep: true } }),
				writeAtomic: async (_path: string, content: string): Promise<void> => {
					writes.push(content);
				},
			},
			paths: { globalPath: "global", projectPath: "project" },
		};
		for (const command of [
			"on",
			"preset compact",
			"placement below",
			"editor boxed outline",
			"startup overlay",
			"surface status off",
			"surface editor off",
			"surface startup off",
		])
			await executePiStyleCommand(command, host, app, storage);
		await executePiStyleCommand("persist global on", host, app, storage);
		expect(app.config.preset).toBe("compact");
		expect(app.config.placement).toBe("below");
		expect(app.config.editor.style).toBe("boxed");
		expect(app.config.editor.frame).toBe("outline");
		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes.at(0) ?? "{}").piStyle).toMatchObject({ theme: { colors: { keep: "yes" } } });
	});

	it("rejects malformed custom item commands and retains valid custom items", async () => {
		const app = createPiStyleApp();
		const notifications: string[] = [];
		const host = {
			ui: { select: async () => undefined, notify: (message: string) => notifications.push(message) },
			cwd: "/tmp",
			isProjectTrusted: () => true,
		};
		const storage = {
			port: { read: async () => "{}", writeAtomic: async () => {} },
			paths: { globalPath: "global", projectPath: "project" },
		};
		await executePiStyleCommand('set statusLine.customItems [{"statusKey":"missing-id"}]', host, app, storage);
		expect(notifications.at(-1) ?? "").toContain("invalid");
		expect(app.config.statusLine.customItems).toEqual([]);
		await executePiStyleCommand(
			'set statusLine.customItems [{"id":"x","statusKey":"k","color":"red"}]',
			host,
			app,
			storage,
		);
		expect(notifications.at(-1)).toContain("invalid");
		expect(app.config.statusLine.customItems).toEqual([]);
		await executePiStyleCommand(
			'set statusLine.customItems [{"id":"x","statusKey":"k","label":"ok","placement":"left"}]',
			host,
			app,
			storage,
		);
		expect(app.config.statusLine.customItems).toEqual([{ id: "x", statusKey: "k", label: "ok", placement: "left" }]);
	});

	it("removes temp files when the real atomic rename fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-style-rename-"));
		const path = join(dir, "settings.json");
		const port = createPiConfigFilePort({
			rename: async () => {
				throw new Error("rename failed");
			},
		});
		await expect(port.writeAtomic(path, "{}\n")).rejects.toThrow("rename failed");
		expect(
			(await (await import("node:fs/promises")).readdir(dir)).filter((name) => name.includes(".pi-style-")).length,
		).toBe(0);
	});

	it("cleans temporary files after an atomic write failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-style-failure-"));
		const path = join(dir, "settings.json");
		const failingPort = {
			read: async () => "{}",
			writeAtomic: async () => {
				throw new Error("rename failed");
			},
		};
		await expect(writeScopedConfig(failingPort, path, { enabled: true })).rejects.toThrow("rename failed");
		expect(
			(await (await import("node:fs/promises")).readdir(dir)).filter((name) => name.includes(".pi-style-")).length,
		).toBe(0);
	});

	it("serializes concurrent writes and cleans failed temporary files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-style-concurrent-"));
		const path = join(dir, "settings.json");
		const port = createPiConfigFilePort();
		await Promise.all([
			writeScopedConfig(port, path, { statusLine: { enabled: true } }),
			writeScopedConfig(port, path, { editor: { enabled: false } }),
		]);
		const document = JSON.parse(await readFile(path, "utf8"));
		expect(document.piStyle).toMatchObject({ statusLine: { enabled: true }, editor: { enabled: false } });
		const leftovers = (await import("node:fs/promises")).readdir(dir);
		expect((await leftovers).filter((name) => name.includes(".pi-style-")).length).toBe(0);
	});

	it("notifies safely when persistence fails", async () => {
		const app = createPiStyleApp();
		const notifications: string[] = [];
		await executePiStyleCommand(
			"persist global on",
			{
				ui: { select: async () => undefined, notify: (message: string) => notifications.push(message) },
				cwd: "/tmp",
				isProjectTrusted: () => true,
			},
			app,
			{
				port: {
					read: async () => "{}",
					writeAtomic: async () => {
						throw new Error("disk full");
					},
				},
				paths: { globalPath: "global", projectPath: "project" },
			},
		);
		expect(notifications.at(-1)).toContain("write failed");
	});

	it("supports recursive raw allowlisted mutations for maps, arrays, and every public scope", async () => {
		const app = createPiStyleApp();
		const writes: string[] = [];
		const host = { ui: { select: async () => undefined, notify: () => {} }, cwd: "/tmp", isProjectTrusted: () => true };
		const storage = {
			port: {
				read: async () => "{}",
				writeAtomic: async (_path: string, content: string): Promise<void> => {
					writes.push(content);
				},
			},
			paths: { globalPath: "global", projectPath: "project" },
		};
		for (const command of [
			'set statusLine.layout.left ["model","git"]',
			'set theme.glyphs {"branch":""}',
			'set statusLine.customItems [{"id":"x","statusKey":"opaque"}]',
		])
			await executePiStyleCommand(command, host, app, storage);
		expect(app.config.statusLine.layout.left).toEqual(["model", "git"]);
		expect(app.config.theme.glyphs.branch).toBe("");
		await executePiStyleCommand('persist global set theme.colors {"accent":"blue"}', host, app, storage);
		expect(JSON.parse(writes.at(-1) ?? "{}").piStyle.theme.colors.accent).toBe("blue");
		await executePiStyleCommand("set compatibility.allowCorePatches true", host, app, storage);
		expect(app.config.compatibility.allowCorePatches).toBe(true);
	});

	it("rejects future and malformed durable namespaces without changing bytes", async () => {
		const app = createPiStyleApp();
		const notifications: string[] = [];
		const host = {
			ui: { select: async () => undefined, notify: (message: string) => notifications.push(message) },
			cwd: "/tmp",
			isProjectTrusted: () => true,
		};
		for (const document of [
			'{"piStyle":{"schemaVersion":99,"enabled":false},"other":1}',
			'{"piStyle":null,"other":1}',
			'{"other":1}',
		]) {
			let bytes = document;
			await executePiStyleCommand("persist global set enabled false", host, app, {
				port: {
					read: async () => bytes,
					writeAtomic: async (_path: string, content: string) => {
						bytes = content;
					},
				},
				paths: { globalPath: "global", projectPath: "project" },
			});
			if (document.includes("schemaVersion") || document.includes("null")) expect(bytes).toBe(document);
		}
		expect(notifications.some((message) => message.includes("write failed"))).toBe(true);
	});

	it("routes doctor output through the safe command path", async () => {
		const app = createPiStyleApp();
		const notifications: string[] = [];
		await executePiStyleCommand(
			"doctor",
			{
				ui: { select: async () => undefined, notify: (message: string) => notifications.push(message) },
				cwd: "/tmp",
				isProjectTrusted: () => true,
			},
			app,
			{
				port: { read: async () => "{}", writeAtomic: async () => {} },
				paths: { globalPath: "global", projectPath: "project" },
			},
		);
		const output = JSON.parse(notifications.at(0) ?? "{}");
		expect(output).not.toHaveProperty("targets");
		expect(output.config).not.toHaveProperty("theme");
	});
});
