import { afterEach, describe, expect, it } from "vitest";
import { classifyBashCommand, resetBashTreeRegistry } from "../../extension-src/pi-style/features/tools/boxed/bash.js";
import {
	classifyGitCommand,
	parseGitOutput,
	renderGitCardLines,
} from "../../extension-src/pi-style/features/tools/boxed/git.js";
import {
	renderBoxedToolCall as dispatchCall,
	renderBoxedToolResult as dispatchResult,
} from "../../extension-src/pi-style/features/tools/boxed/index.js";
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

// Fixtures captured from real git output (see docs/decisions/0005).
const LONG_STATUS_FIXTURE = [
	"On branch main",
	"Your branch is up to date with 'origin/main'.",
	"",
	"Changes not staged for commit:",
	'  (use "git add <file>..." to update what will be committed)',
	'  (use "git restore <file>..." to discard changes in working directory)',
	"\tmodified:   ROADMAP.md",
	"\tmodified:   docs/decisions/README.md",
	"\tmodified:   docs/ui/MESSAGES-AND-TOOLS.md",
	"",
	"Untracked files:",
	'  (use "git add <file>..." to include in what will be committed)',
	"\tdocs/decisions/0005-git-github-semantic-renderers.md",
	"",
	'no changes added to commit (use "git add" and/or "git commit -a")',
].join("\n");

const RENAME_STATUS_FIXTURE = [
	"On branch main",
	"Changes to be committed:",
	'  (use "git restore --staged <file>..." to unstage)',
	"\trenamed:    old.txt -> new.txt",
	"\tnew file:   other.txt",
	"",
	"Changes not staged for commit:",
	"\tmodified:   new.txt",
].join("\n");

const CONFLICT_STATUS_FIXTURE = [
	"On branch main",
	"You have unmerged paths.",
	'  (fix conflicts and run "git commit")',
	"",
	"Unmerged paths:",
	'  (use "git add <file>..." to mark resolution)',
	"\tboth modified:   f.txt",
	"",
	'no changes added to commit (use "git add" and/or "git commit -a")',
].join("\n");

const CLEAN_STATUS_FIXTURE = [
	"On branch main",
	"Your branch is up to date with 'origin/main'.",
	"",
	"nothing to commit, working tree clean",
].join("\n");

const AHEAD_STATUS_FIXTURE = [
	"On branch main",
	"Your branch is ahead of 'origin/main' by 1 commit.",
	'  (use "git push" to publish your local commits)',
	"",
	"nothing to commit, working tree clean",
].join("\n");

const DIVERGED_STATUS_FIXTURE = [
	"On branch main",
	"Your branch and 'origin/main' have diverged,",
	"and have 1 and 2 different commits each, respectively.",
	'  (use "git pull" if you want to integrate the remote branch with yours)',
	"",
	"nothing to commit, working tree clean",
].join("\n");

const DIFF_STAT_FIXTURE = [
	" ROADMAP.md                    | 57 +++++++++++++++++++++++++++++++++++++++++++",
	" docs/decisions/README.md      |  1 +",
	" docs/ui/MESSAGES-AND-TOOLS.md | 50 ++++++++++++++++++++++++++++++++++---",
	" 3 files changed, 105 insertions(+), 3 deletions(-)",
].join("\n");

const DIFF_STAT_BINARY_FIXTURE = [
	" bin.dat            | Bin 0 -> 3 bytes",
	" old.txt => new.txt |   0",
	" other.txt          |   1 +",
	" 3 files changed, 1 insertion(+)",
].join("\n");

const LOG_FULL_FIXTURE = [
	"commit 1b7252df8bcd26e9c5758aa4baa2b3a80709c4ba",
	"Author: quanpersie2001 <quanpersie2001@gmail.com>",
	"Date:   Wed Aug 5 23:27:34 2026 +0700",
	"",
	"    feat: rounded dock editor frame with dim hint",
	"    - second line of the message",
	"",
	"commit c64ea8a252f8a2ffca090ec18fb28a5f72223afb",
	"Author: github-actions[bot] <github-actions[bot]@users.noreply.github.com>",
	"Date:   Wed Aug 5 08:12:04 2026 +0000",
	"",
	"    v0.1.4",
].join("\n");

const LOG_ONELINE_FIXTURE = [
	"1b7252d (HEAD -> main, origin/main, origin/HEAD) feat: rounded dock editor frame",
	"c64ea8a (tag: v0.1.4) v0.1.4",
	"8d99731 feat: strict boxed tool-card state machine",
].join("\n");

// Real-shaped `git diff` fixtures (captured from this repo's unified diff output).
const DIFF_SINGLE_FILE_FIXTURE = [
	"diff --git a/docs/ui/THEMING.md b/docs/ui/THEMING.md",
	"index 30109db..232dc39 100644",
	"--- a/docs/ui/THEMING.md",
	"+++ b/docs/ui/THEMING.md",
	"@@ -25,7 +25,7 @@ Tokens are grouped by meaning",
	" | --- | --- |",
	" | Core | `surface`, `text` |",
	"-| Editor | `editorPrompt`, `editorBorder`; thinking levels map to Pi's tokens |",
	"+| Editor | `editorPrompt`, `editorBorder`, `hint`; thinking levels map to Pi's tokens |",
	" | Messages/tools | `toolTitle` |",
].join("\n");

const DIFF_TWO_FILE_FIXTURE = [
	"diff --git a/foo.ts b/foo.ts",
	"index 111..222 100644",
	"--- a/foo.ts",
	"+++ b/foo.ts",
	"@@ -1,3 +1,3 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	" const c = 3;",
	"diff --git a/bin.dat b/bin.dat",
	"new file mode 100644",
	"index 0000000..3333333",
	"Binary files /dev/null and b/bin.dat differ",
].join("\n");

const DIFF_NEW_FILE_FIXTURE = [
	"diff --git a/src/new.ts b/src/new.ts",
	"new file mode 100644",
	"index 0000000..4444444",
	"--- /dev/null",
	"+++ b/src/new.ts",
	"@@ -0,0 +1,2 @@",
	"+export const x = 1;",
	"+export const y = 2;",
].join("\n");

const DIFF_RENAME_FIXTURE = [
	"diff --git a/old.txt b/new.txt",
	"similarity index 90%",
	"rename from old.txt",
	"rename to new.txt",
	"index 111..222 100644",
	"--- a/old.txt",
	"+++ b/new.txt",
	"@@ -1,2 +1,2 @@",
	" line one",
	"-changed old",
	"+changed new",
].join("\n");

const SHOW_FIXTURE = [
	"commit 1b7252df8bcd26e9c5758aa4baa2b3a80709c4ba",
	"Author: quanpersie2001 <quanpersie2001@gmail.com>",
	"Date:   Wed Aug 5 23:27:34 2026 +0700",
	"",
	"    feat: rounded dock editor frame with dim hint",
	"    - second line of the message body",
	"",
	...DIFF_TWO_FILE_FIXTURE.split("\n"),
].join("\n");

