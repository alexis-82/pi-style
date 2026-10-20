import { describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "../../extension-src/pi-style/app/render-scheduler.js";
import { createSnapshot, replaceSnapshot } from "../../extension-src/pi-style/app/snapshot.js";
import {
	DEFAULT_CONFIG,
	normalizeConfig,
	resolveConfig,
} from "../../extension-src/pi-style/domain/config-normalization.js";
import { detectGlyphMode, resolveTheme } from "../../extension-src/pi-style/domain/theme.js";
import { truncateAnsi, visibleWidth, wrapAnsi } from "../../extension-src/pi-style/shared/ansi.js";
import { DisposableStore } from "../../extension-src/pi-style/shared/disposable-store.js";

describe("configuration foundation", () => {
	it("applies precedence and ignores untrusted project config", () => {
		const result = resolveConfig({
			global: { enabled: false, theme: { nerdFonts: "off" } },
			project: { enabled: true },
			projectTrusted: false,
			environment: { PI_STYLE_DISABLED: "1" },
			session: { enabled: true },
		});
		expect(result.enabled).toBe(true);
		expect(result.theme.nerdFonts).toBe("off");
	});
	it("normalizes invalid values and preserves explicit empty arrays", () => {
		const result = normalizeConfig({
			placement: "bad",
			tools: { maxCollapsedLines: -2 },
			statusLine: { layout: { left: [] } },
		});
		expect(result.placement).toBe(DEFAULT_CONFIG.placement);
		expect(result.tools.maxCollapsedLines).toBe(10);
		expect(result.statusLine.layout.left).toEqual([]);
	});
});

describe("runtime primitives", () => {
	it("disposes in reverse order and only once", async () => {
		const order: number[] = [];
		const store = new DisposableStore();
		store.addCallback(() => {
			order.push(1);
		});
		store.addCallback(() => {
			order.push(2);
		});
		await store.dispose();
		await store.dispose();
		expect(order).toEqual([2, 1]);
	});
	it("coalesces scheduled updates and cancels on shutdown", () => {
		vi.useFakeTimers();
		const renders: number[] = [];
		const scheduler = new RenderScheduler({ requestRender: () => renders.push(1) }, 1);
		scheduler.schedule("coalesced");
		scheduler.schedule("coalesced");
		vi.advanceTimersByTime(16);
		expect(renders).toHaveLength(1);
		scheduler.schedule("delayed-retry");
		scheduler.cancel();
		vi.advanceTimersByTime(200);
		expect(renders).toHaveLength(1);
		vi.useRealTimers();
	});
	it("rejects stale snapshot replacement", () => {
		const snapshot = createSnapshot(2);
		expect(replaceSnapshot(snapshot, 1, { model: "old" })).toBe(snapshot);
		const next = replaceSnapshot(snapshot, 2, { model: "new" });
		expect(next.revision).toBe(1);
		expect(next.model).toBe("new");
	});
});

describe("theme and ANSI foundation", () => {
	it("resolves fallback, glyph modes, and no-color", () => {
		const config = normalizeConfig({ theme: { nerdFonts: "on", colors: { accent: "red" } } });
		const theme = resolveTheme({ fg: () => "active" }, config, { NO_COLOR: "1" });
		expect(theme.mode).toBe("unicode");
		expect(theme.color("accent")).toBe("");
		expect(theme.glyph("git")).toBe("⎇");
		expect(detectGlyphMode(normalizeConfig({ preset: "ascii" }))).toBe("ascii");
	});
	it("keeps ANSI out of visible width and fits truncation/wrapping", () => {
		const value = "\x1b[31mhello\x1b[0m";
		expect(visibleWidth(value)).toBe(5);
		expect(visibleWidth(truncateAnsi(value, 3))).toBe(3);
		expect(wrapAnsi("one two three", 5).every((line) => visibleWidth(line) <= 5)).toBe(true);
	});
	it("measures wide characters by cell, not by code unit, when truncating", () => {
		// Two cells per CJK glyph: a code-unit budget would keep twice the text
		// and overflow the frame the caller measured against.
		const wide = "[u] 检索渠道团队知识库并返回可核验答案；当用户询问模块、接口、流程、仓库影响、平台关系";
		for (const width of [1, 2, 5, 17, 40, 80]) {
			expect(visibleWidth(truncateAnsi(wide, width, ""))).toBeLessThanOrEqual(width);
			expect(visibleWidth(truncateAnsi(wide, width))).toBeLessThanOrEqual(width);
		}
		expect(visibleWidth(truncateAnsi("\x1b[2m检索渠道\x1b[0m", 5, ""))).toBeLessThanOrEqual(5);
		expect(truncateAnsi("检索渠道", 8, "")).toContain("检索渠道");
	});
});
