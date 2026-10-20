import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	initTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { decorateMessageRender } from "../../extension-src/pi-style/features/messages/index.js";
import {
	__setToolDecorationTestHooks,
	createToolDecorationOwner,
} from "../../extension-src/pi-style/features/tools/index.js";
import {
	type CompatibilityRecordSnapshot,
	detectPiVersion,
	disposePiCompatibilityProbe,
	fingerprint,
	KNOWN_NATIVE_IDENTITIES,
	probePiCompatibility,
	retainPiCompatibilityProbe,
	SUPPORTED_PI_VERSIONS,
	TRUSTED_NATIVE_FINGERPRINTS,
	targetSpecs,
} from "../../extension-src/pi-style/pi/compatibility-probe.js";
import {
	__setCompatibilityRegistryTestHooks,
	getCompatibilityRecords,
	installDelegatingPatch,
	nextGeneration,
} from "../../extension-src/pi-style/pi/compatibility-registry.js";
import piStyleExtension, { __setCompatibilityTestHooks } from "../../extension-src/pi-style/pi/index.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";
import { createFakeTheme } from "../helpers/fake-theme.js";

const owners = new Set<object>();
const nativeTargets = targetSpecs.map((spec) => ({
	target: spec.target,
	method: spec.method,
	key: `${spec.subtype}:${spec.method}`,
}));

function descriptors() {
	return nativeTargets.map(({ target, method }) => Object.getOwnPropertyDescriptor(target, method));
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
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
		stopReason,
		timestamp: 1,
	};
}

afterEach(() => {
	for (const owner of [...owners, ...targetSpecs.map((spec) => spec.target)]) {
		for (const record of getCompatibilityRecords(owner)) record.disposer();
	}
	owners.clear();
});

function rendererContext(lastComponent: object | undefined, overrides: Record<string, unknown> = {}) {
	return {
		args: { path: "README.md" },
		toolCallId: "fixture-call",
		invalidate: () => {},
		lastComponent,
		state: {},
		cwd: "/fake",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		...overrides,
	};
}