// Real `git show --stat HEAD` output captured from this repo (commit 1b7252d:
// 17 files changed, 590 insertions, 71 deletions). The stat block mirrors
// `git diff --stat` exactly; the commit header mirrors full-format `git log`.
const SHOW_STAT_FIXTURE = [
	"commit 1b7252df8bcd26e9c5758aa4baa2b3a80709c4ba",
	"Author: quanpersie2001 <quanpersie2001@gmail.com>",
	"Date:   Wed Aug 5 23:27:34 2026 +0700",
	"",
	"    feat: rounded dock editor frame with dim hint, zero-trace thinking collapse",
	"    ",
	"    - editor.frame: rounded box with vertical side borders",
	"",
	" CHANGELOG.md                                       |  19 ++",
	" README.md                                          |   4 +-",
	" docs/CONFIGURATION.md                              |  34 +++-",
	" docs/ui/EDITOR.md                                  |  22 ++-",
	" docs/ui/MESSAGES-AND-TOOLS.md                      |   2 +-",
	" docs/ui/THEMING.md                                 |   2 +-",
	" extension-src/pi-style/domain/config-normalization.ts |  10 +-",
	" extension-src/pi-style/domain/config-types.ts      |   6 +-",
	" extension-src/pi-style/domain/theme.ts             |   4 +-",
	" extension-src/pi-style/features/editor/index.ts    | 106 ++++++++---",
	" extension-src/pi-style/features/messages/index.ts  |  66 +++++++",
	" extension-src/pi-style/pi/compatibility-coordinator.ts |  17 ++",
	" extension-src/pi-style/pi/compatibility-probe.ts   |  40 +++-",
	" test/unit/compatibility-probe.test.ts              |  30 +--",
	" test/unit/config-control-plane.test.ts             |   3 +-",
	" test/unit/editor.test.ts                           |  85 ++++++--",
	" test/unit/message-thinking-collapse.test.ts        | 211 +++++++++++++++++++++",
	" 17 files changed, 590 insertions(+), 71 deletions(-)",
].join("\n");

// `git show --stat` on a commit with no file changes: header only, no stat.
const SHOW_STAT_NO_CHANGES_FIXTURE = [
	"commit 0000000000000000000000000000000000000000",
	"Author: bot <bot@example.com>",
	"Date:   Wed Aug 5 23:27:34 2026 +0700",
	"",
	"    chore: empty commit with no file changes",
].join("\n");

// Real `git commit`/`push`/`pull`/`fetch` state-change output (Phase 8C-1).
// Captured from a scratch repo (see docs/decisions/0005): each command surfaces
// a different shape, and the parsers are fail-closed on unrecognized lines.
const COMMIT_SUCCESS_FIXTURE = "[main c852e01] feat: add b line\n 1 file changed, 1 insertion(+)";
const COMMIT_NOTHING_FIXTURE = "On branch main\nnothing to commit, working tree clean";
const PUSH_NEW_FIXTURE =
	"To ../c8-remote.git\n * [new branch]      main -> main\nbranch 'main' set up to track 'origin/main'.";
const PUSH_UPDATE_FIXTURE = "To ../c8-remote.git\n   0d6329b..17a9bea  main -> main";
const PUSH_UPTODATE_FIXTURE = "Everything up-to-date";
const PUSH_WITH_NOISE_FIXTURE = [
	"Enumerating objects: 3, done.",
	"Counting objects: 100% (3/3), done.",
	"To ../c8-remote.git",
	"   0d6329b..17a9bea  main -> main",
	"branch 'main' set up to track 'origin/main'.",
].join("\n");
const PULL_FF_FIXTURE = "Updating 17a9bea..ae553b1\nFast-forward\n a.txt | 1 +\n 1 file changed, 1 insertion(+)";
const PULL_UPTODATE_FIXTURE = "Already up to date.";
const FETCH_NEW_FIXTURE = "From ../c8-remote\n   17a9bea..ae553b1  main       -> origin/main";

afterEach(() => {
	resetBashTreeRegistry();
	setToolsRenderConfig({ nerdFonts: false });
});

describe("classifyGitCommand", () => {
	it.each([
		["git status", { kind: "status", short: false }],
		["git status --short", { kind: "status", short: true }],
		["git status -s", { kind: "status", short: true }],
		["git status --porcelain", { kind: "status", short: true }],
		["git status --porcelain=v1", { kind: "status", short: true }],
		["git status -sb", { kind: "status", short: true }],
		["git status --branch", { kind: "status", short: false }],
		["cd src && git status", { kind: "status", short: false }],
		["/usr/bin/git status", { kind: "status", short: false }],
		["git diff --stat", { kind: "diff-stat" }],
		["git diff --stat HEAD~1", { kind: "diff-stat" }],
		["git diff --stat --cached", { kind: "diff-stat" }],
		["git diff --stat --stat-width=200 HEAD~3", { kind: "diff-stat" }],
		["git diff", { kind: "diff", show: false }],
		["git diff HEAD~3 HEAD", { kind: "diff", show: false }],
		["git diff --cached", { kind: "diff", show: false }],
		["git diff -U5 src/foo.ts", { kind: "diff", show: false }],
		["git show", { kind: "diff", show: true }],
		["git show HEAD", { kind: "diff", show: true }],
		["git show 1b7252d -- path.ts", { kind: "diff", show: true }],
		["git show --stat HEAD", { kind: "show-stat" }],
		["git show --stat=80 HEAD", { kind: "show-stat" }],
		["git show --stat --stat-width=120", { kind: "show-stat" }],
		["git log", { kind: "log" }],
		["git log --oneline -5", { kind: "log" }],
		['git commit -m "x"', { kind: "action", command: "commit" }],
		['git commit -am "ship it"', { kind: "action", command: "commit" }],
		["git push", { kind: "action", command: "push" }],
		["git push -u origin main", { kind: "action", command: "push" }],
		["git pull", { kind: "action", command: "pull" }],
		["git fetch origin", { kind: "action", command: "fetch" }],
		["git switch feature", { kind: "action", command: "switch" }],
		["git switch -c feat", { kind: "action", command: "switch" }],
		["git checkout main", { kind: "action", command: "checkout" }],
		["git checkout -b feat", { kind: "action", command: "checkout" }],
		["git checkout -- a.txt", { kind: "action", command: "checkout" }],
		["git add .", { kind: "action", command: "add" }],
		["git add -A", { kind: "action", command: "add" }],
		["git restore a.txt", { kind: "action", command: "restore" }],
		["git restore --staged a.txt", { kind: "action", command: "restore" }],
		["git reset", { kind: "action", command: "reset" }],
		["git reset --hard HEAD~1", { kind: "action", command: "reset" }],
		["git merge feature", { kind: "action", command: "merge" }],
		["git merge --no-ff feature", { kind: "action", command: "merge" }],
		["git rebase main", { kind: "action", command: "rebase" }],
	])("classifies %s", (command, expected) => {
		const cls = classifyGitCommand(command);
		expect(cls).toMatchObject(expected);
	});

	it.each([
		"echo hi",
		"git",
		"git status | head -5",
		"git status -z",
		"git status --porcelain=v2",
		"git -C /tmp status",
		"git diff --numstat",
		"git diff --name-only",
		"git diff --binary",
		"git diff --raw",
		"git diff --word-diff",
		"git diff --shortstat",
		"git diff --stat --numstat",
		"git diff --stat --name-only",
		"git show -p --stat",
		"git show --stat --numstat",
		"git show --format=%h --stat",
		"git show -sp --stat",
		"git show --numstat",
		"git show --name-only",
		"git show --format=%h",
		"git show --pretty=oneline",
		"git switch -p",
		"git switch --orphan x",
		"git checkout -p",
		"git add -i",
		"git add -p",
		"git restore -p",
		"git reset -p",
		"git merge -v",
		"git rebase -i main",
		"git rebase -x cmd",
		"git rebase --exec=cmd",
		"git switch | cat",
		"git add . && git commit -m x",
		"git show --oneline",
		"git diff | head",
		"git show | grep Subject",
		"git log -p",
		"git log --graph",
		"git log --format=%h",
		"git log --pretty=oneline",
		"git log --stat",
		"git commit -v",
		"git commit --dry-run",
		"git commit -p",
		"git push --porcelain",
		"git push -v",
		"git push --dry-run",
		"git pull --rebase",
		"git pull -v",
		"git fetch -v",
		"git fetch --dry-run",
		"git push | cat",
		"git cat-file -p HEAD",
		"git rev-parse HEAD",
		"git for-each-ref",
		"echo x && git status",
		"git status && git log",
		"git status > out.txt",
		"ls src/",
		"npm test",
	])("does not classify %s (keeps boxed shell)", (command) => {
		expect(classifyGitCommand(command)).toBeNull();
	});
});

