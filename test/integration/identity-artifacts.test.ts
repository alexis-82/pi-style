import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import {
	type CompatibilityProbeReport,
	disposePiCompatibilityProbe,
	KNOWN_NATIVE_IDENTITIES,
	probePiCompatibility,
	targetSpecs,
} from "../../extension-src/pi-style/pi/compatibility-probe.js";
import { stripAnsi } from "../../extension-src/pi-style/shared/ansi.js";

function fingerprintOf(value: unknown): string | undefined {
	if (typeof value !== "function") return undefined;
	let hash = 2166136261;
	for (const c of Function.prototype.toString.call(value)) {
		hash ^= c.charCodeAt(0);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Verifies every surface's runtime identity on a given pi build certifies
 * against the recorded registry, including name/arity/descriptor gates rather
 * than checking only the source hash and observed-version metadata.
 */
function certifyAgainst(module: Record<string, unknown>, version: string): string[] {
	const misses: string[] = [];
	for (const spec of targetSpecs) {
		const key = `${spec.subtype}:${spec.method}`;
		const proto = (module as Record<string, { prototype?: object }>)[
			spec.kind === "add-method" ? "BashExecutionComponent" : protoNameFor(key)
		]?.prototype;
		const descriptor = proto && Object.getOwnPropertyDescriptor(proto, spec.method);
		const value =
			spec.kind === "add-method"
				? proto && Object.getOwnPropertyDescriptor(proto, "constructor")?.value
				: descriptor?.value;
		const fp = fingerprintOf(value);
		const identities = KNOWN_NATIVE_IDENTITIES[key] ?? [];
		const shape =
			spec.kind === "add-method" ? descriptor === undefined : descriptor?.writable && descriptor.configurable;
		if (
			!shape ||
			!identities.some(
				(identity) =>
					identity.fingerprint === fp &&
					identity.name === value?.name &&
					identity.arity === value?.length &&
					identity.versions.includes(version),
			)
		)
			misses.push(
				`${version} ${key} fp=${fp ?? "none"} recorded=${identities.map((i) => `${i.fingerprint}@[${i.versions.join(",")}]`).join(" | ")}`,
			);
	}
	return misses;
}

function protoNameFor(key: string): string {
	if (key === "native-skill-message:addMessageToChat") return "InteractiveMode";
	const map: Record<string, string> = {
		"native-assistant-message": "AssistantMessageComponent",
		"native-compaction-transcript": "InteractiveMode",
		"native-compaction-message": "CompactionSummaryMessageComponent",
		"native-branch-message": "BranchSummaryMessageComponent",
		"native-skill-message": "SkillInvocationMessageComponent",
		"native-custom-message": "CustomMessageComponent",
		"tool-call-renderer": "ToolExecutionComponent",
		"tool-result-renderer": "ToolExecutionComponent",
	};
	return map[key.split(":")[0]] ?? "";
}

interface PiInstallCandidate {
	readonly label: string;
	readonly packageRoot: string;
}

/**
 * Discover every pi install whose bundle extensions can actually receive:
 * the repo-local dev dependency, the globally npm-installed CLI, and any `pi`
 * binary on PATH whose real location is not one of those. `command -v pi`
 * alone is NOT enough: vitest prepends `node_modules/.bin` to PATH, so the
 * dev-local install would shadow the globally installed CLI the user runs —
 * exactly how an unrecorded global bundle once slipped past this test.
 */
async function discoverPiInstalls(): Promise<PiInstallCandidate[]> {
	const { execSync } = await import("node:child_process");
	const { existsSync, realpathSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const candidates: PiInstallCandidate[] = [];
	const seen = new Set<string>();
	const consider = (packageRoot: string | undefined, label: string) => {
		if (!packageRoot || !existsSync(`${packageRoot}/dist/bundle/index.js`)) return;
		let real: string;
		try {
			real = realpathSync(`${packageRoot}/dist/bundle/index.js`);
		} catch {
			return;
		}
		if (seen.has(real)) return;
		seen.add(real);
		candidates.push({ label, packageRoot: real.slice(0, -"/dist/bundle/index.js".length) });
	};
	consider(fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url)), "local");
	try {
		const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		consider(`${globalRoot}/@earendil-works/pi-coding-agent`, "global npm");
	} catch {
		// npm unavailable (unusual CI): PATH fallback below still applies.
	}
	try {
		const piBin = execSync("command -v pi", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const real = realpathSync(piBin);
		const installRoot = real.match(/^(.*@earendil-works\/pi-coding-agent)\/dist\//)?.[1];
		consider(installRoot, "pi on PATH");
	} catch {
		// pi not installed/resolvable in this environment (e.g. CI): skip.
	}
	return candidates;
}

describe("recorded identity registry vs real pi artifacts", () => {
	it("certifies every surface against the local modular pi build", async () => {
		initTheme("dark", false);
		const local = (await import("@earendil-works/pi-coding-agent")) as unknown as Record<string, unknown>;
		const pkgJson = (await import("node:fs")).readFileSync(
			new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
			"utf8",
		);
		const localVersion = JSON.parse(pkgJson).version as string;
		expect(certifyAgainst(local, localVersion).join("\n")).toBe("");
	});

	it("certifies every surface against both artifact families of every discoverable pi install", async () => {
		const { readFileSync } = await import("node:fs");
		const { pathToFileURL } = await import("node:url");
		const installs = await discoverPiInstalls();
		if (installs.length === 0) return;
		const failures: string[] = [];
		for (const install of installs) {
			const pkg = JSON.parse(readFileSync(new URL("package.json", pathToFileURL(`${install.packageRoot}/`)), "utf8"));
			for (const entry of ["dist/index.js", "dist/bundle/index.js"]) {
				const artifact = (await import(pathToFileURL(`${install.packageRoot}/${entry}`).href)) as Record<
					string,
					unknown
				>;
				failures.push(
					...certifyAgainst(artifact, pkg.version as string).map((miss) => `[${install.label} ${entry}] ${miss}`),
				);
			}
		}
		expect(failures.join("\n")).toBe("");
	});

	it("installs, renders compact read paths and restores patches on actual modular and bundled hosts", async () => {
		const { readFileSync } = await import("node:fs");
		const { pathToFileURL } = await import("node:url");
		for (const install of await discoverPiInstalls()) {
			const version = JSON.parse(readFileSync(`${install.packageRoot}/package.json`, "utf8")).version as string;
			for (const entry of ["dist/index.js", "dist/bundle/index.js"]) {
				const artifact = (await import(
					pathToFileURL(`${install.packageRoot}/${entry}`).href
				)) as typeof import("@earendil-works/pi-coding-agent");
				const originals = targetSpecs.map((spec) => spec.target);
				let report: CompatibilityProbeReport | undefined;
				try {
					// Redirect only this isolated test's probe targets to the classes the
					// real host gives extensions. Restore both patches and targets below.
					for (const spec of targetSpecs) {
						const name =
							spec.kind === "add-method" ? "BashExecutionComponent" : protoNameFor(`${spec.subtype}:${spec.method}`);
						spec.target = (artifact as unknown as Record<string, { prototype: object }>)[name].prototype;
					}
					const before = targetSpecs.map((spec) => Object.getOwnPropertyDescriptor(spec.target, spec.method));
					artifact.initTheme("dark", false);
					report = probePiCompatibility(version, { toolSnapshot: { style: "compact-box" } });
					expect(report.unsupported, `${install.label} ${entry}`).toHaveLength(0);
					expect(report.certification.every((surface) => surface.status === "certified")).toBe(true);
					const path =
						"src/Modules/FuelManagement/TransportERP.Modules.FuelManagement.Application/FuelDispensings/Workflow/AcceptStageWorkflow.cs";
					const tool = new artifact.ToolExecutionComponent(
						"read",
						"actual-host-read",
						{ path, offset: 1 },
						{},
						artifact.createReadToolDefinition("/project"),
						undefined,
						"/project",
					);
					tool.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, isError: false });
					expect(stripAnsi(tool.render(80).join("\n"))).toContain("src/../../../AcceptStageWorkflow.cs:1");
					expect(disposePiCompatibilityProbe(report).complete).toBe(true);
					for (let index = 0; index < targetSpecs.length; index++) {
						const spec = targetSpecs[index];
						expect(Object.getOwnPropertyDescriptor(spec.target, spec.method)).toEqual(before[index]);
					}
				} finally {
					if (report) disposePiCompatibilityProbe(report);
					targetSpecs.forEach((spec, index) => {
						spec.target = originals[index];
					});
					resetBatchRegistry();
				}
			}
		}
	});
});
