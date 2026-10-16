import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../../extension-src/pi-style/domain/config-normalization.js";
import { GLYPHS, resolveTheme } from "../../extension-src/pi-style/domain/theme.js";

const environments = [
	{},
	{ PI_STYLE_NERD_FONTS: "1" },
	{ PI_STYLE_NERD_FONTS: "0" },
	{ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/resources" },
	...["iTerm.app", "WezTerm", "kitty", "ghostty", "Alacritty", "Warp"].map((TERM_PROGRAM) => ({ TERM_PROGRAM })),
];
const privateUse = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
	});
}

describe("portable built-in glyph policy", () => {
	it.each(["auto", "on", "off"])("ignores legacy font setting %s and terminal heuristics", (nerdFonts) => {
		for (const env of environments) {
			const theme = resolveTheme(undefined, normalizeConfig({ theme: { nerdFonts } }), env);
			expect(theme.mode).toBe("unicode");
			for (const name of Object.keys(GLYPHS.unicode) as (keyof typeof GLYPHS.unicode)[]) {
				expect(theme.glyph(name)).toBe(GLYPHS.unicode[name]);
			}
			const ascii = resolveTheme(undefined, normalizeConfig({ preset: "ascii", theme: { nerdFonts } }), env);
			expect(ascii.mode).toBe("ascii");
			expect(ascii.glyph("eventSettled")).toBe("*");
		}
	});

	it("preserves explicit user glyph overrides", () => {
		const theme = resolveTheme(undefined, normalizeConfig({ theme: { glyphs: { git: "branch" } } }));
		expect(theme.glyph("git")).toBe("branch");
	});

	it("contains no built-in private-use glyphs, including escaped code points", () => {
		const root = fileURLToPath(new URL("../../extension-src/", import.meta.url));
		for (const path of sourceFiles(root)) {
			const decoded = readFileSync(path, "utf8").replace(/\\u(?:\{([\da-f]+)\}|([\da-f]{4}))/gi, (_, braced, plain) =>
				String.fromCodePoint(Number.parseInt(braced ?? plain, 16)),
			);
			expect(decoded, path).not.toMatch(privateUse);
		}
	});
});
