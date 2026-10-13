// Regression: Pi ≥ 1.2.0 validates theme JSON at startup against its theme
// schema, whose root sets `additionalProperties: false` — unknown top-level
// keys (like the `extras` object the bundled themes used to carry) make
// startup reject the theme. The bundled themes must stay schema-clean.
//
// Validation uses TypeBox (already a devDependency Pi itself generates these
// schemas from) compiling the SHIPPED JSON schema. The schema file is located
// through package resolution — never a machine-specific path — probing the
// 1.1+ `schemas/` location first and the pre-0.86 `dist/` location so the
// test holds against both older and newer dev-dependency runtimes.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Package root of the local pi-coding-agent dev dependency, via resolution. */
function piPackageRoot(): string {
	let directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	for (;;) {
		try {
			const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: string };
			if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
		} catch {
			// Package exports may place the entry below the package root; walk up.
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("pi-coding-agent package root not found for theme schema lookup");
}

/** Shipped theme schema: 1.1+ carries schemas/, older builds dist/modes/… . */
function loadShippedThemeSchema(): object {
	const root = piPackageRoot();
	for (const candidate of ["schemas/theme.schema.json", "dist/modes/interactive/theme/theme-schema.json"]) {
		try {
			return JSON.parse(readFileSync(join(root, candidate), "utf8")) as object;
		} catch {
			// Try the next known layout.
		}
	}
	throw new Error("no shipped theme schema found in the local pi-coding-agent package");
}

const themeFiles = readdirSync(join(repoRoot, "themes")).filter((name) => name.endsWith(".json"));

describe("bundled themes comply with Pi's theme schema", () => {
	it.each(themeFiles)("%s declares the canonical $schema URL and validates", (file) => {
		const theme = JSON.parse(readFileSync(join(repoRoot, "themes", file), "utf8")) as Record<string, unknown>;
		expect(theme.$schema).toBe("https://pi.dev/schemas/theme.schema.json");
		const validator = Compile(loadShippedThemeSchema());
		const errors = [...validator.Errors(theme)].map((error) => `${error.path}: ${error.message}`);
		expect(errors).toEqual([]);
	});

	it("the shipped schema rejects the extras key Pi ≥ 1.2 startup validation forbids", () => {
		const validator = Compile(loadShippedThemeSchema());
		const withExtras = { name: "probe", colors: {}, extras: { compactionBgColor: "#0f1216" } };
		expect(validator.Check(withExtras)).toBe(false);
	});
});
