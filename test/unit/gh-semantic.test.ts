import { afterEach, describe, expect, it } from "vitest";
import {
	classifyBashCommand,
	classifyBashSemantic,
	resetBashTreeRegistry,
} from "../../extension-src/pi-style/features/tools/boxed/bash.js";
import {
	classifyGhCommand,
	parseGhOutput,
	renderGhCardLines,
} from "../../extension-src/pi-style/features/tools/boxed/gh.js";
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

// Fixtures captured from real gh 2.94.0 output (see docs/decisions/0005).
const PR_LIST_FIXTURE = [
	"14078\tRoute run artifact listing through api.Client\twilliammartin-route-run-artifacts-api-client\tOPEN\t2026-08-05T12:19:51Z",
	"14077\tRoute release deletions through api.Client\twilliammartin-wp-05-release-api-client\tOPEN\t2026-08-05T12:19:30Z",
].join("\n");

const PR_LIST_JSON_FIXTURE = JSON.stringify([
	{
		number: 14078,
		title: "Route run artifact listing through api.Client",
		headRefName: "feature-api-client",
		state: "OPEN",
	},
	{ number: 14069, title: "Ship the redesign", headRefName: "redesign", state: "CLOSED" },
]);

// Real `gh pr view` rich output: a `key:\tvalue` block, a `--` separator, then
// the markdown body. base/head/changedFiles/mergeable are JSON-only fields.
const PR_VIEW_FIXTURE = [
	"title:\tRoute run artifact listing through api.Client",
	"state:\tOPEN",
	"author:\twilliammartin (William Martin)",
	"labels:\t",
	"assignees:\t",
	"reviewers:\tCopilot (AI) (Commented), babks (Approved)",
	"projects:\t",
	"milestone:\t",
	"number:\t14078",
	"url:\thttps://github.com/cli/cli/pull/14078",
	"additions:\t37",
	"deletions:\t42",
	"auto-merge:\tdisabled",
	"--",
	"<!--",
	"PR body markdown here",
	"-->",
].join("\n");

const PR_VIEW_JSON_FIXTURE = JSON.stringify({
	additions: 37,
	author: { login: "williammartin" },
	baseRefName: "main",
	changedFiles: 5,
	deletions: 42,
	headRefName: "feature",
	mergeable: "MERGEABLE",
	number: 14078,
	reviewDecision: "APPROVED",
	state: "OPEN",
	title: "Route run artifact listing through api.Client",
});

const PR_CHECKS_FIXTURE = [
	"build (ubuntu-latest)\tpass\t4m45s\thttps://github.com/cli/cli/actions/runs/31005145693/job/92303128728",
	"label-external\tskipping\t0\thttps://github.com/cli/cli",
].join("\n");

const PR_CREATE_FIXTURE = "https://github.com/quanpersie2001/pi-style/pull/42";

const ISSUE_LIST_FIXTURE = [
	"5\tFix the flaky test\tOPEN\t2026-08-05T12:00:00Z",
	"4\tDocs typo\tCLOSED\t2026-08-04T10:00:00Z",
].join("\n");

const ISSUE_VIEW_FIXTURE = [
	"title:\tFix the flaky test",
	"state:\tOPEN",
	"author:\tcontributor (Some One)",
	"labels:\tbug",
	"assignees:\t",
	"number:\t5",
	"url:\thttps://github.com/cli/cli/issues/5",
	"--",
	"This issue has a body.",
].join("\n");

const RUN_LIST_FIXTURE = [
	"completed\tsuccess\tfeat: rounded dock editor frame with dim hint\tCI\tmain\tpush\t31025433335\t38s\t2026-08-05T16:28:26Z",
	"completed\tsuccess\tRelease\tRelease\tmain\tworkflow_dispatch\t30988004711\t57s\t2026-08-05T08:11:21Z",
].join("\n");

