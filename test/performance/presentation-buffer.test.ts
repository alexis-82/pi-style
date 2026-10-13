import { describe, expect, it } from "vitest";
import { AssistantPresentationBuffer } from "../../extension-src/pi-style/features/messages/presentation-buffer.js";

function fixture(enabled = true) {
	const buffer = new AssistantPresentationBuffer();
	buffer.enabled = enabled;
	const instance = { lastMessage: undefined as unknown, isStreaming: false, hasToolCalls: false, contentContainer: {} };
	let rebuilds = 0;
	let rendered = "";
	const update = (text: string, streaming?: boolean, stopReason?: string) => {
		const message = { content: [{ type: "text", text }], stopReason };
		buffer.update(instance, [message, streaming], () => {
			rebuilds++;
			instance.lastMessage = message;
			if (streaming !== undefined) instance.isStreaming = streaming;
			rendered = text;
		});
	};
	return {
		buffer,
		instance,
		update,
		get rebuilds() {
			return rebuilds;
		},
		get rendered() {
			return rendered;
		},
	};
}

describe("frame-aligned assistant presentation", () => {
	it("renders first update immediately and only rebuilds latest delta at the frame", () => {
		const f = fixture();
		for (let i = 0; i < 1000; i++) f.update(String(i), true);
		expect(f.rebuilds).toBe(1);
		expect(f.instance.lastMessage).toMatchObject({ content: [{ text: "999" }] });
		f.buffer.render(f.instance, 80, () => [f.rendered]);
		expect(f.rebuilds).toBe(2);
		expect(f.rendered).toBe("999");
	});

	it.each(["stop", "aborted", "error", "length"])("flushes terminal %s without a stale pending rebuild", (reason) => {
		const f = fixture();
		f.update("first", true);
		f.update("pending", true);
		f.update("final", false, reason);
		f.buffer.flushAll();
		expect(f.rebuilds).toBe(2);
		expect(f.rendered).toBe("final");
		expect(f.instance.isStreaming).toBe(false);
	});

	it("rebuilds internal invalidate/visibility updates synchronously", () => {
		const f = fixture();
		f.update("first", true);
		f.update("latest", true);
		f.update("changed thinking");
		f.buffer.flushAll();
		expect(f.rebuilds).toBe(2);
		expect(f.rendered).toBe("changed thinking");
	});

	it("flushes pending content on disposal, then delegates without buffering", () => {
		const f = fixture();
		f.update("first", true);
		f.update("latest", true);
		f.buffer.dispose();
		expect(f.rendered).toBe("latest");
		f.update("after", true);
		expect(f.rebuilds).toBe(3);
	});

	it("does not change native behavior when disabled", () => {
		const f = fixture(false);
		for (let i = 0; i < 10; i++) f.update(String(i), true);
		expect(f.rebuilds).toBe(10);
	});

	it("caches finished native renders, copies lines and invalidates on width and updates", () => {
		const f = fixture();
		f.update("finished", false);
		let renders = 0;
		const render = (width: number) =>
			f.buffer.render(f.instance, width, () => {
				renders++;
				return [f.rendered];
			}) as string[];
		render(80)[0] = "mutated by caller";
		expect(render(80)).toEqual(["finished"]);
		expect(renders).toBe(1);
		render(60);
		expect(renders).toBe(2);
		f.update("new theme", false);
		expect(render(60)).toEqual(["new theme"]);
		expect(renders).toBe(3);
	});

	it("never caches streaming renders and clears pending work on a throwing rebuild", () => {
		const f = fixture();
		f.update("stream", true);
		let renders = 0;
		for (let i = 0; i < 3; i++)
			f.buffer.render(f.instance, 80, () => {
				renders++;
				return ["stream"];
			});
		expect(renders).toBe(3);
		f.buffer.update(f.instance, [{ content: [] }, true], () => {
			throw new Error("native");
		});
		expect(() => f.buffer.flushAll()).toThrow("native");
		expect(() => f.buffer.flushAll()).not.toThrow();
	});
});
