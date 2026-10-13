import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../../extension-src/pi-style/domain/config-normalization.js";
import type { PiStyleConfig } from "../../extension-src/pi-style/domain/config-types.js";
import { StyledEditor } from "../../extension-src/pi-style/features/editor/index.js";
import { stripAnsi, truncateAnsi, visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";

function createEditor(editorConfig: PiStyleConfig["editor"] = {}) {
	const tui = { requestRender: vi.fn(), terminal: { rows: 24 } };
	const color = (text: string) => `\x1b[34m${text}\x1b[0m`;
	const theme = {
		borderColor: color,
		selectList: {
			selectedPrefix: color,
			selectedText: color,
			description: color,
			scrollInfo: color,
			noMatch: color,
		},
	};
	const keys = { matches: (data: string, action: string) => data === "\x1b" && action === "app.interrupt" };
	const editor = new StyledEditor(tui as never, theme as never, keys as never, {
		config: normalizeConfig({ editor: editorConfig }),
		snapshot: {},
		theme: theme as never,
		onSnapshot: () => {},
	});
	return { editor, tui };
}

// Pi owns the real loader. This double exposes only the native border API and
// lets tests advance its frame/message without an extension-owned timer.
function indicator(message = "Working") {
	const state = { frame: "⠹", message };
	const status = {
		renderInBorder: vi.fn((width: number) => truncateAnsi(`\x1b[35m${state.frame} ${state.message}\x1b[0m`, width, "")),
		renderSpinnerInBorder: vi.fn((width: number) => truncateAnsi(`\x1b[35m${state.frame}\x1b[0m`, width, "")),
		dispose: vi.fn(),
	};
	return {
		state,
		status,
		native: status as unknown as Parameters<StyledEditor["setWorkingStatusIndicator"]>[0],
	};
}

const frames = [
	{ style: "compact", frame: "line" },
	{ style: "boxed", frame: "auto" },
	{ style: "boxed", frame: "solid" },
	{ style: "boxed", frame: "halfblock" },
	{ style: "dock", frame: "rounded" },
	{ style: "dock", frame: "outline" },
	{ style: "dock", frame: "native" },
	{ style: "native", frame: "native" },
] as const;

describe("native working indicator in the styled editor", () => {
	it.each(frames)("embeds exactly one native spinner for $style/$frame at every width", (frame) => {
		const { editor } = createEditor(frame);
		const loader = indicator();
		expect(editor.embedWorkingStatus).toBe(true);
		editor.setText("draft");
		editor.setWorkingStatusIndicator(loader.native);
		for (const width of [0, 1, 4, 19, 20, 39, 40, 60, 80, 120]) {
			const lines = editor.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			if (width === 0) {
				expect(lines).toEqual([]);
				continue;
			}
			expect(stripAnsi(lines[0] ?? "")).toContain("⠹");
			expect(stripAnsi(lines.join("\n")).split("⠹")).toHaveLength(2);
			if (width >= 20) expect(stripAnsi(lines[0] ?? "")).toContain("Working");
		}
		expect(loader.status.dispose).not.toHaveBeenCalled();
	});

	it.each(frames)("matches the spinner foreground to the border for $style/$frame", (frame) => {
		const { editor } = createEditor(frame);
		const loader = indicator();
		editor.setWorkingStatusIndicator(loader.native);
		const line = editor.render(80)[0] ?? "";
		expect(line).toContain("\x1b[34m");
		expect(line).not.toContain("\x1b[35m");
		expect(stripAnsi(line)).toContain("⠹ Working");
	});

	it("tracks session border color changes for the status and narrow spinner", () => {
		const { editor } = createEditor({ style: "dock", frame: "rounded" });
		const loader = indicator();
		editor.setWorkingStatusIndicator(loader.native);
		editor.update({ editorBorderColor: "#123456" });
		const first = editor.render(80)[0] ?? "";
		expect(first).toContain("\x1b[38;2;18;52;86m── ⠹ Working");
		expect(first).not.toContain("\x1b[35m");
		editor.update({ editorBorderColor: "#abcdef" });
		expect(editor.render(80)[0]).toContain("\x1b[38;2;171;205;239m── ⠹ Working");
		// Very narrow layouts fall back to the native border color.
		const narrow = editor.render(4)[0] ?? "";
		expect(narrow).toContain("\x1b[34m");
		expect(narrow).not.toContain("\x1b[35m");
		expect(stripAnsi(narrow)).toContain("⠹");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(4);
	});

	it("uses the full available top-border width, not the padded text width", () => {
		const { editor } = createEditor({ style: "dock", frame: "rounded" });
		const loader = indicator("Thinking about a detailed answer");
		editor.focused = true;
		editor.setText("draft");
		editor.setWorkingStatusIndicator(loader.native);
		const spy = vi.spyOn(CustomEditor.prototype, "render");
		try {
			const lines = editor.render(80);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0]).toBeLessThan(78);
			expect(loader.status.renderInBorder).toHaveBeenCalledExactlyOnceWith(73);
			expect(lines[0]).toContain("\x1b[34m── ⠹ Thinking about a detailed answer");
			expect(lines[0]).not.toContain("\x1b[35m");
			expect(stripAnsi(lines[0] ?? "").startsWith("╭── ")).toBe(true);
			expect(stripAnsi(lines[0] ?? "").endsWith("╮")).toBe(true);
			expect(visibleWidth(lines[0] ?? "")).toBe(80);
			expect(lines.join("").split(CURSOR_MARKER)).toHaveLength(2);
			expect(stripAnsi(lines[1] ?? "")).toContain("❯ draft");
		} finally {
			spy.mockRestore();
		}
	});

	it("reflects native frame/message changes, replacement and removal without owning cleanup", () => {
		const { editor, tui } = createEditor();
		const loader = indicator();
		editor.setWorkingStatusIndicator(loader.native);
		expect(stripAnsi(editor.render(80)[0] ?? "")).toContain("⠹ Working");
		loader.state.frame = "⠸";
		loader.state.message = "Processing ── items";
		expect(stripAnsi(editor.render(80)[0] ?? "")).toContain("⠸ Processing ── items");
		const replacement = indicator("Working again");
		editor.setWorkingStatusIndicator(replacement.native);
		expect(stripAnsi(editor.render(80)[0] ?? "")).toContain("Working again");
		editor.setWorkingStatusIndicator(undefined);
		expect(stripAnsi(editor.render(80)[0] ?? "")).toBe(`╭${"─".repeat(78)}╮`);
		// Clearing the native status cannot make the extension start a redraw loop.
		const requests = tui.requestRender.mock.calls.length;
		editor.render(80);
		expect(tui.requestRender).toHaveBeenCalledTimes(requests);
		expect(loader.status.dispose).not.toHaveBeenCalled();
		expect(replacement.status.dispose).not.toHaveBeenCalled();
	});

	it("fits the session title beside native working status when space allows", () => {
		const { editor } = createEditor();
		editor.update({ sessionName: "Expand brand components" });
		const loader = indicator();
		editor.setWorkingStatusIndicator(loader.native);
		const line = stripAnsi(editor.render(100)[0] ?? "");
		expect(line).toContain("⠹ Working");
		expect(line).toContain("Expand brand components");
		expect(visibleWidth(line)).toBe(100);
		expect(stripAnsi(editor.render(40)[0] ?? "")).toContain("⠹ Working");
	});

	it("preserves the native hidden-line counter beside the spinner", () => {
		const { editor } = createEditor();
		const loader = indicator();
		editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
		editor.setWorkingStatusIndicator(loader.native);
		const lines = editor.render(100);
		expect(stripAnsi(lines[0] ?? "")).toContain("⠹ Working");
		expect(stripAnsi(lines[0] ?? "")).toContain("↑ 13 more");
		expect(stripAnsi(lines.join("\n"))).toContain("line 19");
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
		// On smaller widths Pi decides whether to retain only the spinner.
		const narrow = editor.render(40);
		expect(stripAnsi(narrow[0] ?? "")).toContain("⠹");
		expect(narrow.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it.each(frames.filter(({ style }) => style !== "native"))(
		"keeps native autocomplete and the cursor with a spinner for $style/$frame",
		async (frame) => {
			const { editor } = createEditor(frame);
			const loader = indicator();
			editor.focused = true;
			editor.setWorkingStatusIndicator(loader.native);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider([{ name: "demo", description: "Demo command" }], process.cwd()),
			);
			// Use real native provider/input, not a private autocomplete-state fixture.
			editor.onEscape = undefined;
			editor.handleInput("/");
			await vi.waitFor(() => expect(stripAnsi(editor.render(80).join("\n"))).toContain("Demo command"));
			const spy = vi.spyOn(CustomEditor.prototype, "render");
			try {
				const lines = editor.render(80);
				expect(spy).toHaveBeenCalledExactlyOnceWith(80);
				expect(stripAnsi(lines[0] ?? "")).toContain("⠹ Working");
				expect(stripAnsi(lines.join("\n")).split("⠹")).toHaveLength(2);
				expect(stripAnsi(lines.join("\n"))).toContain("❯ /");
				expect(stripAnsi(lines.join("\n"))).toContain("Demo command");
				expect(lines.join("")).toContain(CURSOR_MARKER);
				const bottom = stripAnsi(lines.at(-1) ?? "");
				if (frame.style === "boxed" && frame.frame !== "solid") {
					expect(bottom).toBe((frame.frame === "halfblock" ? "▀" : "━").repeat(80));
				} else if (frame.frame === "rounded") {
					expect(bottom).toBe(`╰${"─".repeat(78)}╯`);
				} else if (frame.frame === "outline") {
					expect(bottom).toBe(`└${"─".repeat(78)}┘`);
				} else {
					expect(bottom).toBe("─".repeat(80));
				}
				expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
			} finally {
				spy.mockRestore();
			}
		},
	);

	it("preserves native interrupt delegation while the indicator is embedded", () => {
		const { editor } = createEditor();
		const loader = indicator();
		const interrupt = vi.fn();
		editor.onEscape = interrupt;
		editor.setWorkingStatusIndicator(loader.native);
		editor.handleInput("\x1b");
		expect(interrupt).toHaveBeenCalledTimes(1);
		expect(loader.status.dispose).not.toHaveBeenCalled();
	});

	it("clears the scoped frame context after a native render failure", () => {
		const { editor } = createEditor();
		const spy = vi.spyOn(CustomEditor.prototype, "render").mockImplementationOnce(() => {
			throw new Error("native render failure");
		});
		try {
			expect(() => editor.render(80)).toThrow("native render failure");
			editor.configure(normalizeConfig({ editor: { style: "native" } }));
			const loader = indicator();
			editor.setWorkingStatusIndicator(loader.native);
			const lines = editor.render(60);
			expect(stripAnsi(lines[0] ?? "")).toMatch(/^── ⠹ Working /);
			expect(visibleWidth(lines[0] ?? "")).toBe(60);
		} finally {
			spy.mockRestore();
		}
	});

	it("retains the idle frame when an older native renderer does not invoke border hooks", () => {
		const { editor } = createEditor();
		const spy = vi.spyOn(CustomEditor.prototype, "render").mockReturnValue(["────", "draft", "────"]);
		try {
			const lines = editor.render(80);
			expect(stripAnsi(lines[0] ?? "")).toBe(`╭${"─".repeat(78)}╮`);
			expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});
});