const RUN_LIST_JSON_FIXTURE = JSON.stringify([
	{
		conclusion: "success",
		databaseId: 31025433335,
		event: "push",
		headBranch: "main",
		name: "CI",
		status: "completed",
		workflowName: "CI",
	},
]);

const RUN_VIEW_FIXTURE = [
	"✓ main CI · 31025433335",
	"Triggered via push about 2 hours ago",
	"",
	"JOBS",
	"✓ check (22) in 35s (ID 92372530325)",
	"",
	"ANNOTATIONS",
	"! Node.js 20 is deprecated.",
	"",
	"For more information about the job, try: gh run view --job=92372530325",
	"View this run on GitHub: https://github.com/quanpersie2001/pi-style/actions/runs/31025433335",
].join("\n");

const RUN_VIEW_FAIL_FIXTURE = [
	"✗ main CI · 30988004711",
	"Triggered via workflow_dispatch about 1 hour ago",
	"",
	"JOBS",
	"✗ build (3) in 1m10s (ID 92372530326)",
	"",
	"For more information about the job, try: gh run view --job=92372530326",
	"View this run on GitHub: https://github.com/quanpersie2001/pi-style/actions/runs/30988004711",
].join("\n");

const RUN_JOB_LOG_FIXTURE = ["Run npm ci", "  npm warn deprecated inflight", "Pass — exit 0"].join("\n");

afterEach(() => {
	resetBashTreeRegistry();
	setToolsRenderConfig({ nerdFonts: false });
});

describe("classifyGhCommand", () => {
	it.each([
		["gh pr list", { kind: "pr-list" }],
		["gh pr view 128", { kind: "pr-view" }],
		["gh pr checks 128", { kind: "pr-checks" }],
		["gh pr create --fill", { kind: "pr-create" }],
		["gh issue list", { kind: "issue-list" }],
		["gh issue view 5", { kind: "issue-view" }],
		["gh run list", { kind: "run-list" }],
		["gh run view 123", { kind: "run-view" }],
		["gh run view --job=456", { kind: "run-job", jobId: "456" }],
		["gh run view --job 456", { kind: "run-job", jobId: "456" }],
		["gh -R cli/cli pr list", { kind: "pr-list" }],
		["gh pr list -R cli/cli", { kind: "pr-list" }],
		["gh --repo cli/cli issue list", { kind: "issue-list" }],
		["gh --repo=cli/cli issue list", { kind: "issue-list" }],
		["gh run list -L 5", { kind: "run-list" }],
		["/usr/bin/gh run list", { kind: "run-list" }],
	])("classifies %s", (command, expected) => {
		expect(classifyGhCommand(command)).toMatchObject(expected);
	});

	it.each([
		"gh run watch 123",
		"gh api repos",
		"gh pr list | head",
		"gh pr list && echo",
		"gh pr list > out.txt",
		"echo hi",
		"gh",
		"gh run",
		"gh pr",
		"gh pr close 1",
		"gh pr merge 1",
		"gh issue create",
		"gh issue close 1",
		"gh repo view",
		"gh auth login",
		"gh run download 1",
		"gh run cancel 1",
		"git status",
		"ls src/",
	])("does not classify %s (keeps boxed shell)", (command) => {
		expect(classifyGhCommand(command)).toBeNull();
	});

	it("classifies gh via the semantic dispatch alongside trees and git", () => {
		expect(classifyBashCommand("gh pr list")).toBeNull(); // gh is not a tree
		expect(classifyBashSemantic("gh pr list")).toMatchObject({ kind: "pr-list" });
		expect(classifyBashSemantic("git status")).toMatchObject({ kind: "status", short: false });
		expect(classifyBashSemantic("ls src/")).toMatchObject({ kind: "ls" });
	});
});