describe("parseGitOutput — git status", () => {
	it("parses long status with staged/unstaged/untracked sections", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, LONG_STATUS_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "status") throw new Error("expected status parse");
		expect(parsed.branch).toBe("main");
		expect(parsed.ahead).toBeUndefined();
		expect(parsed.files).toEqual([
			{ x: " ", y: "M", path: "ROADMAP.md" },
			{ x: " ", y: "M", path: "docs/decisions/README.md" },
			{ x: " ", y: "M", path: "docs/ui/MESSAGES-AND-TOOLS.md" },
			{ x: "?", y: "?", path: "docs/decisions/0005-git-github-semantic-renderers.md" },
		]);
	});

	it("parses staged renames and new files with worktree modifications", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, RENAME_STATUS_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "status") throw new Error("expected status parse");
		expect(parsed.files).toEqual([
			{ x: "R", y: " ", path: "old.txt -> new.txt" },
			{ x: "A", y: " ", path: "other.txt" },
			{ x: " ", y: "M", path: "new.txt" },
		]);
	});

	it("parses unmerged (conflicted) paths as U", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, CONFLICT_STATUS_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "status") throw new Error("expected status parse");
		expect(parsed.files).toEqual([{ x: "U", y: "U", path: "f.txt" }]);
	});

	it("parses a clean tree", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, CLEAN_STATUS_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "status") throw new Error("expected status parse");
		expect(parsed.branch).toBe("main");
		expect(parsed.files).toEqual([]);
	});

	it("parses ahead and diverged branch states", () => {
		const ahead = parseGitOutput({ kind: "status", short: false }, AHEAD_STATUS_FIXTURE);
		if (ahead?.kind !== "status") throw new Error("expected status parse");
		expect(ahead.ahead).toBe(1);
		expect(ahead.behind).toBeUndefined();

		const diverged = parseGitOutput({ kind: "status", short: false }, DIVERGED_STATUS_FIXTURE);
		if (diverged?.kind !== "status") throw new Error("expected status parse");
		expect(diverged.diverged).toBe(true);
		expect(diverged.ahead).toBe(1);
		expect(diverged.behind).toBe(2);
	});

	it("parses short status with rename and conflict codes", () => {
		const parsed = parseGitOutput(
			{ kind: "status", short: true },
			"RM old.txt -> new.txt\nA  other.txt\nUU f.txt\n?? newfile.ts",
		);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "status") throw new Error("expected status parse");
		expect(parsed.files).toEqual([
			{ x: "R", y: "M", path: "old.txt -> new.txt" },
			{ x: "A", y: " ", path: "other.txt" },
			{ x: "U", y: "U", path: "f.txt" },
			{ x: "?", y: "?", path: "newfile.ts" },
		]);
	});

	it("parses short --branch header with ahead/behind", () => {
		const parsed = parseGitOutput(
			{ kind: "status", short: true },
			"## main...origin/main [ahead 1, behind 1]\n M ROADMAP.md",
		);
		if (parsed?.kind !== "status") throw new Error("expected status parse");
		expect(parsed.branch).toBe("main");
		expect(parsed.ahead).toBe(1);
		expect(parsed.behind).toBe(1);
		expect(parsed.diverged).toBe(true);
	});

	it("treats empty short output as a clean tree", () => {
		const parsed = parseGitOutput({ kind: "status", short: true }, "");
		if (parsed?.kind !== "status") throw new Error("expected status parse");
		expect(parsed.files).toEqual([]);
	});

	it.each([
		["unknown verb", LONG_STATUS_FIXTURE.replace("\tmodified:   ROADMAP.md", "\tmodifié:     ROADMAP.md")],
		["unrecognized non-tab line", `${LONG_STATUS_FIXTURE}\nweird output line`],
		["NUL-separated short format", " M ROADMAP.md\u0000?? x.ts"],
		["unrecognized short line", " M ROADMAP.md\ngarbage line"],
	])("returns null on %s (fallback to boxed shell)", (_label, hostile) => {
		expect(parseGitOutput({ kind: "status", short: false }, hostile)).toBeNull();
		expect(parseGitOutput({ kind: "status", short: true }, hostile)).toBeNull();
	});
});

describe("parseGitOutput — git diff --stat", () => {
	it("parses per-file rows and the summary line", () => {
		const parsed = parseGitOutput({ kind: "diff-stat" }, DIFF_STAT_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "diff-stat") throw new Error("expected diff-stat parse");
		expect(parsed.filesChanged).toBe(3);
		expect(parsed.insertions).toBe(105);
		expect(parsed.deletions).toBe(3);
		expect(parsed.files).toEqual([
			{ path: "ROADMAP.md", changes: 57 },
			{ path: "docs/decisions/README.md", changes: 1 },
			{ path: "docs/ui/MESSAGES-AND-TOOLS.md", changes: 50 },
		]);
	});

	it("parses binary and rename rows", () => {
		const parsed = parseGitOutput({ kind: "diff-stat" }, DIFF_STAT_BINARY_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "diff-stat") throw new Error("expected diff-stat parse");
		expect(parsed.filesChanged).toBe(3);
		expect(parsed.insertions).toBe(1);
		expect(parsed.files).toEqual([
			{ path: "bin.dat", binary: true },
			{ path: "old.txt => new.txt", changes: 0 },
			{ path: "other.txt", changes: 1 },
		]);
	});

	it("parses an empty diff as no changes", () => {
		const parsed = parseGitOutput({ kind: "diff-stat" }, "");
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "diff-stat") throw new Error("expected diff-stat parse");
		expect(parsed.files).toEqual([]);
		expect(parsed.filesChanged).toBeUndefined();
	});

	it("parses a summary-only output", () => {
		const parsed = parseGitOutput({ kind: "diff-stat" }, "1 file changed, 1 insertion(+)");
		if (parsed?.kind !== "diff-stat") throw new Error("expected diff-stat parse");
		expect(parsed.filesChanged).toBe(1);
		expect(parsed.insertions).toBe(1);
	});

	it("returns null on unparseable rows", () => {
		expect(parseGitOutput({ kind: "diff-stat" }, "ROADMAP.md 57 +++++++\nnot a stat line")).toBeNull();
	});
});

