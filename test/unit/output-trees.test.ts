import { afterEach, describe, expect, it } from "vitest";
import { classifyBashCommand, resetBashTreeRegistry } from "../../extension-src/pi-style/features/tools/boxed/bash.js";
import { closeActiveBatch, resetBatchRegistry } from "../../extension-src/pi-style/features/tools/boxed/batch.js";
import { resetGrepRegistry } from "../../extension-src/pi-style/features/tools/boxed/grep.js";
import {
	renderBoxedToolCall as dispatchCall,
	renderBoxedToolResult as dispatchResult,
} from "../../extension-src/pi-style/features/tools/boxed/index.js";
import {
	groupMatchesByFile,
	parseFindOutput,
	parseGrepOutput,
	parseLsLongOutput,
	parseLsOutput,
	pluralForm,
	renderGrepFilesTree,
	renderOutputTree,
} from "../../extension-src/pi-style/features/tools/boxed/output-tree.js";
import { setToolsRenderConfig } from "../../extension-src/pi-style/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../../extension-src/pi-style/features/tools/boxed/shared.js";
import { stripAnsi, visibleWidth } from "../../extension-src/pi-style/shared/ansi.js";
import { createFakeTheme } from "../helpers/fake-theme.js";

const theme = createFakeTheme();

function context(overrides: Partial<BoxedToolContext> = {}): BoxedToolContext {
	return {
		args: {},
		toolCallId: "fixture-call",
		invalidate: () => {},
		state: {},
		cwd: "/fake",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		lastComponent: undefined,
		...overrides,
	};
}

function textResult(text: string) {
	return { content: [{ type: "text", text }], details: {} };
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripAnsi(line));
}

afterEach(() => {
	resetBatchRegistry();
	resetGrepRegistry();
	resetBashTreeRegistry();
	setToolsRenderConfig({ nerdFonts: false });
});

describe("output-tree parsers", () => {
	it("parses ls output, keeping dir suffixes and dropping notices", () => {
		expect(parseLsOutput("a.ts\nsrc/\n(empty directory)\n\n[500 entries limit reached]")).toEqual(["a.ts", "src/"]);
	});

	it("parses ls -l long-format output into names with dir slashes", () => {
		expect(
			parseLsLongOutput(
				"total 32\n" +
					"-rw-r--r--@   1 quannv  staff  250906 Aug  4 05:37 package-lock.json\n" +
					"drwxr-xr-x@   3 quannv  staff      96 Aug  4 05:02 references\n" +
					"lrwxr-xr-x    1 quannv  staff      12 Aug  4 05:02 link -> package.json\n" +
					"-rw-r--r--    1 quannv  staff      10 Aug  4  2023 old file.txt",
			),
		).toEqual(["package-lock.json", "references/", "link -> package.json", "old file.txt"]);
	});

	it("parses find output paths and drops truncation notices", () => {
		expect(parseFindOutput("a.ts\nb/c.ts\n\n[Truncated: 10KB limit reached]")).toEqual(["a.ts", "b/c.ts"]);
	});

	it("parses grep match lines and ignores context lines", () => {
		const matches = parseGrepOutput("a.ts:3: hello\nb.ts:14: world\na.ts:3- ctx\n\n[100 matches limit reached]");
		expect(matches).toEqual([
			{ file: "a.ts", line: 3, content: "hello" },
			{ file: "b.ts", line: 14, content: "world" },
		]);
	});

	it("parses ripgrep-style output without a space after the line colon", () => {
		expect(parseGrepOutput("a.ts:3:hello")).toEqual([{ file: "a.ts", line: 3, content: "hello" }]);
	});

	it("groups matches by file in first-seen order", () => {
		const groups = groupMatchesByFile(parseGrepOutput("b.ts:1: x\na.ts:2: y\nb.ts:3: z"));
		expect(groups.map((g) => g.file)).toEqual(["b.ts", "a.ts"]);
		expect(groups[0]?.matches.length).toBe(2);
	});
});

describe("pluralForm", () => {
	it("handles regular and es-suffix nouns", () => {
		expect(pluralForm("file", 1)).toBe("file");
		expect(pluralForm("file", 3)).toBe("files");
		expect(pluralForm("match", 1)).toBe("match");
		expect(pluralForm("match", 3)).toBe("matches");
	});
});

