import { describe, expect, it } from "vitest";
import { isPiStyleDisabled } from "../../extension-src/pi-style/pi/cli-flags.js";

describe("process-only pi-style disable flag", () => {
	it.each([
		["--disable-pi-style"],
		["--disable-pi-style=true"],
		["--disable-pi-style=false"],
		["--disable-pi-style="],
		["--disable-pi-style=anything"],
		["--print", "--disable-pi-style", "--", "prompt"],
	])("recognizes boolean presence in %j", (...argv) => {
		expect(isPiStyleDisabled(argv)).toBe(true);
	});

	it.each([
		[],
		["--", "--disable-pi-style"],
		["--", "--disable-pi-style=false"],
		["--disable-pi-style-extra"],
		["--disable-pi-styles=true"],
		["disable-pi-style"],
		["--disable-pi-teams"],
		["--no-pi-style"],
		["--DISABLE-PI-STYLE"],
		["prompt --disable-pi-style"],
	])("ignores boundaries and nonmatches in %j", (...argv) => {
		expect(isPiStyleDisabled(argv)).toBe(false);
	});
});