describe("parseGitOutput — git show --stat", () => {
	it("parses the commit header and the full stat block", () => {
		const parsed = parseGitOutput({ kind: "show-stat" }, SHOW_STAT_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "show-stat") throw new Error("expected show-stat parse");
		expect(parsed.hash).toBe("1b7252df8bcd26e9c5758aa4baa2b3a80709c4ba");
		expect(parsed.subject).toBe("feat: rounded dock editor frame with dim hint, zero-trace thinking collapse");
		expect(parsed.filesChanged).toBe(17);
		expect(parsed.insertions).toBe(590);
		expect(parsed.deletions).toBe(71);
		expect(parsed.files).toHaveLength(17);
		expect(parsed.files[0]).toEqual({ path: "CHANGELOG.md", changes: 19 });
		expect(parsed.files.at(-1)).toEqual({ path: "test/unit/message-thinking-collapse.test.ts", changes: 211 });
	});

	it("parses a commit with no file changes as an empty stat block", () => {
		const parsed = parseGitOutput({ kind: "show-stat" }, SHOW_STAT_NO_CHANGES_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "show-stat") throw new Error("expected show-stat parse");
		expect(parsed.hash).toBe("0000000000000000000000000000000000000000");
		expect(parsed.subject).toBe("chore: empty commit with no file changes");
		expect(parsed.files).toEqual([]);
		expect(parsed.filesChanged).toBeUndefined();
	});

	it("accepts rows when the summary line is truncated (consistent with diff-stat)", () => {
		const truncated = SHOW_STAT_FIXTURE.split("\n").slice(0, -1).join("\n");
		const parsed = parseGitOutput({ kind: "show-stat" }, truncated);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "show-stat") throw new Error("expected show-stat parse");
		expect(parsed.files).toHaveLength(17);
		expect(parsed.filesChanged).toBeUndefined();
		expect(parsed.insertions).toBeUndefined();
	});

	it.each([
		["non-commit first line", "random text\nno commit here"],
		["hostile stat line", `${SHOW_STAT_FIXTURE}\n!!! not a stat row`],
		["git show blob content", "just raw file content, no commit header or stat"],
	])("returns null on %s (fallback to boxed shell)", (_label, hostile) => {
		expect(parseGitOutput({ kind: "show-stat" }, hostile)).toBeNull();
	});
});

describe("parseGitOutput — git log", () => {
	it("parses full-format commit blocks (subject = first message line)", () => {
		const parsed = parseGitOutput({ kind: "log" }, LOG_FULL_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "log") throw new Error("expected log parse");
		expect(parsed.commits).toEqual([
			{ hash: "1b7252df8bcd26e9c5758aa4baa2b3a80709c4ba", subject: "feat: rounded dock editor frame with dim hint" },
			{ hash: "c64ea8a252f8a2ffca090ec18fb28a5f72223afb", subject: "v0.1.4" },
		]);
	});

	it("parses oneline format, extracting decorations into refs", () => {
		const parsed = parseGitOutput({ kind: "log" }, LOG_ONELINE_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "log") throw new Error("expected log parse");
		expect(parsed.commits).toEqual([
			{ hash: "1b7252d", refs: "HEAD -> main, origin/main, origin/HEAD", subject: "feat: rounded dock editor frame" },
			{ hash: "c64ea8a", refs: "tag: v0.1.4", subject: "v0.1.4" },
			{ hash: "8d99731", subject: "feat: strict boxed tool-card state machine" },
		]);
	});

	it("parses an empty log as no commits", () => {
		const parsed = parseGitOutput({ kind: "log" }, "");
		if (parsed?.kind !== "log") throw new Error("expected log parse");
		expect(parsed.commits).toEqual([]);
	});

	it("returns null when no commit blocks and no oneline rows parse", () => {
		expect(parseGitOutput({ kind: "log" }, "Author: someone\nDate: Mon\n\n    message")).toBeNull();
		expect(parseGitOutput({ kind: "log" }, "diff --git a/x b/x\n+line")).toBeNull();
	});
});

describe("parseGitOutput — git diff / show", () => {
	it("parses a single-file diff: path, +N -M counts, normalized body", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, DIFF_SINGLE_FILE_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "diff") throw new Error("expected diff parse");
		expect(parsed.show).toBe(false);
		expect(parsed.hash).toBeUndefined();
		expect(parsed.files).toHaveLength(1);
		expect(parsed.files[0]).toMatchObject({
			path: "docs/ui/THEMING.md",
			status: "modified",
			additions: 1,
			removals: 1,
		});
	});

	it("counts multiple files including a binary entry", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, DIFF_TWO_FILE_FIXTURE);
		if (parsed?.kind !== "diff") throw new Error("expected diff parse");
		expect(parsed.files).toHaveLength(2);
		expect(parsed.files[0]).toMatchObject({ path: "foo.ts", additions: 1, removals: 1 });
		expect(parsed.files[1]).toMatchObject({
			path: "bin.dat",
			status: "added",
			binary: true,
			additions: 0,
			removals: 0,
		});
	});

	it("parses a new-file diff (/dev/null source)", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, DIFF_NEW_FILE_FIXTURE);
		if (parsed?.kind !== "diff") throw new Error("expected diff parse");
		expect(parsed.files[0]).toMatchObject({ path: "src/new.ts", status: "added", additions: 2, removals: 0 });
	});

	it("parses a rename as `old => new`", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, DIFF_RENAME_FIXTURE);
		if (parsed?.kind !== "diff") throw new Error("expected diff parse");
		expect(parsed.files[0]).toMatchObject({ path: "old.txt => new.txt", status: "renamed", additions: 1, removals: 1 });
	});

	it("extracts hash + first subject line for git show", () => {
		const parsed = parseGitOutput({ kind: "diff", show: true }, SHOW_FIXTURE);
		if (parsed?.kind !== "diff") throw new Error("expected diff parse");
		expect(parsed.show).toBe(true);
		expect(parsed.hash).toBe("1b7252df8bcd26e9c5758aa4baa2b3a80709c4ba");
		expect(parsed.subject).toBe("feat: rounded dock editor frame with dim hint");
		expect(parsed.files).toHaveLength(2);
	});

	it("parses an empty diff as no files", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, "");
		if (parsed?.kind !== "diff") throw new Error("expected diff parse");
		expect(parsed.files).toEqual([]);
	});

	it("normalizes the body into numbered rows the adaptive diff component reads", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, DIFF_SINGLE_FILE_FIXTURE);
		if (parsed?.kind !== "diff") throw new Error("expected diff parse");
		// Context rows carry the old line number; removed/added carry old/new.
		expect(parsed.files[0].body).toContain(" 25 | --- | --- |");
		expect(parsed.files[0].body).toContain("- 27 | Editor |");
		expect(parsed.files[0].body).toContain("+ 27 | Editor |");
	});

	it.each([
		["random text", "random text\nno diff here"],
		["content before diff --git", "stray line\ndiff --git a/x b/x\n+line"],
		["unknown header line", "diff --git a/x b/x\nweird unrecognized line\n@@ -1 +1 @@\n+a\n"],
		["unknown hunk line", "diff --git a/x b/x\n@@ -1 +1 @@\n+a\nbad line\n"],
		["binary patch body", "diff --git a/x b/x\nGIT binary patch\n...\n"],
		["git show without a patch", "commit 1234567\n\n    subject only\n"],
		["git show blob content", "just raw file content, no commit header or diff"],
	])("returns null on %s (fallback to boxed shell)", (_label, hostile) => {
		expect(parseGitOutput({ kind: "diff", show: false }, hostile)).toBeNull();
	});
});