describe("plain output rendering", () => {
	it.each([false, true])("keeps output portable with the legacy flag set to %s", (nerdFonts) => {
		setToolsRenderConfig({ nerdFonts });
		const lines = plain(renderOutputTree(theme, "List: 2 files · in .", ["src/", "a.ts"], 80));
		expect(lines[1]).toBe("  ├─ src/");
		expect(lines[2]).toBe("  └─ a.ts");
		const findContext = context({ toolCallId: "portable-find", args: { pattern: "**/*", path: "." }, cwd: "/fake" });
		const find = dispatchCall("find", { pattern: "**/*", path: "." }, theme, findContext);
		dispatchResult("find", textResult("a.ts\nb.ts"), { expanded: false, isPartial: false }, theme, findContext);
		expect(plain(find.render(80))[0]).toBe("Find: **/* 2 files · in current directory");

		const grepContext = context({ toolCallId: "portable-grep", args: { pattern: "foo", path: "src" }, cwd: "/fake" });
		const grep = dispatchCall("grep", { pattern: "foo", path: "src" }, theme, grepContext);
		dispatchResult("grep", textResult("a.ts:3: alpha"), { expanded: false, isPartial: false }, theme, grepContext);
		expect(plain(grep.render(80))[0]).toBe("Grep: foo 1 match · 1 file · in src");

		const lsContext = context({ toolCallId: "portable-ls", args: { path: "/fake" }, cwd: "/fake" });
		const ls = dispatchCall("ls", { path: "/fake" }, theme, lsContext);
		dispatchResult("ls", textResult("a.ts\nb.ts"), { expanded: false, isPartial: false }, theme, lsContext);
		expect(plain(ls.render(80))[0]).toBe("List: 2 files · in /fake");
	});
});