describe("parseGhOutput — pr list / issue list", () => {
	it("parses pr list tab-separated rows (number, title, branch, state)", () => {
		const parsed = parseGhOutput({ kind: "pr-list" }, PR_LIST_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "pr-list") throw new Error("expected pr-list parse");
		expect(parsed.rows).toEqual([
			{
				number: 14078,
				title: "Route run artifact listing through api.Client",
				branch: "williammartin-route-run-artifacts-api-client",
				state: "OPEN",
			},
			{
				number: 14077,
				title: "Route release deletions through api.Client",
				branch: "williammartin-wp-05-release-api-client",
				state: "OPEN",
			},
		]);
	});

	it("parses pr list --json array", () => {
		const parsed = parseGhOutput({ kind: "pr-list" }, PR_LIST_JSON_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "pr-list") throw new Error("expected pr-list parse");
		expect(parsed.rows).toEqual([
			{
				number: 14078,
				title: "Route run artifact listing through api.Client",
				branch: "feature-api-client",
				state: "OPEN",
			},
			{ number: 14069, title: "Ship the redesign", branch: "redesign", state: "CLOSED" },
		]);
	});

	it("parses issue list rows (no branch column)", () => {
		const parsed = parseGhOutput({ kind: "issue-list" }, ISSUE_LIST_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "issue-list") throw new Error("expected issue-list parse");
		expect(parsed.rows).toEqual([
			{ number: 5, title: "Fix the flaky test", state: "OPEN" },
			{ number: 4, title: "Docs typo", state: "CLOSED" },
		]);
	});

	it("parses an empty list as no rows", () => {
		const parsed = parseGhOutput({ kind: "pr-list" }, "");
		if (parsed?.kind !== "pr-list") throw new Error("expected pr-list parse");
		expect(parsed.rows).toEqual([]);
	});

	it.each([
		["non-numeric number", "notanumber\tTitle\tOPEN\t2026-01-01T00:00:00Z"],
		["too few columns", "14078\tOnly two"],
		["missing state token", "14078\tTitle\tbranch\t2026-01-01T00:00:00Z"],
		["hostile text", "totally not gh output"],
		["invalid json starting with {", "{not valid json"],
	])("returns null on %s (fallback to boxed shell)", (_label, hostile) => {
		expect(parseGhOutput({ kind: "pr-list" }, hostile)).toBeNull();
	});
});

describe("parseGhOutput — pr view / issue view", () => {
	it("parses pr view rich fields and body", () => {
		const parsed = parseGhOutput({ kind: "pr-view" }, PR_VIEW_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "pr-view") throw new Error("expected pr-view parse");
		expect(parsed.title).toBe("Route run artifact listing through api.Client");
		expect(parsed.state).toBe("OPEN");
		expect(parsed.number).toBe(14078);
		expect(parsed.additions).toBe(37);
		expect(parsed.deletions).toBe(42);
		expect(parsed.reviewers).toBe("Copilot (AI) (Commented), babks (Approved)");
		expect(parsed.url).toBe("https://github.com/cli/cli/pull/14078");
		expect(parsed.body).toContain("PR body markdown here");
	});

	it("parses pr view --json (base/head/mergeable/changedFiles)", () => {
		const parsed = parseGhOutput({ kind: "pr-view" }, PR_VIEW_JSON_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "pr-view") throw new Error("expected pr-view parse");
		expect(parsed.title).toBe("Route run artifact listing through api.Client");
		expect(parsed.state).toBe("OPEN");
		expect(parsed.baseRefName).toBe("main");
		expect(parsed.headRefName).toBe("feature");
		expect(parsed.mergeable).toBe("MERGEABLE");
		expect(parsed.reviewDecision).toBe("APPROVED");
		expect(parsed.changedFiles).toBe(5);
	});

	it("parses issue view rich fields and body", () => {
		const parsed = parseGhOutput({ kind: "issue-view" }, ISSUE_VIEW_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "issue-view") throw new Error("expected issue-view parse");
		expect(parsed.title).toBe("Fix the flaky test");
		expect(parsed.number).toBe(5);
		expect(parsed.labels).toBe("bug");
		expect(parsed.body).toBe("This issue has a body.");
	});

	it.each([
		["unrecognized line", "random text\nwith no key"],
		["hostile json", "{not json"],
		["missing state", "title:\tNo state here\n--\nbody"],
	])("returns null on %s (fallback to boxed shell)", (_label, hostile) => {
		expect(parseGhOutput({ kind: "pr-view" }, hostile)).toBeNull();
	});
});