describe("parseGitOutput — git action (commit/push/pull/fetch)", () => {
	it("parses a successful commit (branch, hash, subject, summary)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "commit" }, COMMIT_SUCCESS_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.command).toBe("commit");
		expect(parsed.branch).toBe("main");
		expect(parsed.hash).toBe("c852e01");
		expect(parsed.subject).toBe("feat: add b line");
		expect(parsed.filesChanged).toBe(1);
		expect(parsed.insertions).toBe(1);
		expect(parsed.deletions).toBeUndefined();
	});

	it("parses a nothing-to-commit commit as a single status line", () => {
		const parsed = parseGitOutput({ kind: "action", command: "commit" }, COMMIT_NOTHING_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.status).toBe("nothing to commit");
		expect(parsed.hash).toBeUndefined();
		expect(parsed.subject).toBeUndefined();
	});

	it("parses a push of a new branch (remote + ref row, tracking info dropped)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "push" }, PUSH_NEW_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.remote).toBe("../c8-remote.git");
		expect(parsed.refs).toEqual(["* [new branch] main -> main"]);
		expect(parsed.status).toBeUndefined();
	});

	it("parses a push update (hash-range ref row)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "push" }, PUSH_UPDATE_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.remote).toBe("../c8-remote.git");
		expect(parsed.refs).toEqual(["0d6329b..17a9bea main -> main"]);
	});

	it("parses an everything-up-to-date push", () => {
		const parsed = parseGitOutput({ kind: "action", command: "push" }, PUSH_UPTODATE_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.status).toBe("Everything up-to-date");
		expect(parsed.refs).toBeUndefined();
		expect(parsed.remote).toBeUndefined();
	});

	it("skips enumeration/remote noise lines but keeps the ref row", () => {
		const parsed = parseGitOutput({ kind: "action", command: "push" }, PUSH_WITH_NOISE_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.remote).toBe("../c8-remote.git");
		expect(parsed.refs).toEqual(["0d6329b..17a9bea main -> main"]);
	});

	it("parses a fast-forward pull (range, Fast-forward, stat block)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "pull" }, PULL_FF_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.status).toBe("Fast-forward");
		expect(parsed.range).toBe("17a9bea..ae553b1");
		expect(parsed.filesChanged).toBe(1);
		expect(parsed.insertions).toBe(1);
		expect(parsed.files).toEqual([{ path: "a.txt", changes: 1 }]);
	});

	it("parses an already-up-to-date pull", () => {
		const parsed = parseGitOutput({ kind: "action", command: "pull" }, PULL_UPTODATE_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.status).toBe("Already up to date.");
		expect(parsed.range).toBeUndefined();
	});

	it("parses a fetch with a new ref (From line + ref row)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "fetch" }, FETCH_NEW_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.remote).toBe("../c8-remote");
		expect(parsed.refs).toEqual(["17a9bea..ae553b1 main -> origin/main"]);
	});

	it("parses an empty fetch as `no new refs`", () => {
		const parsed = parseGitOutput({ kind: "action", command: "fetch" }, "");
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.status).toBe("no new refs");
		expect(parsed.refs).toBeUndefined();
	});

	it.each([
		["commit", COMMIT_SUCCESS_FIXTURE],
		["push", PUSH_UPDATE_FIXTURE],
		["pull", PULL_FF_FIXTURE],
		["fetch", FETCH_NEW_FIXTURE],
	])("returns null on unknown lines for %s (fallback to boxed shell)", (command, _fixture) => {
		expect(
			parseGitOutput({ kind: "action", command: command as "commit" | "push" | "pull" | "fetch" }, "random nonsense"),
		).toBeNull();
	});

	it("returns null on a commit with an unparseable first line", () => {
		expect(parseGitOutput({ kind: "action", command: "commit" }, "random nonsense")).toBeNull();
	});
});

describe("parseGitOutput — git action (switch/checkout/add/restore/reset/merge/rebase)", () => {
	it("parses a new-branch switch (created + branch)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "switch" }, "Switched to a new branch 'feature'");
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed).toMatchObject({ command: "switch", branch: "feature", created: true });
	});

	it("parses an existing-branch switch, skipping advisory branch-state lines", () => {
		const parsed = parseGitOutput(
			{ kind: "action", command: "switch" },
			"Switched to branch 'main'\nYour branch is up to date with 'origin/main'.",
		);
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed).toMatchObject({ command: "switch", branch: "main" });
		expect(parsed.created).toBeUndefined();
	});

	it("parses checkout -b and silent checkout -- <file>", () => {
		const created = parseGitOutput({ kind: "action", command: "checkout" }, "Switched to a new branch 'feat2'");
		if (created?.kind !== "action") throw new Error("expected action parse");
		expect(created).toMatchObject({ command: "checkout", branch: "feat2", created: true });

		const silent = parseGitOutput({ kind: "action", command: "checkout" }, "");
		if (silent?.kind !== "action") throw new Error("expected action parse");
		expect(silent.status).toBe("completed, no output");
	});

	it("parses silent add/restore success", () => {
		for (const command of ["add", "restore"] as const) {
			const parsed = parseGitOutput({ kind: "action", command }, "");
			if (parsed?.kind !== "action") throw new Error("expected action parse");
			expect(parsed.status).toBe("completed, no output");
		}
	});

	it("parses a mixed reset with unstaged changes into resetFiles rows", () => {
		const parsed = parseGitOutput({ kind: "action", command: "reset" }, "Unstaged changes after reset:\nM\ta.txt");
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed.resetFiles).toEqual([{ x: "M", y: " ", path: "a.txt" }]);
	});

	it("parses reset --hard HEAD is now at (hash + subject)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "reset" }, "HEAD is now at c852e01 initial");
		if (parsed?.kind !== "action") throw new Error("expected action parse");
		expect(parsed).toMatchObject({ command: "reset", hash: "c852e01", subject: "initial" });
	});

	it("parses merge up to date, fast-forward with stat, and merge-made", () => {
		const uptodate = parseGitOutput({ kind: "action", command: "merge" }, "Already up to date.");
		if (uptodate?.kind !== "action") throw new Error("expected action parse");
		expect(uptodate.status).toBe("Already up to date.");

		const ff = parseGitOutput(
			{ kind: "action", command: "merge" },
			"Updating 17a9bea..ae553b1\nFast-forward\n a.txt | 1 +\n 1 file changed, 1 insertion(+)",
		);
		if (ff?.kind !== "action") throw new Error("expected action parse");
		expect(ff).toMatchObject({
			command: "merge",
			status: "Fast-forward",
			range: "17a9bea..ae553b1",
			filesChanged: 1,
			insertions: 1,
		});

		const made = parseGitOutput(
			{ kind: "action", command: "merge" },
			"Merge made by the 'ort' strategy.\n a.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
		);
		if (made?.kind !== "action") throw new Error("expected action parse");
		expect(made).toMatchObject({ command: "merge", status: "Merge made by the 'ort' strategy.", filesChanged: 1 });
	});

	it("parses rebase success and up-to-date, stripping the trailing period from the branch", () => {
		const success = parseGitOutput(
			{ kind: "action", command: "rebase" },
			"Successfully rebased and updated refs/heads/feature.",
		);
		if (success?.kind !== "action") throw new Error("expected action parse");
		expect(success).toMatchObject({ command: "rebase", branch: "feature", status: "Rebased" });

		const uptodate = parseGitOutput({ kind: "action", command: "rebase" }, "Current branch feature is up to date.");
		if (uptodate?.kind !== "action") throw new Error("expected action parse");
		expect(uptodate).toMatchObject({ branch: "feature", status: "Up to date." });
	});

	it.each([
		["switch", "localized weird text here"],
		["checkout", "M  a.txt\nM  b.txt"], // switch -m merge rows → fail closed
		["merge", "merging stuff\nunrecognized"],
		["rebase", "CONFLICT (content): Merge conflict in a.txt"],
		["reset", "HEAD is now at x\nUnstaged changes after reset:\nM\ta.txt"],
	] as const)("returns null on %s hostile output", (command, hostile) => {
		expect(parseGitOutput({ kind: "action", command }, hostile)).toBeNull();
	});
});