describe("renderOutputTree / renderGrepFilesTree", () => {
	it("renders a flat tree with a head limit and a 'more' row", () => {
		const entries = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
		const lines = plain(renderOutputTree(theme, "Find: **/*.ts 10 files · in .", entries, 80));
		expect(lines[0]).toBe("Find: **/*.ts 10 files · in .");
		expect(lines[1]).toBe("  ├─ f0.ts");
		expect(lines.at(-1)).toBe("  └─ … 4 more files");
	});

	it("renders a files-only grep tree with a 'more files' row", () => {
		const matches = parseGrepOutput(Array.from({ length: 9 }, (_, i) => `f${i}.ts:3: hit ${i}`).join("\n"));
		const lines = plain(renderGrepFilesTree(theme, "Grep: x 9 matches · 9 files · in .", matches, 80));
		expect(lines[0]).toBe("Grep: x 9 matches · 9 files · in .");
		expect(lines[1]).toBe("  ├─ f0.ts");
		expect(lines.at(-1)).toBe("  └─ … 3 more files");
		expect(lines.join("\n")).not.toContain("hit");
	});

	it("colors grep file rows with the primary (accent) color", () => {
		const rich = createFakeTheme({ colors: { accent: "#8abeb7" } });
		const matches = parseGrepOutput("a.ts:3: alpha\nb.ts:5: beta");
		const raw = renderGrepFilesTree(rich, "Grep: x", matches, 80);
		const accentAnsi = "\x1b[38;2;138;190;183m";
		const fileNode = raw.find((line) => line.includes("a.ts")) ?? "";
		expect(fileNode).toContain(`${accentAnsi}a.ts`); // file row in accent
		expect(fileNode).not.toContain("alpha"); // match content never renders
	});

	it("keeps every row within the requested width", () => {
		const matches = parseGrepOutput(
			Array.from({ length: 30 }, (_, i) => `longfilename.ts:${i + 1}: ${"x".repeat(60)}`).join("\n"),
		);
		for (const width of [20, 40, 80]) {
			for (const line of renderGrepFilesTree(theme, "Grep: x", matches, width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});
});

describe("ls/find output-tree panels", () => {
	it("renders a lone ls result as a flat List tree", () => {
		const ctx1 = context({ toolCallId: "l1", args: { path: "/fake/src" }, cwd: "/fake" });
		const call = dispatchCall("ls", { path: "/fake/src" }, theme, ctx1);
		dispatchResult(
			"ls",
			textResult("a.ts\nb.ts\nsrc/\nc.ts\nd.ts\ne.ts\nf.ts\ng.ts"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("List: 8 files · in /fake/src");
		expect(lines[1]).toBe("  ├─ a.ts");
		expect(lines.some((line) => line.startsWith("  └─ … "))).toBe(true);
	});

	it("renders a lone find result as a flat Find tree with the pattern", () => {
		const ctx1 = context({ toolCallId: "f1", args: { pattern: "**/*.ts", path: "." }, cwd: "/fake" });
		const call = dispatchCall("find", { pattern: "**/*.ts", path: "." }, theme, ctx1);
		dispatchResult("find", textResult("a.ts\nb.ts"), { expanded: false, isPartial: false }, theme, ctx1);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Find: **/*.ts 2 files · in current directory");
		expect(lines[1]).toBe("  ├─ a.ts");
	});

	it("renders an empty directory as zero files", () => {
		const ctx1 = context({ toolCallId: "e1", args: { path: "/fake/empty" }, cwd: "/fake" });
		const call = dispatchCall("ls", { path: "/fake/empty" }, theme, ctx1);
		dispatchResult("ls", textResult("(empty directory)"), { expanded: false, isPartial: false }, theme, ctx1);
		expect(plain(call.render(80))).toEqual(["List: 0 files · in /fake/empty"]);
	});

	it("renders batched find calls as nested per-member subtrees", () => {
		const c1 = context({ toolCallId: "b1", args: { pattern: "*.ts", path: "src" }, cwd: "/fake" });
		const c2 = context({ toolCallId: "b2", args: { pattern: "*.ts", path: "test" }, cwd: "/fake" });
		const leader = dispatchCall("find", { pattern: "*.ts", path: "src" }, theme, c1);
		dispatchCall("find", { pattern: "*.ts", path: "test" }, theme, c2);
		dispatchResult("find", textResult("a.ts\nb.ts"), { expanded: false, isPartial: false }, theme, c1);
		dispatchResult("find", textResult("spec.ts"), { expanded: false, isPartial: false }, theme, c2);
		const joined = plain(leader.render(80)).join("\n");
		expect(joined).toContain("● Find (2)");
		expect(joined).toContain("src · 2 files");
		expect(joined).toContain("├─ a.ts");
		expect(joined).toContain("test · 1 file");
		expect(joined).toContain("spec.ts");
	});

	it("renders a lone read as a single inline path line", () => {
		const ctx1 = context({ toolCallId: "r1", args: { path: "a.ts" }, cwd: "/fake" });
		const call = dispatchCall("read", { path: "a.ts" }, theme, ctx1);
		dispatchResult("read", textResult("file contents here"), { expanded: false, isPartial: false }, theme, ctx1);
		const joined = plain(call.render(80)).join("\n");
		expect(joined).toContain("➔ Read a.ts");
		expect(joined).not.toContain("(1)");
		expect(joined).not.toContain("└─");
		expect(joined).not.toContain("files");
	});
});

describe("grep output-tree panel", () => {
	it("renders a collapsed grep as a files-only tree (no match content)", () => {
		const ctx1 = context({ toolCallId: "g1", args: { pattern: "foo", path: "src" }, cwd: "/fake" });
		const call = dispatchCall("grep", { pattern: "foo", path: "src" }, theme, ctx1);
		dispatchResult(
			"grep",
			textResult("a.ts:3: match one\nb.ts:14: match two"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines).toEqual(["Grep: foo 2 matches · 2 files · in src", "  ├─ a.ts", "  └─ b.ts"]);
	});

	it("collapses the files-only view to a 'more files' row", () => {
		const ctx1 = context({ toolCallId: "g1b", args: { pattern: "foo", path: "src" }, cwd: "/fake" });
		const call = dispatchCall("grep", { pattern: "foo", path: "src" }, theme, ctx1);
		dispatchResult(
			"grep",
			textResult(Array.from({ length: 9 }, (_, i) => `f${i}.ts:3: hit`).join("\n")),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Grep: foo 9 matches · 9 files · in src");
		expect(lines.at(-1)).toBe("  └─ … 3 more files");
		expect(lines.join("\n")).not.toContain("hit");
	});

	it("renders the uncut file list on header click (state.open), never content", () => {
		const ctx1 = context({ toolCallId: "g1c", args: { pattern: "foo", path: "src" }, cwd: "/fake" });
		const call = dispatchCall("grep", { pattern: "foo", path: "src" }, theme, ctx1) as unknown as {
			render: (width: number) => string[];
			handleMouse: (event: { type: string; button: string; y: number }) => { handled: boolean } | undefined;
		};
		dispatchResult(
			"grep",
			textResult(Array.from({ length: 9 }, (_, i) => `f${i}.ts:3: hit ${i}`).join("\n")),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(call.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({ handled: true });
		const lines = plain(call.render(80));
		expect(lines).toHaveLength(10); // header + all 9 files
		expect(lines.join("\n")).toContain("f8.ts");
		expect(lines.join("\n")).not.toContain("hit");
		expect(lines.join("\n")).not.toContain("more files");
	});

	it("renders the uncut file list under Pi's global expansion (Ctrl+O), never content", () => {
		const ctx1 = context({ toolCallId: "g1d", args: { pattern: "foo", path: "src" }, cwd: "/fake", expanded: true });
		const call = dispatchCall("grep", { pattern: "foo", path: "src" }, theme, ctx1);
		dispatchResult(
			"grep",
			textResult(Array.from({ length: 9 }, (_, i) => `f${i}.ts:3: hit ${i}`).join("\n")),
			{ expanded: true, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines).toHaveLength(10); // header + all 9 files
		expect(lines.join("\n")).toContain("f8.ts");
		expect(lines.join("\n")).not.toContain("hit");
	});

	it("renders a pending grep as a header-only line", () => {
		const ctx1 = context({ toolCallId: "g2", args: { pattern: "foo", path: "src" }, cwd: "/fake" });
		const call = dispatchCall("grep", { pattern: "foo", path: "src" }, theme, ctx1);
		expect(plain(call.render(80))).toEqual(["Grep: foo · in src"]);
	});

	it("renders zero matches", () => {
		const ctx1 = context({ toolCallId: "g3", args: { pattern: "zzz", path: "." }, cwd: "/fake" });
		const call = dispatchCall("grep", { pattern: "zzz", path: "." }, theme, ctx1);
		dispatchResult("grep", textResult("No matches found"), { expanded: false, isPartial: false }, theme, ctx1);
		expect(plain(call.render(80))).toEqual(["Grep: zzz 0 matches · 0 files · in current directory"]);
	});

	it("keeps historical grep panels rendering after a registry reset (session resume)", () => {
		const ctx1 = context({ toolCallId: "g-resume", args: { pattern: "foo", path: "src" }, cwd: "/fake" });
		const call = dispatchCall("grep", { pattern: "foo", path: "src" }, theme, ctx1);
		dispatchResult(
			"grep",
			textResult("a.ts:3: alpha\nb.ts:5: beta"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		// A session boundary (shutdown/start, /resume) clears the registry.
		resetGrepRegistry();
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Grep: foo 2 matches · 2 files · in src");
		expect(lines.join("\n")).toContain("a.ts");
	});
});

describe("bash command classification and tree routing", () => {
	it.each([
		["ls", { kind: "ls" }],
		["ls -la src/", { kind: "ls" }],
		["sudo ls /tmp", { kind: "ls" }],
		["FOO=bar /usr/bin/ls", { kind: "ls" }],
		["cd src && ls", { kind: "ls" }],
		["find . -name '*.ts'", { kind: "find" }],
		["find . -name '*.ts' -type f", { kind: "find" }],
		["cd /a && cd /b && find . -name '*.ts'", { kind: "find" }],
		["grep -rn foo src", { kind: "grep" }],
		["rg pattern", { kind: "grep" }],
		["rg --type ts -n foo src", { kind: "grep" }],
		["rg foo . | head -5", { kind: "grep" }],
		["ls -la | tail -n 3", { kind: "ls" }],
		["cd src && rg foo", { kind: "grep" }],
	] as const)("classifies %s", (command, expected) => {
		const cls = classifyBashCommand(command);
		expect(cls?.kind).toBe(expected.kind);
	});

	it.each([
		"echo hi",
		"npm test",
		"ls | grep x",
		"rg x | wc -l",
		"ls > out.txt",
		"find . -name x && echo",
		"cd src && echo hi && rg foo",
		"rg foo &",
		"cd src",
		"ls\necho",
	])("does not classify %s (keeps boxed shell)", (command) => {
		expect(classifyBashCommand(command)).toBeNull();
	});

	it("extracts pattern/path from cd chains and value flags", () => {
		const cls = classifyBashCommand(
			'cd /Users/quannv.dev/Workspace/Personal/pi-dev/pi-style && rg -n "createPiStyleSessionCoordinator" extension-src --type ts | head -20',
		);
		expect(cls).toMatchObject({ kind: "grep", pattern: "createPiStyleSessionCoordinator", pathLabel: "extension-src" });
		expect(classifyBashCommand("cd src && rg foo")?.pathLabel).toBe("src");
	});

	it("renders bash ls output as a List tree", () => {
		const ctx1 = context({ toolCallId: "b1", args: { command: "ls src/", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "ls src/", timeout: 30 }, theme, ctx1);
		dispatchResult(
			"bash",
			textResult("a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\ng.ts"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("List: 7 files · in src/");
		expect(lines.join("\n")).toContain("├─ a.ts");
	});

	it("renders bash grep output as a Grep tree", () => {
		const ctx1 = context({ toolCallId: "b2", args: { command: "rg foo docs", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "rg foo docs", timeout: 30 }, theme, ctx1);
		dispatchResult(
			"bash",
			textResult("docs/a.md:3: alpha\ndocs/b.md:5: beta"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Grep: foo 2 matches · 2 files · in docs");
	});

	it("renders the result component empty (the tree lives in the call panel)", () => {
		const ctx1 = context({ toolCallId: "b-empty", args: { command: "ls src/", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "ls src/", timeout: 30 }, theme, ctx1);
		const result = dispatchResult("bash", textResult("a.ts\nb.ts"), { expanded: false, isPartial: false }, theme, ctx1);
		expect(result.render(80)).toEqual([]);
	});

	it("renders ls -l long-format output as a List tree", () => {
		const ctx1 = context({ toolCallId: "b3", args: { command: "ls -l", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "ls -l", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(
				"total 32\ndrwxr-xr-x   3 user staff      96 Aug  4 05:02 src/\n-rw-r--r--   1 user staff      10 Aug  4 05:37 a.ts",
			),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("List: 2 files");
		expect(lines.join("\n")).toContain("src/"); // dir gets a trailing slash
		expect(lines.join("\n")).toContain("a.ts");
		expect(result.render(80)).toEqual([]); // tree lives in the call panel
	});

	it("parses single-file rg/grep output (line: content) into a tree", () => {
		const ctx1 = context({
			toolCallId: "b-single",
			args: { command: 'rg "name" package.json', timeout: 30 },
			cwd: "/fake",
		});
		const call = dispatchCall("bash", { command: 'rg "name" package.json', timeout: 30 }, theme, ctx1);
		dispatchResult(
			"bash",
			textResult('2:  "name": "@quandev104/pi-style",\n7:  "version": "0.1.2",'),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(90));
		expect(lines[0]).toBe("Grep: name 2 matches · 1 file · in package.json");
		expect(lines.join("\n")).toContain("package.json");
	});

	it("renders zero matches as a tree without a boxed response", () => {
		const ctx1 = context({ toolCallId: "b-nomatch", args: { command: 'rg "zzz" themes', timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: 'rg "zzz" themes', timeout: 30 }, theme, ctx1);
		const result = dispatchResult("bash", textResult(""), { expanded: false, isPartial: false }, theme, ctx1);
		expect(plain(call.render(90))[0]).toBe("Grep: zzz 0 matches · 0 files · in themes");
		expect(result.render(90)).toEqual([]); // tree lives in the call panel
	});

	it("falls back to the boxed shell for piped commands", () => {
		const ctx1 = context({ toolCallId: "b4", args: { command: "ls | grep x", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "ls | grep x", timeout: 30 }, theme, ctx1);
		const result = dispatchResult("bash", textResult("a.ts\nb.ts"), { expanded: false, isPartial: false }, theme, ctx1);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
	});

	it("renders a pending classified call as a header line", () => {
		const ctx1 = context({ toolCallId: "b5", args: { command: "ls src/", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "ls src/", timeout: 30 }, theme, ctx1);
		expect(plain(call.render(80))).toEqual(["List · in src/"]);
	});

	it("keeps historical bash tree panels rendering after a registry reset", () => {
		const ctx1 = context({ toolCallId: "b-resume", args: { command: "ls src/", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "ls src/", timeout: 30 }, theme, ctx1);
		dispatchResult("bash", textResult("a.ts\nb.ts"), { expanded: false, isPartial: false }, theme, ctx1);
		resetBashTreeRegistry(); // session boundary
		expect(plain(call.render(80))[0]).toBe("List: 2 files · in src/");
	});

	it("keeps every classified result width-safe", () => {
		const entries = Array.from({ length: 30 }, (_, i) => `deep/path/file${i}.ts`);
		const ctx1 = context({ toolCallId: "b6", args: { command: "find . -name '*.ts'", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "find . -name '*.ts'", timeout: 30 }, theme, ctx1);
		dispatchResult("bash", textResult(entries.join("\n")), { expanded: false, isPartial: false }, theme, ctx1);
		for (const width of [20, 40, 80]) {
			for (const line of call.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});
});

// Ensure closeActiveBatch is exercised (imported for boundary behavior elsewhere).
void closeActiveBatch;