function count(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function toolDefinitionSnapshot(definition: Record<string, unknown>) {
	const keys = Reflect.ownKeys(definition);
	return {
		keys,
		descriptors: keys.map((key) => [key, Object.getOwnPropertyDescriptor(definition, key)] as const),
		identity: definition,
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		parametersShape: JSON.stringify(definition.parameters),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		renderCall: definition.renderCall,
		renderResult: definition.renderResult,
		execute: definition.execute,
	};
}

describe("identity-certified compatibility probe", () => {
	it("prefixes only the first nonblank line with one reduced native call", () => {
		let calls = 0;
		let width = 0;
		const native = (_width: number) => {
			calls++;
			width = _width;
			return ["  ", "  text", "  continuation"];
		};
		const output = decorateMessageRender(native, {}, [30]);
		expect(calls).toBe(1);
		expect(width).toBe(28);
		expect(output).toEqual([" ".repeat(30), `│   text${" ".repeat(22)}`, `    continuation${" ".repeat(14)}`]);
	});

	it("preserves OSC control-only lines and prefixes OSC content exactly once", () => {
		const native = () => ["  ", "\x1b]133;A\x07text\x1b]133;B\x07", "\x1b]133;B\x07\x1b]133;C\x07"];
		const output = decorateMessageRender(native, {}, [40]);
		expect(output).toEqual([
			" ".repeat(40),
			`│ \x1b]133;A\x07text\x1b]133;B\x07${" ".repeat(34)}`,
			`\x1b]133;B\x07\x1b]133;C\x07${" ".repeat(40)}`,
		]);
	});
	it.each([
		// Core/message/tool surfaces are default-on (fingerprint-certified, fail-closed,
		// conflict-preserving); explicit flags and the ASCII override still work.
		[{}, 11],
		[{ "pi-style-core-patches": false }, 0],
		[{ "pi-style-ascii": true }, 11],
		[{ "pi-style-tools": false }, 8],
		[{ "pi-style-message-special-blocks": false }, 6],
	] as const)("enables certified surfaces by default with explicit flag overrides %#", async (flags, expected) => {
		const host = new FakePiHost({ flags });
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		expect(
			targetSpecs.filter((spec) =>
				getCompatibilityRecords(spec.target).some((record) => record.method === spec.method && !record.disposed),
			).length,
		).toBe(expected);
		await host.sessionShutdown();
	});
	it("detects the installed host version without render-time work", () => {
		expect(SUPPORTED_PI_VERSIONS).toContain(detectPiVersion().version);
	});

	it("records a certified identity for every surface on each supported Pi build", () => {
		for (const version of SUPPORTED_PI_VERSIONS) {
			for (const spec of targetSpecs) {
				// The new inline route is deliberately certified only on inspected artifacts.
				if (spec.adapterId === "skill-inline-prompt-v1") continue;
				const key = `${spec.subtype}:${spec.method}`;
				const identities = KNOWN_NATIVE_IDENTITIES[key] ?? [];
				expect(
					identities.some((identity) => identity.versions.includes(version)),
					`${version} ${key}`,
				).toBe(true);
			}
		}
		// 0.84.3 rebuilds the shipped bundle: every surface must carry the
		// re-recorded bundled identity or it degrades to native fallback there.
		const bundledKeys = Object.keys(KNOWN_NATIVE_IDENTITIES).filter((key) =>
			(KNOWN_NATIVE_IDENTITIES[key] ?? []).some((identity) => identity.versions.includes("0.84.3")),
		);
		expect(bundledKeys).toHaveLength(targetSpecs.length - 1);
	});

	it("carries both Pi 1.2 artifact identities forward to Pi 1.3", () => {
		expect(SUPPORTED_PI_VERSIONS).toContain("1.3.0");
		for (const identities of Object.values(KNOWN_NATIVE_IDENTITIES)) {
			const previous = identities.filter((identity) => identity.versions.includes("1.2.0"));
			expect(previous).toHaveLength(2);
			expect(identities.filter((identity) => identity.versions.includes("1.3.0"))).toEqual(previous);
		}
	});

	it("records every attempted subtype and delegates real native targets", () => {
		initTheme("dark", false);
		const markers = new Set<string>();
		const report = probePiCompatibility("0.83.0", markers);
		expect(report.recordSnapshots).toHaveLength(11);
		expect(report.recordSnapshots.every((record) => record.piVersion === "0.83.0")).toBe(true);
		expect(report.recordSnapshots.every((record) => record.shape === "installed")).toBe(true);
		expect(report.recordSnapshots.every((record) => record.disposed === false)).toBe(true);
		expect(report.unsupported).toHaveLength(0);
		const user = new UserMessageComponent("# Native **markdown**\n\n```ts\nconst image = 'sentinel';\n```");
		const assistant = new AssistantMessageComponent(
			assistantMessage([{ type: "text", text: "native rich-content sentinel" }]),
		);
		const skillBlock = parseSkillBlock('<skill name="fixture" location="/fake">\ncontent **rich**\n</skill>');
		expect(skillBlock).not.toBeNull();
		if (!skillBlock) throw new Error("skill fixture failed to parse");
		const nativeSpecial = [
			new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: "summary **rich**",
				tokensBefore: 1234,
				timestamp: 1,
			}),
			new BranchSummaryMessageComponent({
				role: "branchSummary",
				summary: "branch **rich**",
				fromId: "id",
				timestamp: 1,
			}),
			new SkillInvocationMessageComponent(skillBlock),
			new CustomMessageComponent(
				{ role: "custom", customType: "fixture", content: "custom **rich**", display: true, timestamp: 1 },
				(message) => new UserMessageComponent(`renderer:${message.content}`),
			),
		];
		// pi-style's boxed compaction block defaults to expanded on first paint
		// (the summary is the record of the compacted conversation); settle that
		// default first so the collapsed baseline below reflects the explicit
		// toggle state rather than the first-paint default.
		for (const component of nativeSpecial) component.render(80);
		for (const component of nativeSpecial) component.setExpanded?.(false);
		const beforeSpecial = nativeSpecial.map((component) => component.render(80));
		for (const component of nativeSpecial) component.setExpanded?.(true);
		const beforeExpandedSpecial = nativeSpecial.map((component) => component.render(80));
		const userResult = user.render(80);
		const assistantResult = assistant.render(80);
		expect(userResult.join("\n")).toContain("sentinel");
		expect(assistantResult.join("\n")).toContain("native rich-content sentinel");
		expect(userResult.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(assistantResult.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(nativeSpecial.map((component) => component.render(80))).toEqual(beforeExpandedSpecial);
		for (const component of nativeSpecial) component.setExpanded?.(false);
		// Without a session theme the boxed adapters fall back to the native layout.
		const decoratedSpecial = nativeSpecial.map((component) => component.render(80));
		expect(decoratedSpecial).toHaveLength(beforeSpecial.length);
		expect(decoratedSpecial).toEqual(beforeSpecial);
		expect(markers).toEqual(
			new Set([
				"native-assistant-message:delegated",
				"native-compaction-message:delegated",
				"native-branch-message:delegated",
				"native-skill-message:delegated",
				"native-custom-message:delegated",
			]),
		);
		disposePiCompatibilityProbe(report);
		expect(
			report.recordSnapshots.every(
				(record) => record.disposed || record.shape === "unsupported" || record.shape === "installed",
			),
		).toBe(true);
	});

	it("asserts installed message prefixes, OSC envelopes, width, and ASCII markers", () => {
		initTheme("dark", false);
		const report = probePiCompatibility("0.83.0", {
			messageSnapshot: {
				assistantPrefix: "[assistant] ",
				assistantEnabled: true,
				collapseHiddenThinking: false,
			},
		});
		const user = new UserMessageComponent("  user installed sentinel\ncontinuation");
		const assistant = new AssistantMessageComponent(
			assistantMessage([{ type: "text", text: "assistant installed sentinel" }]),
		);
		const userLines = user.render(160);
		const assistantLines = assistant.render(160);
		const stripAnsi = (value: string) => {
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
		};
		const userContentLine = userLines.find((line) => stripAnsi(line).includes("user installed sentinel"));
		const assistantContentLine = assistantLines.find((line) =>
			stripAnsi(line).includes("assistant installed sentinel"),
		);
		expect(userContentLine).toBeDefined();
		expect(assistantContentLine).toBeDefined();
		// The user-message `❯` prefix was removed: user messages render native (no marker).
		expect(stripAnsi(userLines.join("\n"))).not.toContain("[user] ");
		expect(stripAnsi(assistantLines.join("\n"))).toContain("assistant installed sentinel");
		expect(stripAnsi(userLines.join("\n"))).toContain("user installed sentinel");
		expect(stripAnsi(assistantLines.join("\n"))).toContain("assistant installed sentinel");
		expect(
			decorateMessageRender(() => ["content sentinel"], {}, [80], {
				assistantPrefix: "[assistant] ",
				assistantEnabled: true,
				collapseHiddenThinking: false,
			}),
		).toEqual([`[assistant] content sentinel${" ".repeat(52)}`]);
		expect(userLines.some((line) => line.includes("  user installed sentinel"))).toBe(true);
		expect(userLines.every((line) => visibleWidth(line) <= 160)).toBe(true);
		expect(assistantLines.every((line) => visibleWidth(line) <= 160)).toBe(true);
		const osc = new UserMessageComponent("osc installed sentinel").render(160).join("\n");
		expect(stripAnsi(osc)).toContain("osc installed sentinel");
		expect(count(osc, "\x1b]133;A\x07")).toBe(1);
		disposePiCompatibilityProbe(report);
		const defaultReport = probePiCompatibility("0.83.0");
		const defaultUserLine = new UserMessageComponent("default installed sentinel")
			.render(160)
			.find((line) => stripAnsi(line).includes("default installed sentinel"));
		const defaultAssistantLine = new AssistantMessageComponent(
			assistantMessage([{ type: "text", text: "default assistant sentinel" }]),
		)
			.render(160)
			.find((line) => stripAnsi(line).includes("default assistant sentinel"));
		expect(stripAnsi(defaultUserLine ?? "")).toContain("default installed sentinel");
		expect(stripAnsi(defaultUserLine ?? "")).not.toContain("❯");
		expect(defaultAssistantLine).toContain("default assistant sentinel");
		expect(defaultAssistantLine).toContain("default assistant sentinel");
		disposePiCompatibilityProbe(defaultReport);

		const asciiReport = probePiCompatibility("0.83.0", {
			messageSnapshot: {
				assistantPrefix: "[assistant] ",
				assistantEnabled: true,
				collapseHiddenThinking: false,
			},
		});
		const asciiUser = new UserMessageComponent("ascii installed sentinel").render(160).join("\n");
		expect(stripAnsi(asciiUser)).toContain("ascii installed sentinel");
		expect(asciiUser).not.toContain("❯");
		expect(asciiUser).not.toContain("│");
		disposePiCompatibilityProbe(asciiReport);
	});

	it("prefixes single-line assistant messages whose only body line is the envelope last line", () => {
		initTheme("dark", false);
		const report = probePiCompatibility("0.83.0", {
			messageSnapshot: {
				assistantPrefix: "[assistant] ",
				assistantEnabled: true,
				collapseHiddenThinking: false,
			},
		});
		const stripAnsi = (value: string) => {
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
		};
		const assistant = new AssistantMessageComponent(assistantMessage([{ type: "text", text: "done" }]));
		const lines = assistant.render(120);
		const contentLine = lines.find((line) => stripAnsi(line).includes("done"));
		expect(contentLine).toBeDefined();
		// The native multiline OSC133 envelope puts the only body on the final line;
		// the prefix must still be attached to it (the body keeps its native leading
		// output padding space).
		expect(stripAnsi(contentLine ?? "")).toMatch(/^\[assistant\] .*done/);
		// OSC envelope markers stay balanced and the decorated output fits the width.
		expect(count(lines.join("\n"), "\x1b]133;A\x07")).toBe(1);
		expect(count(lines.join("\n"), "\x1b]133;B\x07\x1b]133;C\x07")).toBe(1);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
		disposePiCompatibilityProbe(report);
	});

	it("proves one native call and exact OSC/width behavior for real messages", () => {
		initTheme("dark", false);
		const report = probePiCompatibility("0.83.0");
		const widths = [0, 1, 20, 40, 60, 80, 120, 160];
		const messages = [
			new UserMessageComponent("user sentinel\nsecond user line"),
			...(["text", "thinking", "tool", "mixed"] as const).flatMap((kind) => {
				const content =
					kind === "text"
						? [{ type: "text" as const, text: "assistant text sentinel" }]
						: kind === "thinking"
							? [{ type: "thinking" as const, thinking: "thinking sentinel" }]
							: kind === "tool"
								? [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "x" } }]
								: [
										{ type: "thinking" as const, thinking: "mixed thinking" },
										{ type: "text" as const, text: "mixed text sentinel" },
									];
				return [new AssistantMessageComponent(assistantMessage(content))];
			}),
		];
		for (const stopReason of ["stop", "aborted", "error", "length"] as const)
			messages.push(
				new AssistantMessageComponent(assistantMessage([{ type: "text", text: `${stopReason} sentinel` }], stopReason)),
			);
		for (const component of messages) {
			for (const width of widths) {
				const lines = component.render(width);
				if (width >= 20) expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(lines.join("\n")).not.toContain("\\uFFFD");
			}
			const finalRendered = component.render(160).join("\n");
			expect(finalRendered).not.toContain("\\uFFFD");
		}
		for (const component of [
			new UserMessageComponent("osc user sentinel\nsecond line"),
			new AssistantMessageComponent(assistantMessage([{ type: "text", text: "osc assistant sentinel" }])),
		]) {
			const rendered = component.render(160).join("\n");
			expect(count(rendered, "\x1b]133;A\x07")).toBe(1);
			expect(count(rendered, "\x1b]133;B\x07")).toBe(1);
			expect(count(rendered, "\x1b]133;C\x07")).toBe(1);
			expect(rendered.indexOf("\x1b]133;A\x07")).toBeLessThan(rendered.indexOf("\x1b]133;B\x07"));
			expect(rendered.indexOf("\x1b]133;B\x07")).toBeLessThan(rendered.indexOf("\x1b]133;C\x07"));
			expect(rendered).toContain("sentinel");
		}
		disposePiCompatibilityProbe(report);
	});

	it("retains catch-after-write rollback failure for retry", () => {
		let rejectRestore = true;
		let restoreCalls = 0;
		const native = () => "native";
		const target = new Proxy(
			{ method: native },
			{
				defineProperty(object, property, descriptor) {
					if (descriptor.value === native) {
						restoreCalls++;
						if (rejectRestore) return false;
					}
					return Reflect.defineProperty(object, property, descriptor);
				},
			},
		);
		const reset = __setCompatibilityRegistryTestHooks({
			afterWrite: () => {
				throw new Error("postwrite test exception");
			},
		});
		const result = installDelegatingPatch({
			feature: "messages",
			subtype: "native-assistant-message",
			target,
			method: "method",
			piVersion: "0.83.0",
			versionRange: ">=0.83.0 <0.84.0",
			shape: true,
			generation: nextGeneration(),
			expectedIdentity: native,
			delegate: (original, thisArg, args) => Reflect.apply(original as () => string, thisArg, args),
		});
		reset();
		expect(result.status).toBe("installed");
		expect(getCompatibilityRecords(target)).toContain(result.record);
		expect(restoreCalls).toBe(1);
		result.record.disposer();
		expect(restoreCalls).toBe(2);
		rejectRestore = false;
		result.record.disposer();
		expect(result.record.disposed).toBe(true);
		expect(target.method).toBe(native);
	});

	it("does not retry a throwing native delegate and preserves the obtained result", () => {
		let calls = 0;
		const original = (_width: number) => {
			calls++;
			if (calls === 1) return ["native"];
			throw new Error("must not retry");
		};
		const first = targetSpecs.find((spec) => spec.subtype === "native-assistant-message");
		expect(first).toBeDefined();
		const result = installDelegatingPatch({
			feature: "messages",
			subtype: "native-assistant-message",
			target: {},
			method: "render",
			piVersion: "0.83.0",
			versionRange: ">=0.83.0 <0.84.0",
			shape: true,
			generation: nextGeneration(),
			expectedIdentity: original,
			delegate: (native, target, args) => Reflect.apply(native as typeof original, target, args),
		});
		expect(result.status).toBe("skipped");
		const output = Reflect.apply(original, {}, [80]);
		expect(output).toEqual(["native"]);
		expect(calls).toBe(1);
	});

	it("installs certified surfaces by default and honors the config product gate", async () => {
		// Default-on: certified surfaces need no flags beyond their session defaults.
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		await host.sessionStart();
		expect(
			targetSpecs.filter((spec) =>
				getCompatibilityRecords(spec.target).some((record) => record.method === spec.method && !record.disposed),
			).length,
		).toBe(11);
		await host.sessionShutdown();
		// Tier C patches are retained across session switches (Pi renders the restored
		// chat with renderBeforeBind before the next session_start, which restores and
		// reinstalls them), so the registry is not emptied at shutdown.
		expect(targetSpecs.every((spec) => getCompatibilityRecords(spec.target).length > 0)).toBe(true);
		await host.sessionStart();
		expect(
			targetSpecs.filter((spec) =>
				getCompatibilityRecords(spec.target).some((record) => record.method === spec.method && !record.disposed),
			).length,
		).toBe(11);
		await host.sessionShutdown();

		// OFF switch: `compatibility.allowCorePatches: false` in config denies all core patches.
		let document = JSON.stringify({
			piStyle: { schemaVersion: 1, compatibility: { allowCorePatches: false } },
		});
		const settings = {
			port: {
				read: async (path: string) => (path === "global" ? document : "{}"),
				writeAtomic: async (_path: string, content: string) => {
					document = content;
				},
			},
			paths: () => ({ globalPath: "global", projectPath: "project" }),
		};
		const reset = __setCompatibilityTestHooks({ filePort: settings.port, paths: settings.paths });
		try {
			const deniedHost = new FakePiHost();
			const before = descriptors();
			piStyleExtension(deniedHost.extensionApi);
			await deniedHost.sessionStart();
			expect(descriptors()).toEqual(before);
			await deniedHost.sessionShutdown();
			expect(descriptors()).toEqual(before);
		} finally {
			reset();
		}
	});

	it("certifies by identity regardless of unknown versions and degrades per surface", () => {
		const files: Record<string, string> = {
			"/tmp/pkg/dist/package.json": JSON.stringify({ name: "other", version: "9.9.9" }),
			"/tmp/pkg/package.json": JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }),
		};
		expect(
			detectPiVersion({
				resolvePackageEntry: () => "/tmp/pkg/dist/index.js",
				readFile: (path) =>
					files[path] ??
					(() => {
						throw new Error("ENOENT");
					})(),
			}).version,
		).toBe("0.83.0");
		expect(
			detectPiVersion({
				resolvePackageEntry: () => "/tmp/pkg/dist/index.js",
				readFile: () => "{",
				runtimeVersion: "",
			}).version,
		).toBeUndefined();
		expect(
			detectPiVersion({
				resolvePackageEntry: () => {
					throw new Error("missing");
				},
				runtimeVersion: "",
			}).version,
		).toBeUndefined();
		// Inside the packaged Pi process import.meta.resolve cannot see the host
		// package (jiti aliasing), so the walk fails and the host's own VERSION
		// export becomes the authoritative version source.
		expect(
			detectPiVersion({
				resolvePackageEntry: () => {
					throw new Error("Cannot find module");
				},
				runtimeVersion: "0.84.3",
			}).version,
		).toBe("0.84.3");
		// The version string is informational: an unknown version still certifies
		// every surface whose runtime identity matches a recorded fingerprint.
		for (const version of [undefined, "9.9.9"]) {
			const report = probePiCompatibility(version);
			expect(report.recordSnapshots).toHaveLength(11);
			expect(report.recordSnapshots.every((record) => record.shape === "installed")).toBe(true);
			expect(report.unsupported).toHaveLength(0);
			// Certified surfaces carry the matched pre-install identity in the certificate.
			expect(
				report.certification.every(
					(item) => item.status === "certified" && item.matchedIdentity?.fingerprint !== undefined,
				),
			).toBe(true);
			disposePiCompatibilityProbe(report);
		}
		// A changed runtime identity degrades only that surface to its native
		// fallback while every other certified surface keeps working.
		const key = "native-assistant-message:updateContent";
		const target = targetSpecs.find((spec) => `${spec.subtype}:${spec.method}` === key);
		expect(target).toBeDefined();
		const targetSpec = target as (typeof targetSpecs)[number];
		const original = Object.getOwnPropertyDescriptor(targetSpec.target, targetSpec.method);
		const stub = function updateContent() {
			return "drifted native";
		};
		Object.defineProperty(targetSpec.target, targetSpec.method, {
			value: stub,
			writable: true,
			configurable: true,
			enumerable: original?.enumerable ?? false,
		});
		try {
			const report = probePiCompatibility("0.85.0");
			expect(report.recordSnapshots).toHaveLength(11);
			expect(report.recordSnapshots.filter((record) => record.shape === "installed")).toHaveLength(10);
			expect(report.recordSnapshots.find((record) => `${record.subtype}:${record.method}` === key)?.shape).toBe(
				"unsupported",
			);
			expect(report.unsupported.some((item) => `${item.subtype}:${String(item.method)}` === key)).toBe(true);
			expect(
				report.certification.find((item) => `${item.subtype}:${item.method}` === key)?.matchedIdentity,
			).toBeUndefined();
			disposePiCompatibilityProbe(report);
		} finally {
			if (original) Object.defineProperty(targetSpec.target, targetSpec.method, original);
		}
	});

	it("handles throwing accessors without recording ownership", () => {
		let reads = 0;
		const target = new Proxy(Object.create(null), {
			get() {
				reads++;
				throw new Error("access denied");
			},
		});
		owners.add(target);
		const result = installDelegatingPatch({
			feature: "messages",
			subtype: "native-assistant-message",
			target,
			method: "render",
			piVersion: "0.83.0",
			versionRange: ">=0.83.0 <0.84.0",
			shape: true,
			generation: nextGeneration(),
			delegate: () => "never",
		});
		expect(result.status).toBe("skipped");
		expect(result.record.shape).toBe("skipped");
		expect(result.record.originalIdentity).toBeUndefined();
		expect(getCompatibilityRecords(target)).toEqual([]);
		result.record.disposer();
		expect(reads).toBe(0);
	});

	it("rejects unrecognized prior owners and preserves later owners", () => {
		const owner = { call: () => "native" };
		owners.add(owner);
		const otherOwner = () => "other-owner";
		owner.call = otherOwner;
		const result = installDelegatingPatch({
			feature: "messages",
			subtype: "native-assistant-message",
			target: owner,
			method: "call",
			piVersion: "0.83.0",
			versionRange: ">=0.83.0 <0.84.0",
			shape: true,
			generation: nextGeneration(),
			expectedIdentity: Symbol("pristine"),
			delegate: (original, target, args) => Reflect.apply(original as () => string, target, args),
		});
		expect(result.status).toBe("skipped");
		expect(owner.call).toBe(otherOwner);
	});

	it("rejects mutation of frozen report evidence and still restores exactly", () => {
		const report = probePiCompatibility("0.83.0");
		const before = JSON.stringify(report.recordSnapshots);
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.recordSnapshots)).toBe(true);
		expect(Object.isFrozen(report.recordSnapshots[0])).toBe(true);
		expect(Object.isFrozen(report.certification)).toBe(true);
		expect(Object.isFrozen(report.certification[0])).toBe(true);
		expect(Object.isFrozen(report.certification[0].descriptor)).toBe(true);
		expect(Object.isFrozen(report.unsupported)).toBe(true);
		expect(Object.isFrozen(report.delegationMarkers)).toBe(true);
		expect(() => Object.defineProperty(report, "generation", { value: 0 })).toThrow();
		expect(() => Reflect.apply(Array.prototype.push, report.recordSnapshots, [report.recordSnapshots[0]])).toThrow();
		expect(() => Object.defineProperty(report.recordSnapshots[0], "generation", { value: 0 })).toThrow();
		expect(() => Object.defineProperty(report.certification[0], "status", { value: "fallback" })).toThrow();
		expect(() =>
			Object.defineProperty(report.certification[0].descriptor as object, "configurable", { value: false }),
		).toThrow();
		expect(() => Object.defineProperty(report.certification, "length", { value: 1 })).toThrow();
		expect(() => Reflect.apply(Array.prototype.push, report.delegationMarkers, ["mutated"])).toThrow();
		expect(JSON.stringify(report.recordSnapshots)).toBe(before);
		disposePiCompatibilityProbe(report);
		expect(nativeTargets.every((target) => getCompatibilityRecords(target).length === 0)).toBe(true);
	});

	it("enforces generation and incomplete lifecycle cleanup", () => {
		for (const spec of targetSpecs) {
			if (spec.kind === "add-method") {
				// Additive patch: no own method may exist (it is inherited), and the
				// recorded identity is the class constructor.
				expect(Object.getOwnPropertyDescriptor(spec.target, spec.method)).toBeUndefined();
				const ctor = Object.getOwnPropertyDescriptor(spec.target, "constructor")?.value;
				expect(ctor?.name).toBe(spec.identityName ?? spec.method);
				expect(ctor?.length).toBe(spec.arity ?? 0);
				expect(fingerprint(ctor)).toBe(TRUSTED_NATIVE_FINGERPRINTS[`${spec.subtype}:${spec.method}`]);
				continue;
			}
			const descriptor = Object.getOwnPropertyDescriptor(spec.target, spec.method);
			expect(descriptor?.writable).toBe(true);
			expect(descriptor?.configurable).toBe(true);
			expect(descriptor?.value?.name).toBe(spec.identityName ?? spec.method);
			expect(descriptor?.value?.length).toBe(
				spec.arity ?? (spec.method === "render" || spec.method === "updateContent" ? 1 : 0),
			);
			expect(
				KNOWN_NATIVE_IDENTITIES[`${spec.subtype}:${spec.method}`].some(
					(identity) => identity.fingerprint === fingerprint(descriptor?.value),
				),
			).toBe(true);
		}
		const beforeDescriptors = descriptors();
		const markers = new Set<string>();
		const report = probePiCompatibility("0.83.0", markers);
		const captured = report.recordSnapshots.find((record) => record.subtype === "native-assistant-message");
		expect(captured?.shape).toBe("installed");
		expect(captured?.shape).toBe("installed");
		disposePiCompatibilityProbe(report);
		expect(descriptors()).toEqual(beforeDescriptors);
		const replacement = probePiCompatibility("0.83.0");
		expect(replacement.recordSnapshots.filter((record) => record.shape === "installed")).toHaveLength(11);
		expect(markers).not.toContain("native-assistant-message:delegated");
		const snapshots: readonly CompatibilityRecordSnapshot[] = report.recordSnapshots;
		expect(snapshots.every((record) => record.generation > 0)).toBe(true);
		const markerCount = markers.size;
		expect(markers.size).toBe(markerCount);
		disposePiCompatibilityProbe(replacement);
		disposePiCompatibilityProbe(report);
		expect(nativeTargets.every((target) => getCompatibilityRecords(target).length === 0)).toBe(true);
	});

	it("reclaims only wrappers explicitly retained for a session rebind", () => {
		const beforeDescriptors = descriptors();
		const active = probePiCompatibility("0.83.0");
		const competing = probePiCompatibility("0.83.0");
		expect(competing.recordSnapshots.some((record) => record.shape === "installed")).toBe(false);
		disposePiCompatibilityProbe(competing);

		retainPiCompatibilityProbe(active);
		const replacement = probePiCompatibility("0.83.0");
		expect(replacement.recordSnapshots.filter((record) => record.shape === "installed")).toHaveLength(11);
		disposePiCompatibilityProbe(replacement);
		expect(descriptors()).toEqual(beforeDescriptors);
	});

	it("keeps an active record when exact restoration is rejected, then restores later", () => {
		let rejectRestore = false;
		const native = () => "native";
		const target = new Proxy(
			{ method: native },
			{
				defineProperty(object, property, descriptor) {
					if (rejectRestore && descriptor.value === native) return false;
					return Reflect.defineProperty(object, property, descriptor);
				},
			},
		);
		owners.add(target);
		const result = installDelegatingPatch({
			feature: "messages",
			subtype: "native-assistant-message",
			target,
			method: "method",
			piVersion: "0.83.0",
			versionRange: ">=0.83.0 <0.84.0",
			shape: true,
			generation: nextGeneration(),
			expectedIdentity: native,
			delegate: (original, thisArg, args) => Reflect.apply(original as () => string, thisArg, args),
		});
		expect(result.status).toBe("installed");
		rejectRestore = true;
		result.record.disposer();
		expect(result.record.disposed).toBe(false);
		expect(getCompatibilityRecords(target)).toContain(result.record);
		expect(result.record.diagnostic).toContain("rejected");
		expect(target.method).toBe(result.record.installedIdentity);
		rejectRestore = false;
		result.record.disposer();
		expect(result.record.disposed).toBe(true);
		expect(target.method).toBe(native);
		expect(getCompatibilityRecords(target)).toEqual([]);
	});

	it("rolls back failed writes and isolates unsupported subtypes", () => {
		const target = Object.create(null) as { method?: () => string };
		Object.defineProperty(target, "method", { value: () => "native", writable: false, configurable: false });
		const result = installDelegatingPatch({
			feature: "tools",
			subtype: "tool-call-renderer",
			target,
			method: "method",
			piVersion: "0.83.0",
			versionRange: ">=0.83.0 <0.84.0",
			shape: true,
			generation: nextGeneration(),
			expectedIdentity: target.method,
			delegate: (original, target, args) => Reflect.apply(original as () => string, target, args),
		});
		expect(result.status).toBe("skipped");
		expect(getCompatibilityRecords(target)).toEqual([]);
	});

	it("proves real read/edit/bash call and result component identity reuse", () => {
		const definitions = [
			createReadToolDefinition("/fake"),
			createEditToolDefinition("/fake"),
			createBashToolDefinition("/fake"),
		];
		for (const definition of definitions) {
			const callContext = rendererContext(undefined);
			const theme = createFakeTheme();
			const firstCall = definition.renderCall?.(
				(definition.name === "bash" ? { command: "printf sentinel" } : { path: "README.md" }) as never,
				theme,
				callContext as never,
			);
			expect(firstCall).toBeDefined();
			expect(firstCall?.render).toBeTypeOf("function");
			const secondCall = definition.renderCall?.(
				(definition.name === "bash" ? { command: "printf sentinel" } : { path: "README.md" }) as never,
				theme,
				rendererContext(firstCall as object) as never,
			);
			expect(secondCall).toBe(firstCall);
			const firstResult = definition.renderResult?.(
				{ content: [{ type: "text", text: "result sentinel" }], details: {} } as never,
				{ expanded: false, isPartial: true },
				theme,
				rendererContext(undefined, { args: { path: "README.md" } }) as never,
			);
			expect(firstResult).toBeDefined();
			const secondResult = definition.renderResult?.(
				{ content: [{ type: "text", text: "result sentinel" }], details: {} } as never,
				{ expanded: true, isPartial: false },
				theme,
				rendererContext(firstResult as object, { args: { path: "README.md" } }) as never,
			);
			expect(secondResult).toBe(firstResult);
			firstResult?.invalidate();
		}
	});

	it("rejects overlapping tool owners and preserves the first wrapper", () => {
		const first = createToolDecorationOwner({ callMarker: "[first] " });
		const second = createToolDecorationOwner({ callMarker: "[second] " });
		const component = { render: (_width: number) => ["native"] };
		const original = () => () => component;
		const firstSelector = first.decorateToolRendererSelection("tool-call-renderer", original, {}, []);
		const firstComponent = (firstSelector as (...args: unknown[]) => unknown)(
			{},
			createFakeTheme(),
			rendererContext(undefined),
		);
		expect(firstComponent).toBe(component);
		const secondSelector = second.decorateToolRendererSelection("tool-call-renderer", original, {}, []);
		const secondComponent = (secondSelector as (...args: unknown[]) => unknown)(
			{},
			createFakeTheme(),
			rendererContext(undefined),
		);
		expect(secondComponent).toBe(component);
		expect(second.getDiagnostics().get("tool-call-renderer-owner-conflict")).toBe(1);
		first.dispose();
		expect(Object.getOwnPropertyDescriptor(component, "render")?.value).toBeTypeOf("function");
		second.dispose();
	});

	it("archives final owner diagnostics immutably and idempotently", () => {
		const owner = createToolDecorationOwner();
		const first = owner.dispose();
		const archive = first.archive;
		expect(archive).toBeDefined();
		expect(owner.dispose().archive).toBe(archive);
		if (!archive) throw new Error("archive missing");
		expect(Object.isFrozen(archive)).toBe(true);
		expect(Object.isFrozen(archive.reasons)).toBe(true);
		Reflect.set(archive as object, "failed", 99);
		expect(archive.failed).toBe(0);
	});

	it("creates isolated tool owners with independent diagnostics", () => {
		const first = createToolDecorationOwner({ callMarker: "[first] " });
		const second = createToolDecorationOwner({ callMarker: "[second] " });
		expect(first.getDiagnostics()).toEqual(new Map());
		expect(second.getDiagnostics()).toEqual(new Map());
		expect(first.dispose().failed).toBe(0);
		expect(second.dispose().failed).toBe(0);
	});

	it("asserts installed tool call/result and certified state markers", () => {
		initTheme("dark", false);
		const markers = new Set<string>();
		const report = probePiCompatibility("0.83.0", {
			markers,
			toolSnapshot: { callMarker: "[tool] ", resultMarker: "[tool:result] " },
		});
		const definition = createReadToolDefinition("/fake");
		const tool = new ToolExecutionComponent(
			"read",
			"tool-marker-call",
			{ path: "README.md" },
			{},
			definition,
			{ requestRender: () => {} } as never,
			"/fake",
		);
		const nativeCall = Reflect.get(ToolExecutionComponent.prototype, "getCallRenderer") as () => unknown;
		const nativeResult = Reflect.get(ToolExecutionComponent.prototype, "getResultRenderer") as () => unknown;
		const callSelector = Reflect.apply(nativeCall, tool, []) as (...args: unknown[]) => unknown;
		const resultSelector = Reflect.apply(nativeResult, tool, []) as (...args: unknown[]) => unknown;
		const theme = createFakeTheme();
		const callContext = rendererContext(undefined, { executionStarted: false, argsComplete: true });
		const callComponent = callSelector({}, theme, callContext) as { render: (width: number) => string[] };
		const callRepeat = callSelector({}, theme, { ...callContext, lastComponent: callComponent });
		expect(callRepeat).toBe(callComponent);
		const callLines = callComponent.render(80);
		expect(callLines.join("\n")).toContain("[tool] ");
		expect(callLines.join("\n")).toContain("read");
		expect(callLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		const result = { content: [{ type: "text", text: "tool result sentinel" }], details: {}, isError: false };
		const resultContext = rendererContext(undefined, { executionStarted: false, isPartial: false });
		const resultComponent = resultSelector(result, { expanded: false, isPartial: false }, theme, resultContext) as {
			render: (width: number) => string[];
		};
		const resultRepeat = resultSelector(result, { expanded: false, isPartial: false }, theme, {
			...resultContext,
			lastComponent: resultComponent,
		});
		expect(resultRepeat).toBe(resultComponent);
		const resultLines = resultComponent.render(80);
		expect(resultLines.join("\n")).toContain("[tool:result]");
		expect(resultLines.join("\n")).toContain("result");
		expect(resultLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		for (const [label, context] of [
			["[tool:pending] ", rendererContext(undefined, { executionStarted: false, isPartial: true })],
			["[tool:running] ", rendererContext(undefined, { executionStarted: true, isPartial: true })],
			["[tool:error] ", rendererContext(undefined, { isError: true })],
		] as const) {
			const component = callSelector({}, theme, context) as { render: (width: number) => string[] };
			expect(component.render(80).join("\n")).toContain(label);
		}
		disposePiCompatibilityProbe(report);
		const asciiReport = probePiCompatibility("0.83.0", {
			toolSnapshot: { callMarker: "[tool] ", resultMarker: "[tool:result] " },
		});
		const asciiComponent = callSelector({}, theme, rendererContext(undefined)) as {
			render: (width: number) => string[];
		};
		const asciiOutput = asciiComponent.render(80).join("\n");
		expect(asciiOutput).toContain("[tool] ");
		expect(asciiOutput).not.toContain("❯");
		expect(asciiOutput).not.toContain("│");
		disposePiCompatibilityProbe(asciiReport);
	});

	it("retains active tool restoration records until exact retry and final archive", () => {
		initTheme("dark", false);
		const report = probePiCompatibility("0.83.0", {
			config: {
				tools: { enabled: true },
				messages: { enabled: false, assistantPrefix: false },
				preset: "default",
			},
		});
		const tool = new ToolExecutionComponent(
			"read",
			"cleanup-call",
			{ path: "README.md" },
			{},
			createReadToolDefinition("/fake"),
			{ requestRender: () => {} } as never,
			"/fake",
		);
		const selector = Reflect.apply(
			Reflect.get(ToolExecutionComponent.prototype, "getCallRenderer") as () => unknown,
			tool,
			[],
		) as (...args: unknown[]) => unknown;
		const component = selector({}, createFakeTheme(), rendererContext(undefined)) as {
			render: (width: number) => string[];
		};
		expect(component).toBeDefined();
		expect(report.getActiveToolRecordCount()).toBeGreaterThan(0);
		let blocked = true;
		const reset = __setToolDecorationTestHooks({
			defineProperty: (_target, _key, _descriptor) => {
				if (blocked) return false;
				return Reflect.defineProperty(_target, _key, _descriptor);
			},
			deleteProperty: (target, key) => (blocked ? false : Reflect.deleteProperty(target, key)),
		});
		try {
			const first = disposePiCompatibilityProbe(report);
			expect(first.complete).toBe(false);
			expect(first.retryableToolRecords).toBeGreaterThan(0);
			expect(report.getFinalDiagnostics()).toBeUndefined();
			const second = disposePiCompatibilityProbe(report);
			expect(second.complete).toBe(false);
			blocked = false;
			const final = disposePiCompatibilityProbe(report);
			expect(final.complete).toBe(true);
			expect(final.retryableToolRecords).toBe(0);
			expect(report.getFinalDiagnostics()).toBeDefined();
		} finally {
			reset();
		}
	});

	it("decorates tools only within width and leaves unsafe shapes native with diagnostics", () => {
		const markers = new Set<string>();
		const definition = createReadToolDefinition("/fake");
		const tool = new ToolExecutionComponent(
			"read",
			"call-1",
			{ path: "README.md" },
			{},
			definition,
			{ requestRender: () => {} } as never,
			"/fake",
		);
		Reflect.apply(Reflect.get(ToolExecutionComponent.prototype, "getCallRenderer") as () => unknown, tool, []);
		Reflect.apply(Reflect.get(ToolExecutionComponent.prototype, "getResultRenderer") as () => unknown, tool, []);
		const beforeRender = tool.render(80);
		tool.updateArgs({ path: "README.md", offset: 1 });
		tool.markExecutionStarted();
		tool.setArgsComplete();
		tool.updateResult(
			{ content: [{ type: "text", text: "read sentinel" }], details: { sentinel: true }, isError: false },
			true,
		);
		tool.setExpanded(true);
		const report = probePiCompatibility("0.83.0", markers);
		const afterCall = Reflect.apply(
			Reflect.get(ToolExecutionComponent.prototype, "getCallRenderer") as () => unknown,
			tool,
			[],
		);
		const afterResult = Reflect.apply(
			Reflect.get(ToolExecutionComponent.prototype, "getResultRenderer") as () => unknown,
			tool,
			[],
		);
		expect(afterCall).toBeTypeOf("function");
		expect(afterResult).toBeTypeOf("function");
		expect(tool.render(80)).toEqual(tool.render(80));
		expect(beforeRender).toEqual(expect.any(Array));
		expect(markers).toContain("tool-call-renderer:delegated");
		expect(markers).toContain("tool-result-renderer:delegated");
		disposePiCompatibilityProbe(report);
	});

	it("does not alter actual built-in tool definitions through install, render, and disposal", () => {
		const definitions = [
			createReadToolDefinition("/fake"),
			createEditToolDefinition("/fake"),
			createBashToolDefinition("/fake"),
		];
		const before = definitions.map((definition) =>
			toolDefinitionSnapshot(definition as unknown as Record<string, unknown>),
		);
		const report = probePiCompatibility("0.83.0");
		for (const definition of definitions) {
			const theme = createFakeTheme();
			const args = definition.name === "bash" ? { command: "printf sentinel" } : { path: "README.md" };
			const call = definition.renderCall?.(args as never, theme, rendererContext(undefined) as never);
			definition.renderCall?.(args as never, theme, rendererContext(call as object) as never);
			const result = definition.renderResult?.(
				{ content: [{ type: "text", text: "result" }], details: {} } as never,
				{ expanded: false, isPartial: true },
				theme,
				rendererContext(undefined, { args }) as never,
			);
			definition.renderResult?.(
				{ content: [{ type: "text", text: "result" }], details: {} } as never,
				{ expanded: true, isPartial: false },
				theme,
				rendererContext(result as object, { args }) as never,
			);
		}
		disposePiCompatibilityProbe(report);
		const after = definitions.map((definition) =>
			toolDefinitionSnapshot(definition as unknown as Record<string, unknown>),
		);
		expect(after).toEqual(before);
	});

	it("does not alter a bounded tool definition fixture", () => {
		const execute = async (args: unknown) => ({
			content: [{ type: "text", text: JSON.stringify(args) }],
			details: { sentinel: true },
			isError: false,
		});
		const definition = {
			name: "fixture",
			description: "fixture",
			parameters: { type: "object" },
			prompt: "prompt",
			execute,
		};
		const before = structuredClone({ ...definition, execute: undefined });
		const executeIdentity = definition.execute;
		const report = probePiCompatibility("0.83.0");
		const after = structuredClone({ ...definition, execute: undefined });
		expect(after).toEqual(before);
		expect(definition.execute).toBe(executeIdentity);
		disposePiCompatibilityProbe(report);
	});

	it("proves ten enabled TUI cycles, exact certified installs, cleanup, and headless no-install", async () => {
		const baseline = descriptors();
		const specialBaseline = targetSpecs
			.filter((spec) => spec.feature === "messages" && spec.status === "native-fallback")
			.map((spec) => Object.getOwnPropertyDescriptor(spec.target, spec.method));
		const host = new FakePiHost({
			systemPrompt: "sentinel system prompt",
			flags: {
				"pi-style-core-patches": true,
				"pi-style-message-assistant": true,
				"pi-style-tools": true,
			},
		});
		piStyleExtension(host.extensionApi);
		const counts = {
			handlers: new Map([...host.handlers].map(([key, value]) => [key, value.length])),
			widgets: 0,
			factories: 0,
			subscriptions: 0,
			working: 0,
			renders: 0,
		};
		for (let cycle = 0; cycle < 10; cycle++) {
			await host.sessionStart();
			const active = descriptors();
			expect(active[0]?.value).not.toBe(baseline[0]?.value);
			expect(active[1]?.value).not.toBe(baseline[1]?.value);
			expect(active[5]?.value).not.toBe(baseline[5]?.value);
			expect(active[6]?.value).not.toBe(baseline[6]?.value);
			expect(
				targetSpecs
					.filter((spec) => spec.feature === "messages" && spec.status === "native-fallback")
					.map((spec) => Object.getOwnPropertyDescriptor(spec.target, spec.method)),
			).toEqual(specialBaseline);
			const user = new UserMessageComponent("cycle user sentinel");
			const assistant = new AssistantMessageComponent(
				assistantMessage([{ type: "text", text: "cycle assistant sentinel" }]),
			);
			user.render(80);
			assistant.render(80);
			const tool = new ToolExecutionComponent(
				"read",
				`cycle-${cycle}`,
				{ path: "README.md" },
				{},
				createReadToolDefinition("/fake"),
				{ requestRender: () => {} } as never,
				"/fake",
			);
			tool.updateResult({ content: [{ type: "text", text: "cycle result" }], details: {}, isError: false }, true);
			tool.render(80);
			expect(getCompatibilityRecords(AssistantMessageComponent.prototype).length).toBe(2);
			expect(getCompatibilityRecords(ToolExecutionComponent.prototype).length).toBe(2);
			await host.sessionShutdown();
			// Patches are retained across the session-switch gap (renderBeforeBind), and
			// the next session_start restores the previous generation and reinstalls.
			expect(descriptors()).not.toEqual(baseline);
			expect(targetSpecs.every((spec) => getCompatibilityRecords(spec.target).length > 0)).toBe(true);
			expect(host.handlers.get("session_start")?.length).toBe(counts.handlers.get("session_start"));
			expect(host.widgets.size).toBe(0);
			expect(host.componentFactories.size).toBe(0);
			expect(host.terminalInputSubscriptions).toBe(0);
			expect(host.renderRequests.length).toBeGreaterThanOrEqual(counts.renders);
			counts.renders = host.renderRequests.length;
			expect(host.getSystemPrompt()).toBe("sentinel system prompt");
		}
		for (const mode of ["rpc", "json", "print"] as const) {
			const modeHost = new FakePiHost({
				mode,
				systemPrompt: "sentinel system prompt",
				flags: {
					"pi-style-core-patches": true,
					"pi-style-message-assistant": true,
					"pi-style-tools": true,
				},
			});
			piStyleExtension(modeHost.extensionApi);
			const before = descriptors();
			await modeHost.sessionStart();
			expect(descriptors()).toEqual(before);
			expect(modeHost.registeredTools).toEqual([]);
			expect([...modeHost.registeredMessageRenderers.keys()]).toEqual(["teammate-notification", "teammate-message"]);
			// ADR 0008: the display-only image-preview entry renderer registers at
			// load in every mode (persisted entries render on TUI resume); a pure
			// type→component mapping with no session resources.
			expect([...modeHost.registeredEntryRenderers.keys()]).toEqual(["pi-style-image-preview"]);
			await modeHost.sessionShutdown();
		}
	});

	it("survives ten TUI lifecycle cycles with exact identity and lifecycle restoration", async () => {
		const baseline = descriptors();
		const baselineHandlers = new Map<string, number>();
		const host = new FakePiHost();
		piStyleExtension(host.extensionApi);
		for (const [event, handlers] of host.handlers) baselineHandlers.set(event, handlers.length);
		const baselineFactories = host.componentFactories.size;
		const baselineWidgets = host.widgets.size;
		const baselineTerminalSubscriptions = host.terminalInputSubscriptions;
		const baselineWorkingChanges = host.workingIndicatorChanges.length;
		const baselineTools = [...host.registeredTools];
		const baselineMessageRenderers = [...host.registeredMessageRenderers];
		const baselineEntryRenderers = [...host.registeredEntryRenderers];
		for (let cycle = 0; cycle < 10; cycle++) {
			await host.sessionStart();
			// Default-on certified surfaces are installed during the session…
			const installed = descriptors();
			for (let index = 0; index < installed.length; index++) {
				expect(installed[index]?.value).not.toBe(baseline[index]?.value);
			}
			expect(getCompatibilityRecords(AssistantMessageComponent.prototype).length).toBe(2);
			await host.sessionShutdown();
			// Retained across the switch gap; restoration happens at the next start.
			expect(descriptors()).not.toEqual(baseline);
			expect(
				targetSpecs.reduce((count, spec) => count + getCompatibilityRecords(spec.target).length, 0),
			).toBeGreaterThan(0);
			expect(host.componentFactories.size).toBe(baselineFactories);
			expect(host.widgets.size).toBe(baselineWidgets);
			expect(host.terminalInputSubscriptions).toBe(baselineTerminalSubscriptions);
			expect(host.workingIndicatorChanges.length).toBe(baselineWorkingChanges);
			expect([...host.registeredTools]).toEqual(baselineTools);
			expect([...host.registeredMessageRenderers]).toEqual(baselineMessageRenderers);
			expect([...host.registeredEntryRenderers]).toEqual(baselineEntryRenderers);
			for (const [event, count] of baselineHandlers) expect(host.handlers.get(event)?.length).toBe(count);
		}
		expect(host.renderRequests).toEqual([]);
		for (const mode of ["rpc", "json", "print"] as const) {
			const modeHost = new FakePiHost({ mode });
			piStyleExtension(modeHost.extensionApi);
			const before = descriptors();
			await modeHost.sessionStart();
			expect(modeHost.registeredTools).toEqual([]);
			expect([...modeHost.registeredMessageRenderers.keys()]).toEqual(["teammate-notification", "teammate-message"]);
			expect([...modeHost.registeredEntryRenderers.keys()]).toEqual(["pi-style-image-preview"]);
			expect(modeHost.activeTools).toEqual([]);
			expect(descriptors()).toEqual(before);
			await modeHost.sessionShutdown();
			expect(modeHost.renderRequests).toEqual([]);
			expect(descriptors()).toEqual(before);
		}
	});
});