describe("renderGitCardLines — git action (8C-2 commands)", () => {
	it("renders switch/checkout branch in the header", () => {
		const parsed = parseGitOutput({ kind: "action", command: "switch" }, "Switched to a new branch 'feature'");
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "switch" }, parsed }, 80));
		expect(lines[0]).toBe("Git switch · feature");

		const co = parseGitOutput({ kind: "action", command: "checkout" }, "Switched to a new branch 'feat2'");
		if (!co) throw new Error("expected parse");
		const coLines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "checkout" }, parsed: co }, 80));
		expect(coLines[0]).toBe("Git checkout · feat2");
	});

	it("renders silent add/restore and reset rows", () => {
		const add = parseGitOutput({ kind: "action", command: "add" }, "");
		if (!add) throw new Error("expected parse");
		const addLines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "add" }, parsed: add }, 80));
		expect(addLines[1]).toBe("  completed, no output");

		const reset = parseGitOutput({ kind: "action", command: "reset" }, "Unstaged changes after reset:\nM\ta.txt");
		if (!reset) throw new Error("expected parse");
		const resetLines = plain(
			renderGitCardLines(theme, { cls: { kind: "action", command: "reset" }, parsed: reset }, 80),
		);
		expect(resetLines[1]).toBe("  └─ M  a.txt");
	});

	it("renders a fast-forward merge card with range and stat", () => {
		const parsed = parseGitOutput(
			{ kind: "action", command: "merge" },
			"Updating 17a9bea..ae553b1\nFast-forward\n a.txt | 1 +\n 1 file changed, 1 insertion(+)",
		);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "merge" }, parsed }, 80));
		expect(lines).toEqual([
			"Git merge",
			"  17a9bea..ae553b1",
			"  Fast-forward",
			"  1 file changed · +1",
			"  └─ a.txt · 1 change",
		]);
	});

	it("renders a rebase card with branch and status", () => {
		const parsed = parseGitOutput(
			{ kind: "action", command: "rebase" },
			"Successfully rebased and updated refs/heads/feature.",
		);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "rebase" }, parsed }, 80));
		expect(lines).toEqual(["Git rebase · feature", "  Rebased"]);
	});

	it("keeps action cards width-safe", () => {
		const parsed = parseGitOutput(
			{ kind: "action", command: "merge" },
			"Updating 17a9bea..ae553b1\nFast-forward\n a.txt | 1 +\n 1 file changed, 1 insertion(+)",
		);
		if (!parsed) throw new Error("expected parse");
		for (const width of [20, 40, 80]) {
			for (const line of renderGitCardLines(theme, { cls: { kind: "action", command: "merge" }, parsed }, width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});
});

describe("renderGitCardLines", () => {
	it("renders a pending call as a single header line", () => {
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "status", short: false } }, 80));
		expect(lines).toEqual(["Git status"]);
	});

	it("renders a git status card with counts and rows", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, LONG_STATUS_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "status", short: false }, parsed }, 80));
		expect(lines[0]).toBe("Git status");
		expect(lines[1]).toBe("  3 modified · 1 untracked");
		expect(lines[2]).toBe("  ├─ M  ROADMAP.md");
		expect(lines[3]).toBe("  ├─ M  docs/decisions/README.md");
		expect(lines[4]).toBe("  ├─ M  docs/ui/MESSAGES-AND-TOOLS.md");
		expect(lines[5]).toBe("  └─ ?  docs/decisions/0005-git-github-semantic-renderers.md");
	});

	it("renders a clean status card without counts", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, CLEAN_STATUS_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "status", short: false }, parsed }, 80));
		expect(lines[1]).toBe("  nothing to commit, working tree clean");
	});

	it("shows the branch only when ahead/behind affects the result", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, DIVERGED_STATUS_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "status", short: false }, parsed }, 80));
		expect(lines[1]).toBe("  nothing to commit, working tree clean");
		expect(lines[2]).toBe("  main · ahead 1 · behind 2");
	});

	it("collapses long file lists into a … N more row", () => {
		const files = Array.from({ length: 20 }, (_, i) => ({ x: " ", y: "M", path: `src/file${i}.ts` }));
		const parsed = { kind: "status" as const, files };
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "status", short: false }, parsed }, 80));
		expect(lines.filter((line) => line.includes("├─") || line.includes("└─")).length).toBe(7); // 6 rows + more row
		expect(lines.at(-1)).toBe("  └─ … 14 more files");
	});

	it("renders a diff --stat card with exact change counts", () => {
		const parsed = parseGitOutput({ kind: "diff-stat" }, DIFF_STAT_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "diff-stat" }, parsed }, 80));
		expect(lines[0]).toBe("Git diff --stat");
		expect(lines[1]).toBe("  3 files changed · +105 -3");
		expect(lines[2]).toBe("  ├─ ROADMAP.md · 57 changes");
		expect(lines[3]).toBe("  ├─ docs/decisions/README.md · 1 change");
		expect(lines.at(-1)).toBe("  └─ docs/ui/MESSAGES-AND-TOOLS.md · 50 changes");
	});

	it("renders binary diff-stat rows and the no-changes state", () => {
		const parsed = parseGitOutput({ kind: "diff-stat" }, DIFF_STAT_BINARY_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "diff-stat" }, parsed }, 80));
		expect(lines[2]).toBe("  ├─ bin.dat · binary");
		expect(lines[3]).toBe("  ├─ old.txt => new.txt · 0 changes");

		const empty = parseGitOutput({ kind: "diff-stat" }, "");
		if (!empty) throw new Error("expected parse");
		expect(plain(renderGitCardLines(theme, { cls: { kind: "diff-stat" }, parsed: empty }, 80))[1]).toBe("  no changes");
	});

	it("renders a log card with hash, subject, and refs", () => {
		const parsed = parseGitOutput({ kind: "log" }, LOG_ONELINE_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "log" }, parsed }, 120));
		expect(lines[0]).toBe("Git log");
		expect(lines[1]).toBe("  ├─ 1b7252d (HEAD -> main, origin/main, origin/HEAD)  feat: rounded dock editor frame");
		expect(lines[3]).toBe("  └─ 8d99731  feat: strict boxed tool-card state machine");
	});

	it("keeps Git headers portable when the legacy Nerd Font flag is enabled", () => {
		setToolsRenderConfig({ nerdFonts: true });
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "log" } }, 80));
		expect(lines[0]).toBe("Git log");
	});

	it("keeps every rendered line width-safe", () => {
		const parsed = parseGitOutput({ kind: "status", short: false }, LONG_STATUS_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		for (const width of [20, 40, 80]) {
			for (const line of renderGitCardLines(theme, { cls: { kind: "status", short: false }, parsed }, width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});

	it("renders a git diff card header with file count and +/− totals", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, DIFF_TWO_FILE_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "diff", show: false }, parsed }, 80));
		expect(lines[0]).toBe("Git diff");
		expect(lines[1]).toBe("  2 files +1 -1");
	});

	it("renders a git show card header with short hash and subject", () => {
		const parsed = parseGitOutput({ kind: "diff", show: true }, SHOW_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "diff", show: true }, parsed }, 100));
		expect(lines[0]).toBe("Git show · 1b7252d · feat: rounded dock editor frame with dim hint");
		expect(lines[1]).toBe("  2 files +1 -1");
	});

	it("renders a pending git diff call as a single header line", () => {
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "diff", show: false } }, 80));
		expect(lines).toEqual(["Git diff"]);
	});

	it("renders an empty diff card as no changes", () => {
		const parsed = parseGitOutput({ kind: "diff", show: false }, "");
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "diff", show: false }, parsed }, 80));
		expect(lines[1]).toBe("  no changes");
	});

	it("renders a git show --stat card with header, summary, and file rows", () => {
		const parsed = parseGitOutput({ kind: "show-stat" }, SHOW_STAT_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "show-stat" }, parsed }, 120));
		expect(lines[0]).toBe(
			"Git show · 1b7252d · feat: rounded dock editor frame with dim hint, zero-trace thinking collapse",
		);
		expect(lines[1]).toBe("  17 files changed · +590 -71");
		expect(lines[2]).toBe("  ├─ CHANGELOG.md · 19 changes");
		expect(lines.at(-1)).toBe("  └─ … 11 more files");
	});

	it("renders a pending git show --stat call as a single header line", () => {
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "show-stat" } }, 80));
		expect(lines).toEqual(["Git show"]);
	});

	it("renders a no-changes git show --stat card", () => {
		const parsed = parseGitOutput({ kind: "show-stat" }, SHOW_STAT_NO_CHANGES_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "show-stat" }, parsed }, 80));
		expect(lines[0]).toBe("Git show · 0000000 · chore: empty commit with no file changes");
		expect(lines[1]).toBe("  no changes");
	});

	it("keeps every git show --stat rendered line width-safe", () => {
		const parsed = parseGitOutput({ kind: "show-stat" }, SHOW_STAT_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		for (const width of [20, 40, 80]) {
			for (const line of renderGitCardLines(theme, { cls: { kind: "show-stat" }, parsed }, width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});

	it("renders a pending action call as a single header line", () => {
		for (const command of ["commit", "push", "pull", "fetch"] as const) {
			const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command } }, 80));
			expect(lines).toEqual([`Git ${command}`]);
		}
	});

	it("renders an everything-up-to-date push card", () => {
		const parsed = parseGitOutput({ kind: "action", command: "push" }, PUSH_UPTODATE_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "push" }, parsed }, 80));
		expect(lines[0]).toBe("Git push");
		expect(lines[1]).toBe("  Everything up-to-date");
	});

	it("renders a push card with the remote + normalized ref row", () => {
		const parsed = parseGitOutput({ kind: "action", command: "push" }, PUSH_NEW_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "push" }, parsed }, 80));
		expect(lines[0]).toBe("Git push");
		expect(lines[1]).toBe("  To ../c8-remote.git");
		expect(lines[2]).toBe("  * [new branch] main -> main");
	});

	it("renders a fast-forward pull card (range, Fast-forward, summary, row)", () => {
		const parsed = parseGitOutput({ kind: "action", command: "pull" }, PULL_FF_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "pull" }, parsed }, 80));
		expect(lines[0]).toBe("Git pull");
		expect(lines[1]).toBe("  17a9bea..ae553b1");
		expect(lines[2]).toBe("  Fast-forward");
		expect(lines[3]).toBe("  1 file changed · +1");
		expect(lines[4]).toBe("  └─ a.txt · 1 change");
	});

	it("renders an already-up-to-date pull card", () => {
		const parsed = parseGitOutput({ kind: "action", command: "pull" }, PULL_UPTODATE_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "pull" }, parsed }, 80));
		expect(lines[0]).toBe("Git pull");
		expect(lines[1]).toBe("  Already up to date.");
	});

	it("renders a successful commit card with hash + subject in the header", () => {
		const parsed = parseGitOutput({ kind: "action", command: "commit" }, COMMIT_SUCCESS_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "commit" }, parsed }, 80));
		expect(lines[0]).toBe("Git commit · c852e01 · feat: add b line");
		expect(lines[1]).toBe("  1 file changed · +1");
	});

	it("renders a nothing-to-commit commit card", () => {
		const parsed = parseGitOutput({ kind: "action", command: "commit" }, COMMIT_NOTHING_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "commit" }, parsed }, 80));
		expect(lines[0]).toBe("Git commit");
		expect(lines[1]).toBe("  nothing to commit");
	});

	it("renders a fetch card with the From line + ref row", () => {
		const parsed = parseGitOutput({ kind: "action", command: "fetch" }, FETCH_NEW_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGitCardLines(theme, { cls: { kind: "action", command: "fetch" }, parsed }, 80));
		expect(lines[0]).toBe("Git fetch");
		expect(lines[1]).toBe("  From ../c8-remote");
		expect(lines[2]).toBe("  17a9bea..ae553b1 main -> origin/main");
	});

	it("keeps every action rendered line width-safe", () => {
		const fixtures: Array<{ command: "commit" | "push" | "pull" | "fetch"; text: string }> = [
			{ command: "commit", text: COMMIT_SUCCESS_FIXTURE },
			{ command: "push", text: PUSH_WITH_NOISE_FIXTURE },
			{ command: "pull", text: PULL_FF_FIXTURE },
			{ command: "fetch", text: FETCH_NEW_FIXTURE },
		];
		for (const { command, text } of fixtures) {
			const parsed = parseGitOutput({ kind: "action", command }, text);
			if (!parsed) throw new Error(`expected parse for ${command}`);
			for (const width of [20, 40, 80]) {
				for (const line of renderGitCardLines(theme, { cls: { kind: "action", command }, parsed }, width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
				}
			}
		}
	});
});