describe("parseGhOutput — pr checks / pr create", () => {
	it("parses pr checks rows (name, state, duration)", () => {
		const parsed = parseGhOutput({ kind: "pr-checks" }, PR_CHECKS_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "pr-checks") throw new Error("expected pr-checks parse");
		expect(parsed.rows).toEqual([
			{
				name: "build (ubuntu-latest)",
				state: "pass",
				duration: "4m45s",
				url: "https://github.com/cli/cli/actions/runs/31005145693/job/92303128728",
			},
			{ name: "label-external", state: "skipping", duration: "0", url: "https://github.com/cli/cli" },
		]);
	});

	it("returns null on an unknown check state", () => {
		expect(parseGhOutput({ kind: "pr-checks" }, "build\tmade-up-state\t4m\thttps://x")).toBeNull();
	});

	it("parses pr create success URL and number", () => {
		const parsed = parseGhOutput({ kind: "pr-create" }, PR_CREATE_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "pr-create") throw new Error("expected pr-create parse");
		expect(parsed.url).toBe("https://github.com/quanpersie2001/pi-style/pull/42");
		expect(parsed.number).toBe(42);
	});

	it("returns null on a non-url pr create output", () => {
		expect(parseGhOutput({ kind: "pr-create" }, "not a url at all")).toBeNull();
	});
});

describe("parseGhOutput — run list / run view / run job", () => {
	it("parses run list tab-separated rows", () => {
		const parsed = parseGhOutput({ kind: "run-list" }, RUN_LIST_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "run-list") throw new Error("expected run-list parse");
		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows[0]).toMatchObject({
			status: "completed",
			conclusion: "success",
			workflow: "CI",
			branch: "main",
			event: "push",
			id: "31025433335",
			elapsed: "38s",
		});
	});

	it("parses run list --json", () => {
		const parsed = parseGhOutput({ kind: "run-list" }, RUN_LIST_JSON_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "run-list") throw new Error("expected run-list parse");
		expect(parsed.rows[0]).toMatchObject({
			status: "completed",
			conclusion: "success",
			workflow: "CI",
			branch: "main",
			id: "31025433335",
		});
	});

	it("parses a successful run view (status, trigger, job, annotation)", () => {
		const parsed = parseGhOutput({ kind: "run-view" }, RUN_VIEW_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "run-view") throw new Error("expected run-view parse");
		expect(parsed.branch).toBe("main");
		expect(parsed.workflow).toBe("CI");
		expect(parsed.id).toBe("31025433335");
		expect(parsed.state).toBe("✓");
		expect(parsed.trigger).toBe("Triggered via push about 2 hours ago");
		expect(parsed.jobs).toEqual([{ state: "✓", name: "check", count: 22, duration: "35s", id: "92372530325" }]);
		expect(parsed.annotations).toEqual([{ text: "Node.js 20 is deprecated." }]);
	});

	it("parses an annotation location-reference row after the `!` message", () => {
		const parsed = parseGhOutput(
			{ kind: "run-view" },
			[
				"✓ main CI · 31025433335",
				"",
				"JOBS",
				"✓ check (22) in 35s (ID 92372530325)",
				"",
				"ANNOTATIONS",
				"! Node.js 20 is deprecated. The following actions target Node.js 20.",
				"check (22): .github#2",
				"",
				"View this run on GitHub: https://github.com/quanpersie2001/pi-style/actions/runs/31025433335",
			].join("\n"),
		);
		if (parsed?.kind !== "run-view") throw new Error("expected run-view parse");
		expect(parsed.annotations).toEqual([
			{ text: "Node.js 20 is deprecated. The following actions target Node.js 20." },
			{ text: "check (22): .github#2" },
		]);
	});

	it("parses a failed run view with no annotations", () => {
		const parsed = parseGhOutput({ kind: "run-view" }, RUN_VIEW_FAIL_FIXTURE);
		expect(parsed).not.toBeNull();
		if (parsed?.kind !== "run-view") throw new Error("expected run-view parse");
		expect(parsed.state).toBe("✗");
		expect(parsed.jobs[0]).toMatchObject({ state: "✗", name: "build", count: 3 });
		expect(parsed.annotations).toEqual([]);
	});

	it("returns null on a hostile run view (no status line)", () => {
		expect(parseGhOutput({ kind: "run-view" }, "just some random log text\nnot a run view")).toBeNull();
		expect(parseGhOutput({ kind: "run-view" }, "✓ main CI · 31025433335\nweird job row that won't parse")).toBeNull();
	});

	it("parses a run job log as raw lines", () => {
		const parsed = parseGhOutput({ kind: "run-job", jobId: "456" }, RUN_JOB_LOG_FIXTURE);
		if (parsed?.kind !== "run-job") throw new Error("expected run-job parse");
		expect(parsed.jobId).toBe("456");
		expect(parsed.lines).toEqual(["Run npm ci", "  npm warn deprecated inflight", "Pass — exit 0"]);
	});

	it.each([
		[
			"run list non-numeric id",
			"completed\tsuccess\ttitle\tworkflow\tbranch\tevent\tnotnumeric\t38s\t2026-01-01T00:00:00Z",
		],
		["run list too few columns", "completed\tsuccess\ttitle"],
		["run list hostile", "not run list output"],
		["run list invalid json", "[{not json"],
	])("returns null on %s (fallback to boxed shell)", (_label, hostile) => {
		expect(parseGhOutput({ kind: "run-list" }, hostile)).toBeNull();
	});
});

