import { getMarkdownTheme, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSpecialBlockTheme } from "../../extension-src/pi-style/features/messages/special-blocks.js";
import {
	type CompatibilityProbeReport,
	disposePiCompatibilityProbe,
	probePiCompatibility,
} from "../../extension-src/pi-style/pi/compatibility-probe.js";
import { stripAnsi, visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";
import { createFakeTheme } from "../helpers/fake-theme.js";

let report: CompatibilityProbeReport;
function host() {
	return {
		chatContainer: new Container(),
		toolOutputExpanded: false,
		outputPad: 1,
		getUserMessageText: (message: { content: string }) => message.content,
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
	};
}
function send(target: ReturnType<typeof host>, prompt: string) {
	const message = { role: "user", content: prompt };
	Reflect.apply(InteractiveMode.prototype.addMessageToChat, target, [message]);
	return message;
}
const skill = '<skill name="team-lead" location="/fake">\nSecret **instructions**\n</skill>';

describe("inline skill invocation", () => {
	beforeEach(() => {
		initTheme("dark", false);
		report = probePiCompatibility("0.85.0");
		setSpecialBlockTheme(createFakeTheme());
	});
	afterEach(() => {
		setSpecialBlockTheme(undefined);
		disposePiCompatibilityProbe(report);
	});

	it("joins badge and native Markdown prompt without changing the session message", () => {
		const target = host();
		const content = `${skill}\n\nPlease **implement** this with teammates.`;
		const message = send(target, content);
		expect(target.chatContainer.children).toHaveLength(1);
		const lines = target.chatContainer.render(80);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("[team-lead] Please implement this with teammates.");
		expect(text).not.toContain("Secret");
		expect(text).not.toContain("╭");
		expect(lines.join("\n")).toContain("\x1b]133;A\x07");
		expect(message.content).toBe(content);
	});

	it("keeps Ctrl+O expansion and prompt-first disclosure, including after rebuild", () => {
		const target = host();
		for (let i = 0; i < 2; i++) {
			target.chatContainer.clear();
			send(target, `${skill}\n\nImplement please`);
			const child = target.chatContainer.children[0] as unknown as { setExpanded(value: boolean): void };
			child.setExpanded(true);
			const text = stripAnsi(target.chatContainer.render(60).join("\n"));
			expect(text.indexOf("Implement please")).toBeLessThan(text.indexOf("skill instructions"));
			expect(text).toContain("│ Secret instructions");
			child.setExpanded(false);
			expect(stripAnsi(target.chatContainer.render(60).join("\n"))).not.toContain("Secret");
		}
	});

	it("preserves Markdown headings and fenced code in the prompt", () => {
		const target = host();
		send(target, `${skill}\n\n# Goal\n\n\`\`\`ts\nconst answer = 42;\n\`\`\``);
		const text = stripAnsi(target.chatContainer.render(80).join("\n"));
		expect(text).toContain("[team-lead] Goal");
		expect(text).toContain("const answer = 42;");
		expect(text).not.toContain("# Goal");
		expect(text).toContain("  const answer = 42;");
	});

	it("wraps long prompts and fits narrow terminals", () => {
		const target = host();
		send(target, `${skill}\n\n${"Nội dung dài với teammate. ".repeat(10)}`);
		for (const width of [12, 20, 40, 80]) {
			const lines = target.chatContainer.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(stripAnsi(lines.join("\n"))).toContain("teammate.");
		}
	});

	it("toggles by click", () => {
		const target = host();
		send(target, `${skill}\n\nImplement please`);
		target.chatContainer.render(60);
		expect(
			target.chatContainer.handleMouse({ type: "click", button: "left", x: 20, y: 1, width: 60, height: 20 } as never),
		).toBeUndefined();
		expect(
			target.chatContainer.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 60, height: 20 } as never)
				?.handled,
		).toBe(true);
		expect(stripAnsi(target.chatContainer.render(60).join("\n"))).toContain("Secret instructions");
	});

	it("keeps skill-only invocations compact and ordinary prompts native", () => {
		const target = host();
		send(target, skill);
		expect(stripAnsi(target.chatContainer.render(60).join("\n"))).toContain("[team-lead]");
		expect(stripAnsi(target.chatContainer.render(60).join("\n"))).not.toContain("╭");
		target.chatContainer.clear();
		send(target, "Ordinary **prompt**");
		expect(stripAnsi(target.chatContainer.render(60).join("\n"))).not.toContain("[team-lead]");
	});

	it("restores native presentation when the theme is removed", () => {
		const target = host();
		send(target, `${skill}\n\nImplement please`);
		target.chatContainer.render(60);
		setSpecialBlockTheme(undefined);
		target.chatContainer.invalidate();
		const text = stripAnsi(target.chatContainer.render(60).join("\n"));
		expect(text).toContain("[skill]");
		expect(text).not.toContain("[team-lead] Implement");
		expect(text).toContain("Implement please");
	});
});