describe("bash dispatch — git routing", () => {
	it("renders git status output as a compact card in the call panel", () => {
		const ctx1 = context({ toolCallId: "g1", args: { command: "git status", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git status", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(LONG_STATUS_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Git status");
		expect(lines.join("\n")).toContain("├─ M  ROADMAP.md");
		expect(result.render(80)).toEqual([]); // card lives in the call panel
	});

	it("renders git diff --stat as a compact card", () => {
		const ctx1 = context({ toolCallId: "g2", args: { command: "git diff --stat", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git diff --stat", timeout: 30 }, theme, ctx1);
		dispatchResult("bash", textResult(DIFF_STAT_FIXTURE), { expanded: false, isPartial: false }, theme, ctx1);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Git diff --stat");
		expect(lines[1]).toBe("  3 files changed · +105 -3");
	});

	it("renders a pending classified git call as a header line", () => {
		const ctx1 = context({ toolCallId: "g3", args: { command: "git status", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git status", timeout: 30 }, theme, ctx1);
		expect(plain(call.render(80))).toEqual(["Git status"]);
	});

	it("falls back to the boxed shell when git output cannot parse", () => {
		const ctx1 = context({ toolCallId: "g4", args: { command: "git diff --stat", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git diff --stat", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult("not a diff stat at all"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
		expect(plain(call.render(80))[0]).toContain("Bash"); // boxed call panel
	});

	it("renders git switch as a card in the call panel", () => {
		const ctx1 = context({
			toolCallId: "g-switch",
			args: { command: "git switch feature", timeout: 30 },
			cwd: "/fake",
		});
		const call = dispatchCall("bash", { command: "git switch feature", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult("Switched to a new branch 'feature'"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(call.render(80))[0]).toBe("Git switch · feature");
		expect(result.render(80)).toEqual([]); // card lives in the call panel
	});

	it("keeps the boxed shell for piped git commands", () => {
		const ctx1 = context({ toolCallId: "g5", args: { command: "git status | head -5", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "git status | head -5", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(" M ROADMAP.md"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
	});

	it("keeps historical git panels rendering after a registry reset", () => {
		const ctx1 = context({ toolCallId: "g6", args: { command: "git status", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git status", timeout: 30 }, theme, ctx1);
		dispatchResult("bash", textResult(LONG_STATUS_FIXTURE), { expanded: false, isPartial: false }, theme, ctx1);
		resetBashTreeRegistry(); // session boundary
		expect(plain(call.render(80))[0]).toBe("Git status");
	});

	it("still classifies ls/find/grep trees alongside git", () => {
		expect(classifyBashCommand("ls src/")).toMatchObject({ kind: "ls" });
		expect(classifyBashCommand("git status")).toBeNull();
	});

	it("renders git diff as a boxed adaptive diff (one frame per file)", () => {
		const ctx1 = context({ toolCallId: "d1", args: { command: "git diff", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git diff", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(DIFF_SINGLE_FILE_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		// Call panel: boxless header + summary line (Git header lives outside the box).
		const callLines = plain(call.render(80));
		expect(callLines[0]).toBe("Git diff");
		expect(callLines[1]).toBe("  1 file +1 -1");
		// Result: one complete box per file — the frame top border carries
		// `path · +N -M` (no `Diff` divider), then the diff body and a footer
		// with the file count.
		const out = plain(result.render(80)).join("\n");
		expect(result.render(80).length).toBeGreaterThan(0); // NOT the empty tree result
		expect(out).toContain("docs/ui/THEMING.md");
		expect(out).toContain("docs/ui/THEMING.md · +1 -1");
		expect(out).not.toContain("Diff · ");
		expect(out).not.toContain("1 file"); // single frame implies the count
		expect(out).toContain("╭─"); // a per-file frame top border
		expect(out).toContain("╰─"); // a per-file frame bottom border
		expect(out).toContain("+"); // an added diff line marker
	});

	it("renders git show with hash/subject header and one box per file", () => {
		const ctx1 = context({ toolCallId: "d2", args: { command: "git show", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git show", timeout: 30 }, theme, ctx1);
		const result = dispatchResult("bash", textResult(SHOW_FIXTURE), { expanded: false, isPartial: false }, theme, ctx1);
		const callLines = plain(call.render(120));
		expect(callLines[0]).toContain("Git show · 1b7252d ·");
		// Two files → two frames (two distinct top borders).
		const frames = plain(result.render(120)).join("\n");
		expect(frames).toContain("foo.ts");
		expect(frames).toContain("bin.dat");
		expect(frames).toContain("Binary"); // binary file frame divider
	});

	it("falls back to the boxed shell when git diff output cannot parse", () => {
		const ctx1 = context({ toolCallId: "d3", args: { command: "git diff", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "git diff", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult("totally not a git diff at all"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
	});

	it("renders git diff boxes width-safe at 20/40/80", () => {
		const ctx1 = context({ toolCallId: "d4", args: { command: "git diff", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "git diff", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(DIFF_SINGLE_FILE_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		for (const width of [20, 40, 80]) {
			for (const line of result.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});

	it("does not parse git diff on partial (streaming) output", () => {
		const ctx1 = context({ toolCallId: "d5", args: { command: "git diff", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "git diff", timeout: 30 }, theme, ctx1);
		const partial = dispatchResult(
			"bash",
			textResult("diff --git a/foo b/foo\n@@ -1 +1 @@\n+incomplete"),
			{ expanded: false, isPartial: true },
			theme,
			ctx1,
		);
		// Partial diff output does not render the boxed diff (parse runs on the
		// terminal result only); the streaming shell renders instead.
		expect(plain(partial.render(80)).join("\n")).not.toContain("Diff · ");
	});

	it("renders git show --stat as a compact card in the call panel", () => {
		const ctx1 = context({ toolCallId: "s1", args: { command: "git show --stat HEAD", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git show --stat HEAD", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(SHOW_STAT_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(120));
		expect(lines[0]).toBe(
			"Git show · 1b7252d · feat: rounded dock editor frame with dim hint, zero-trace thinking collapse",
		);
		expect(lines[1]).toBe("  17 files changed · +590 -71");
		expect(lines[2]).toBe("  ├─ CHANGELOG.md · 19 changes");
		expect(result.render(120)).toEqual([]); // card lives in the call panel
	});

	it("renders git push as a card in the call panel with an empty result", () => {
		const ctx1 = context({ toolCallId: "a1", args: { command: "git push", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git push", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(PUSH_UPTODATE_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Git push");
		expect(lines[1]).toBe("  Everything up-to-date");
		expect(result.render(80)).toEqual([]); // action card lives in the call panel
	});

	it("renders git commit on an exit-1 nothing-to-commit result as a card", () => {
		const ctx1 = context({ toolCallId: "a2", args: { command: "git commit", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "git commit", timeout: 30 }, theme, ctx1);
		dispatchResult(
			"bash",
			textResult(COMMIT_NOTHING_FIXTURE),
			{ expanded: false, isPartial: false, isError: true },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("Git commit");
		expect(lines[1]).toBe("  nothing to commit");
	});

	it("falls back to the boxed shell when a push is rejected (unparseable)", () => {
		const ctx1 = context({ toolCallId: "a3", args: { command: "git push", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "git push", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult("! [rejected] main -> main (non-fast-forward)"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
	});
});
