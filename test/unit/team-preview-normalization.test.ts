// Team transcript helpers (ADR 0012 §2): one shared preview collapse, model
// label tails, and duration/token formatting for every team surface.

import { describe, expect, it } from "vitest";
import {
	formatDuration,
	formatTokens,
	normalizeModelLabel,
	normalizePreview,
} from "../../extension-src/pi-style/features/tools/boxed/shared.js";

describe("formatDuration", () => {
	it("formats minutes with zero-padded seconds", () => {
		expect(formatDuration(123_000)).toBe("2m 03s");
		expect(formatDuration(62_400)).toBe("1m 02s");
	});

	it("formats bare seconds and hours", () => {
		expect(formatDuration(5_400)).toBe("5s");
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(3_600_000)).toBe("1h 00m");
		expect(formatDuration(3_723_000)).toBe("1h 02m");
	});

	it("omits invalid producer values silently", () => {
		expect(formatDuration(undefined)).toBeUndefined();
		expect(formatDuration("1200")).toBeUndefined();
		expect(formatDuration(Number.NaN)).toBeUndefined();
		expect(formatDuration(-5)).toBeUndefined();
	});
});

describe("formatTokens", () => {
	it("compacts to one decimal with magnitude suffixes", () => {
		expect(formatTokens(146_500)).toBe("↓146.5k");
		expect(formatTokens(1_000)).toBe("↓1k");
		expect(formatTokens(2_500_000)).toBe("↓2.5M");
		expect(formatTokens(7)).toBe("↓7");
	});

	it("omits invalid producer values silently", () => {
		expect(formatTokens(undefined)).toBeUndefined();
		expect(formatTokens("many")).toBeUndefined();
		expect(formatTokens(Number.POSITIVE_INFINITY * 0)).toBeUndefined();
	});
});

describe("normalizeModelLabel", () => {
	it("shows the tail after /", () => {
		expect(normalizeModelLabel("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
		expect(normalizeModelLabel("zhipu/glm-5.3-flash")).toBe("glm-5.3-flash");
		expect(normalizeModelLabel("bare-model")).toBe("bare-model");
	});

	it("fails closed on non-strings", () => {
		expect(normalizeModelLabel(undefined)).toBe("");
		expect(normalizeModelLabel(42)).toBe("");
	});
});

describe("normalizePreview", () => {
	it("drops heading-only lines, strips inline markdown, and drops empty lines", () => {
		expect(normalizePreview("## Findings\n\n**Bold** and `code` and __under__\n")).toBe("Bold and code and under");
	});

	it("compacts leading Key: value labeled lines with · and appends the first prose line after —", () => {
		expect(
			normalizePreview(
				"Type: review | Status: partial\nTeammate: @worker\n\nVerdict: undetermined — No actionable bugs in the diff.",
				{
					dropFields: ["Type", "Teammate"],
				},
			),
		).toBe("Status: partial · Verdict: undetermined — No actionable bugs in the diff.");
	});

	it("bounds the collapse with … +N lines", () => {
		expect(normalizePreview("Status: ok\nfirst prose\nsecond prose\nthird prose")).toBe(
			"Status: ok — first prose … +2 lines",
		);
	});

	it("drops record-shape fields via dropFields (pipe-separated segments count separately)", () => {
		expect(normalizePreview("Type: review | Status: completed\nBody text", { dropFields: ["Type", "Teammate"] })).toBe(
			"Status: completed — Body text",
		);
	});

	it("middle-clips long path tokens but leaves prose and URLs alone", () => {
		const longPath = `/very/${"deep/".repeat(12)}file-name.ts`;
		const preview = normalizePreview(`Wrote ${longPath} — see https://example.com/docs/section`);
		expect(preview).toContain("/very/../../../file-name.ts");
		expect(preview).not.toContain(longPath);
		expect(preview).toContain("https://example.com/docs/section");
	});

	it("falls back to cleaned verbatim lines for malformed input", () => {
		expect(normalizePreview(42)).toBe("");
		expect(normalizePreview("   \n\n  ")).toBe("");
		expect(normalizePreview("Plain line only")).toBe("Plain line only");
		const noisy = "Keep \u0007 this verbatim";
		expect(normalizePreview(noisy)).toBe("Keep   this verbatim");
	});
});