describe("renderGhCardLines", () => {
	it("renders a pr list card with count and state-colored rows", () => {
		const parsed = parseGhOutput({ kind: "pr-list" }, PR_LIST_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "pr-list" }, parsed }, 80));
		expect(lines[0]).toBe("PRs");
		expect(lines[1]).toBe("  2 PRs");
		expect(lines.join("\n")).toContain("#14078");
		expect(lines.join("\n")).toContain("#14077");
		expect(lines.join("\n")).toContain("Route run artifact listing");
	});

	it("renders a pr view card with header, state, diff summary, reviewers, body", () => {
		const parsed = parseGhOutput({ kind: "pr-view" }, PR_VIEW_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "pr-view" }, parsed }, 80));
		expect(lines[0]).toBe("PR #14078 · Route run artifact listing through api.Client");
		expect(lines.join("\n")).toContain("OPEN");
		expect(lines.join("\n")).toContain("+37 -42");
		expect(lines.join("\n")).toContain("williammartin (William Martin)");
		expect(lines.join("\n")).toContain("Copilot (AI) (Commented), babks (Approved)");
		expect(lines.join("\n")).toContain("PR body markdown here");
	});

	it("renders a pr view --json card with base→head and changed-files summary", () => {
		const parsed = parseGhOutput({ kind: "pr-view" }, PR_VIEW_JSON_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "pr-view" }, parsed }, 100));
		expect(lines[0]).toBe("PR #14078 · Route run artifact listing through api.Client");
		expect(lines.join("\n")).toContain("OPEN · main → feature");
		expect(lines.join("\n")).toContain("+37 -42 · 5 files");
		expect(lines.join("\n")).toContain("APPROVED");
		expect(lines.join("\n")).toContain("MERGEABLE");
	});

	it("renders a pr checks card with state-colored rows", () => {
		const parsed = parseGhOutput({ kind: "pr-checks" }, PR_CHECKS_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "pr-checks" }, parsed }, 80));
		expect(lines[0]).toBe("PR checks");
		expect(lines.join("\n")).toContain("build (ubuntu-latest)");
		expect(lines.join("\n")).toContain("pass");
		expect(lines.join("\n")).toContain("4m45s");
		expect(lines.join("\n")).toContain("skipping");
	});

	it("renders a pr create card with the URL", () => {
		const parsed = parseGhOutput({ kind: "pr-create" }, PR_CREATE_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "pr-create" }, parsed }, 80));
		expect(lines[0]).toBe("PR created #42");
		expect(lines[1]).toBe("  https://github.com/quanpersie2001/pi-style/pull/42");
	});

	it("renders a run list card with workflow glyphs and ids", () => {
		const parsed = parseGhOutput({ kind: "run-list" }, RUN_LIST_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "run-list" }, parsed }, 80));
		expect(lines[0]).toBe("Runs");
		expect(lines.join("\n")).toContain("✓ CI");
		expect(lines.join("\n")).toContain("31025433335");
		expect(lines.join("\n")).toContain("Release");
	});

	it("renders a run view card with trigger, jobs, and annotations", () => {
		const parsed = parseGhOutput({ kind: "run-view" }, RUN_VIEW_FIXTURE);
		if (!parsed) throw new Error("expected parse");
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "run-view" }, parsed }, 100));
		expect(lines[0]).toBe("Run · CI · 31025433335");
		expect(lines.join("\n")).toContain("Triggered via push about 2 hours ago");
		expect(lines.join("\n")).toContain("check (22)");
		expect(lines.join("\n")).toContain("92372530325");
		expect(lines.join("\n")).toContain("Node.js 20 is deprecated.");
	});

	it("renders a pending call as a single header line", () => {
		for (const cls of [
			{ kind: "pr-list" },
			{ kind: "pr-view" },
			{ kind: "run-list" },
			{ kind: "run-job", jobId: "999" },
		] as const) {
			const lines = plain(renderGhCardLines(theme, { cls }, 80));
			expect(lines).toHaveLength(1);
		}
	});

	it("keeps GitHub headers portable when the legacy Nerd Font flag is enabled", () => {
		setToolsRenderConfig({ nerdFonts: true });
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "run-list" } }, 80));
		expect(lines[0]).toBe("Runs");
	});

	it("collapses long pr lists into a … N more row", () => {
		const rows = Array.from({ length: 20 }, (_, i) => ({
			number: 1000 + i,
			title: `PR number ${i}`,
			branch: `branch-${i}`,
			state: "OPEN",
		}));
		const parsed = { kind: "pr-list" as const, rows };
		const lines = plain(renderGhCardLines(theme, { cls: { kind: "pr-list" }, parsed }, 80));
		expect(lines.filter((line) => line.includes("├─") || line.includes("└─")).length).toBe(7); // 6 rows + more row
		expect(lines.at(-1)).toBe("  └─ … 14 more PRs");
	});

	it("keeps every card rendered line width-safe at 20/40/80", () => {
		const cases: Array<{ cls: Parameters<typeof parseGhOutput>[0]; text: string }> = [
			{ cls: { kind: "pr-list" }, text: PR_LIST_FIXTURE },
			{ cls: { kind: "pr-view" }, text: PR_VIEW_JSON_FIXTURE },
			{ cls: { kind: "pr-checks" }, text: PR_CHECKS_FIXTURE },
			{ cls: { kind: "pr-create" }, text: PR_CREATE_FIXTURE },
			{ cls: { kind: "issue-list" }, text: ISSUE_LIST_FIXTURE },
			{ cls: { kind: "issue-view" }, text: ISSUE_VIEW_FIXTURE },
			{ cls: { kind: "run-list" }, text: RUN_LIST_FIXTURE },
			{ cls: { kind: "run-view" }, text: RUN_VIEW_FIXTURE },
		];
		for (const { cls, text } of cases) {
			const parsed = parseGhOutput(cls, text);
			if (!parsed) throw new Error(`expected parse for ${cls.kind}`);
			for (const width of [20, 40, 80]) {
				for (const line of renderGhCardLines(theme, { cls, parsed }, width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
				}
			}
		}
	});
});

