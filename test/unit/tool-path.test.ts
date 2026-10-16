import { afterEach, describe, expect, it } from "vitest";
import { resetBashTreeRegistry } from "../../extension-src/pi-style/features/tools/boxed/bash.js";
import { closeActiveBatch, resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import { resetGrepRegistry } from "../../extension-src/pi-style/features/tools/boxed/grep.js";
import {
	renderBoxedToolCall as dispatchCall,
	renderBoxedToolResult as dispatchResult,
} from "../../extension-src/pi-style/features/tools/boxed/index.js";
import {
	renderGrepFilesTree,
	renderOutputTree,
} from "../../extension-src/pi-style/features/tools/boxed/output-tree.js";
import { compactToolPath, TOOL_PATH_MAX_WIDTH } from "../../extension-src/pi-style/features/tools/boxed/path.js";
import { setToolsRenderConfig } from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import { stripAnsi, visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";
import { createFakeTheme } from "../helpers/fake-theme.js";

const theme = createFakeTheme();
const directory = "src/Modules/FuelManagement/TransportERP.Modules.FuelManagement.Application/FuelDispensings/Workflow";
const path = `${directory}/AcceptStageWorkflow.cs`;
const compact = "src/../../../AcceptStageWorkflow.cs";
const result = (text: string) => ({ content: [{ type: "text", text }], details: {} });

function context(
	id: string,
	args: Record<string, unknown>,
	overrides: Partial<BoxedToolContext> = {},
): BoxedToolContext {
	return {
		args,
		toolCallId: id,
		invalidate() {},
		state: {},
		cwd: "/project",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function plain(lines: string[]): string {
	return stripAnsi(lines.join("\n"));
}

afterEach(() => {
	resetBatchRegistry();
	resetGrepRegistry();
	resetBashTreeRegistry();
	setToolsRenderConfig({ nerdFonts: false, mergeChunkedReads: true });
});

describe("compact tool paths", () => {
	it("leaves short paths and paths exactly at the limit untouched", () => {
		for (const short of ["", ".", "src/a.cs", "../a.ts", "~/src/a.ts", "a".repeat(60)]) {
			expect(compactToolPath(short)).toBe(short);
		}
	});

	it("collapses the middle, preserving root, basename, ranges and directory slashes", () => {
		expect(compactToolPath(path)).toBe(compact);
		expect(compactToolPath(`${path}:1-2000`)).toBe(`${compact}:1-2000`);
		expect(compactToolPath(`${path}:1`)).toBe(`${compact}:1`);
		expect(compactToolPath(`${directory}/`)).toBe("src/../../../Workflow/");
		expect(compactToolPath(`/project/${path}`)).toBe("/project/../../../AcceptStageWorkflow.cs");
		expect(compactToolPath(`~/${path}`)).toBe("~/../../../AcceptStageWorkflow.cs");
		expect(compactToolPath(`C:\\project\\${path.replaceAll("/", "\\")}`)).toBe("C:/../../../AcceptStageWorkflow.cs");
	});

	it("prefers the basename on narrow terminals and retains the ending of huge basenames", () => {
		expect(compactToolPath(path, 22)).toBe("AcceptStageWorkflow.cs");
		const longName = `CreateAndSubmit${"VeryLong".repeat(20)}CommandHandler.cs:5-20`;
		const rendered = compactToolPath(`${directory}/${longName}`);
		expect(rendered).toContain("...");
		expect(rendered).toContain("CreateAndSubmit");
		expect(rendered).toMatch(/CommandHandler\.cs:5-20$/);
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(TOOL_PATH_MAX_WIDTH);
	});

	it("stays within cell budgets without splitting Unicode graphemes", () => {
		const unicode = `src/${"深い/".repeat(20)}${"😀e\u0301".repeat(30)}.cs:1-20`;
		for (let width = 0; width <= 80; width++) {
			const rendered = compactToolPath(unicode, width);
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(Math.min(width, TOOL_PATH_MAX_WIDTH));
			expect(rendered).not.toContain("�");
		}
	});
});

describe("tool path render contracts", () => {
	it("compacts lone, batched and expanded read paths without changing args", () => {
		const args = { path, offset: 1, limit: 20 };
		const ctx = context("read1", args);
		const call = dispatchCall("read", args, theme, ctx);
		expect(plain(call.render(120))).toContain(`${compact}:1-20`);
		const other = { path: `${directory}/OtherHandler.cs` };
		dispatchCall("read", other, theme, context("read2", other));
		expect(plain(call.render(120))).toContain("src/../../../OtherHandler.cs");
		const expanded = dispatchCall("read", args, theme, { ...ctx, expanded: true });
		expect(plain(expanded.render(45))).toContain("AcceptStageWorkflow.cs:1-20");
		expect(args.path).toBe(path);
	});

	it.each(["write", "edit", "quick_edit", "substitute_edit", "target_edit"])("compacts %s frame headers", (tool) => {
		const args = { path, content: "hello" };
		const call = dispatchCall(tool, args, theme, context(tool, args));
		expect(plain(call.render(120))).toContain(compact);
		expect(plain(call.render(50))).toContain("AcceptStageWorkflow.cs");
		for (const line of call.render(50)) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
	});

	it("keeps compact filenames visible in error headers", () => {
		for (const tool of ["read", "write", "edit"]) {
			closeActiveBatch();
			const args = { path };
			const call = dispatchCall(tool, args, theme, context(tool, args, { isError: true }));
			expect(plain(call.render(50))).toContain("AcceptStageWorkflow.cs");
		}
	});

	it("compacts chunk-merged ranges while retaining same-file merging", () => {
		setToolsRenderConfig({ mergeChunkedReads: true });
		const args = { path, offset: 1, limit: 20 };
		const first = dispatchCall("read", args, theme, context("chunk1", args));
		closeActiveBatch();
		const next = { path, offset: 21, limit: 20 };
		const second = dispatchCall("read", next, theme, context("chunk2", next));
		expect(second.render(120)).toHaveLength(0);
		expect(plain(first.render(120))).toContain(`${compact}:1-40`);
	});

	it("compacts output entries and grep file nodes", () => {
		const lines = renderOutputTree(theme, "Find: 1 file", [path], 45);
		expect(plain(lines)).toContain("AcceptStageWorkflow.cs");
		const matches = [
			{ file: path, line: 1, content: "x" },
			{ file: `${directory}/OtherHandler.cs`, line: 2, content: "y" },
		];
		const grep = renderGrepFilesTree(theme, "Grep: 2 matches", matches, 45);
		expect(plain(grep)).toContain("AcceptStageWorkflow.cs");
		for (const line of [...lines, ...grep]) expect(visibleWidth(line)).toBeLessThanOrEqual(45);
	});

	it.each(["find", "ls"])("compacts %s output including batched nested subtrees", (tool) => {
		const args = tool === "find" ? { pattern: "**/*.cs", path: "." } : { path: "." };
		const ctx = context("first", args);
		const call = dispatchCall(tool, args, theme, ctx);
		dispatchResult(tool, result(path), { expanded: false, isPartial: false }, theme, ctx);
		expect(plain(call.render(120))).toContain(compact);
		const second = context("second", args);
		dispatchCall(tool, args, theme, second);
		dispatchResult(tool, result(path), { expanded: false, isPartial: false }, theme, second);
		expect(plain(call.render(120))).toContain(compact);
	});

	it("keeps both filenames and the arrow in compact Git rename labels", () => {
		const args = { command: "git status --short" };
		const ctx = context("git", args);
		const call = dispatchCall("bash", args, theme, ctx);
		dispatchResult(
			"bash",
			result(`R  ${directory}/OldName.cs -> ${path}`),
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		const rendered = plain(call.render(120));
		expect(rendered).toContain("OldName.cs");
		expect(rendered).toContain(" -> ");
		expect(rendered).toContain("AcceptStageWorkflow.cs");
	});

	it("keeps distinct full paths as chunk merge keys even when their compact labels collide", () => {
		setToolsRenderConfig({ mergeChunkedReads: true });
		const args = { path, offset: 1, limit: 20 };
		const first = dispatchCall("read", args, theme, context("chunk1", args));
		closeActiveBatch();
		const otherArgs = { path: path.replace("FuelManagement", "OtherManagement"), offset: 21, limit: 20 };
		const second = dispatchCall("read", otherArgs, theme, context("chunk2", otherArgs));
		expect(compactToolPath(otherArgs.path)).toBe(compact);
		expect(second.render(120).length).toBeGreaterThan(0);
		expect(plain(first.render(120))).toContain(":1-20");
		expect(plain(first.render(120))).not.toContain(":1-40");
	});
});