describe("bash dispatch — gh routing", () => {
	it("renders gh pr list as a compact card in the call panel with an empty result", () => {
		const ctx1 = context({ toolCallId: "pl1", args: { command: "gh pr list", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "gh pr list", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(PR_LIST_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const lines = plain(call.render(80));
		expect(lines[0]).toBe("PRs");
		expect(lines.join("\n")).toContain("#14078");
		expect(result.render(80)).toEqual([]); // card lives in the call panel
	});

	it("renders a pending gh call as a header line", () => {
		const ctx1 = context({ toolCallId: "pl2", args: { command: "gh run list", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "gh run list", timeout: 30 }, theme, ctx1);
		expect(plain(call.render(80))).toEqual(["Runs"]);
	});

	it("renders gh run view --job output as a boxed log with a Run job header", () => {
		const ctx1 = context({
			toolCallId: "rj1",
			args: { command: "gh run view --job=456", timeout: 30 },
			cwd: "/fake",
		});
		const call = dispatchCall("bash", { command: "gh run view --job=456", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(RUN_JOB_LOG_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		const callLines = plain(call.render(80));
		expect(callLines[0]).toBe("Run job · 456");
		const out = plain(result.render(80)).join("\n");
		expect(result.render(80).length).toBeGreaterThan(0); // NOT the empty tree result
		expect(out).toContain("Log · 456");
		expect(out).toContain("Run npm ci");
		expect(out).toContain("Pass — exit 0");
	});

	it("keeps the boxed shell for piped gh commands", () => {
		const ctx1 = context({
			toolCallId: "pi1",
			args: { command: "gh pr list | head", timeout: 30 },
			cwd: "/fake",
		});
		dispatchCall("bash", { command: "gh pr list | head", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(PR_LIST_FIXTURE),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
	});

	it("falls back to the boxed shell when gh output cannot parse", () => {
		const ctx1 = context({ toolCallId: "fb1", args: { command: "gh pr list", timeout: 30 }, cwd: "/fake" });
		dispatchCall("bash", { command: "gh pr list", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult("totally not gh output"),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
	});

	it("keeps the boxed shell for gh run watch (raw decision)", () => {
		const ctx1 = context({
			toolCallId: "rw1",
			args: { command: "gh run watch 123", timeout: 30 },
			cwd: "/fake",
		});
		dispatchCall("bash", { command: "gh run watch 123", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult("Refreshing run status every 3 seconds..."),
			{ expanded: false, isPartial: false },
			theme,
			ctx1,
		);
		expect(plain(result.render(80)).join("\n")).toContain("Response");
	});

	it("keeps historical gh panels rendering after a registry reset", () => {
		const ctx1 = context({ toolCallId: "pl3", args: { command: "gh pr list", timeout: 30 }, cwd: "/fake" });
		const call = dispatchCall("bash", { command: "gh pr list", timeout: 30 }, theme, ctx1);
		dispatchResult("bash", textResult(PR_LIST_FIXTURE), { expanded: false, isPartial: false }, theme, ctx1);
		resetBashTreeRegistry(); // session boundary
		expect(plain(call.render(80))[0]).toBe("PRs");
	});

	it("keeps the gh run job boxed log width-safe at 20/40/80", () => {
		const ctx1 = context({
			toolCallId: "rj2",
			args: { command: "gh run view --job=789", timeout: 30 },
			cwd: "/fake",
		});
		dispatchCall("bash", { command: "gh run view --job=789", timeout: 30 }, theme, ctx1);
		const result = dispatchResult(
			"bash",
			textResult(RUN_JOB_LOG_FIXTURE),
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
});
