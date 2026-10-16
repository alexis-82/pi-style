# ADR 0005: Git and GitHub as semantic renderers of Bash results

- Status: **Accepted**
- Date: 2026-08-05

## Context

The Bash tool is pi-style's most frequent execution primitive, and `git`/`gh` output is both workflow-relevant for a coding agent and structurally regular (`git status` groups, `git diff` hunks, `gh --json` records). Today that output renders inside the generic boxed command/response shell — readable, but one tall box for a few summary lines, and no shared visual language with the `List`/`Glob`/`Grep` trees or the `Edit` diff.

pi-style already implements the exact pipeline this feature needs, for `ls`/`find`/`grep`/`rg` (`features/tools/boxed/bash.ts`):

1. `classifyBashCommand` — tokenize `args.command`, reject pipes/redirects/`&&`/`;`/command substitution, strip `env`/`sudo`/`cd X &&` prefixes, read the real base command;
2. `parseBashTreeOutput` — parse output into structured records, return `null` on any ambiguity;
3. tree panel in the call card, or `fallback = true` → the boxed Bash shell renders, preserving raw output.

Git/GitHub is a second instance of this pattern, not a new execution path.

Two constraints shape the renderer contract:

- **Pi exposes no `argv`/`exitCode` metadata for Bash.** The result is `{ content: [text] }` plus `args.command` and `context.cwd`. pi-style derives everything itself: command tokens (`tokenizeCommandLine`), exit code from the trailing `\n\nCommand exited with code N` status suffix (`parseBashTerminalStatus`), elapsed from wall-clock state. The "metadata from the execution layer" ideal in earlier drafts must be adapted to derived data.
- **Action lines (`d diff`, `c checks`) are visual hints, not registered keybindings.** Phase 5 documents "custom key hints use Pi keybinding helpers rather than hardcoded keys" and "no independent scrollable fixed tool box in v1". Real keybindings would be a new compatibility surface with conflict policy implications.

## Decision

Treat Git and GitHub as **presentation adapters of the Bash result**. Rendering is dispatched inside the existing certified bash renderer path; execution, environment, timeout, and shell behavior are never changed.

### Renderer contract

```ts
interface BashSemanticGate {
  /** Base command is git/gh and shell composition is simple (mirror classifyBashCommand). */
  classify(command: string): SemanticClass | null;
  /** Structured records, or null → raw boxed-shell fallback. */
  parse(cls: SemanticClass, stdout: string, exitCode: number | undefined): ParsedSemantic | null;
  render(parsed: ParsedSemantic, theme: BoxTheme, width: number): string[];
}
```

Rules:

- only a `git`/`gh` base command (after `env`/`sudo`/`cd X &&` handling) is eligible;
- any pipe, redirect, `&&`, `;`, or command substitution → raw boxed shell;
- parse failure → raw boxed shell, never approximate rendering;
- exit code `≠ 0` keeps the raw stderr; a semantic error view is rendered only when the output still parses, otherwise fallback;
- the raw boxed shell is always reachable (existing Bash card with full stdout/stderr and `Ctrl+O` expand).

### UI tiers

| Content | Box | Reuses |
| --- | --- | --- |
| `git status`, `add`, `commit`, `push`, `pull`, `restore`, `reset`, `switch`, `checkout`, `diff --stat`, short `log` | Boxless compact card | `renderOutputTree` header + `├─/└─` rows + `… N more` |
| `git diff`, `git show`, conflict, CI logs | Box on the content only | `renderBoxedToolResult` + `AdaptiveDiffComponent` (the same component `Edit` uses — one diff visual language) |
| `gh pr view`, `issue view`, `run view` summary | Boxless summary, boxed details/checks/logs | tree rows + boxed result |
| Everything else (`gh api`, plumbing, ambiguous) | Existing boxed Bash shell | `renderBoxedBashCall`/`renderBashFinalResult` |

No double-boxing: the Git header lives outside; only viewer content (diff, log, error) gets a frame.

### Scope

- **Git first.** Porcelain commands: `status`, `diff`/`diff --stat`, `log`, `show`, `commit`, `add`/`restore`/`reset`, `switch`/`checkout`, `pull`/`push`/`fetch`, `merge`/`rebase`, conflict state. Plumbing (`cat-file`, `rev-parse`, `for-each-ref`) stays raw.
- **`gh` selectively.** `pr list/view/create/checks`, `issue list/view`, `run list/view/watch` via `gh --json` output. `gh api`, extensions, and free-form JSON stay raw (or a JSON tree viewer later).
- **No "Git mode".** Commands like `git diff | grep …` fall back raw by the pipe rule; `git -C`, env vars, aliases, and chains are handled by the existing tokenizer or fall back.
- **GitHub vs Git distinction** is icon + title (`git` vs `PR` vs `Issue` vs `Checks`), not a separate component system. The branch is only shown when it affects the result (push/merge/ahead-behind/PR base-head); the status line already owns `⎇ main`.
- **Superseded:** current rendering uses plain labels for git/gh/search headers and does not render optional file-type/search icons.
- **Action lines** render as hints only; no keybinding registration in v1.

### State

The classification/parse/fallback state lives in a registry keyed by `toolCallId`, mirroring `bashTreeStates`, with a `resetGitRegistry()`-style clear on session start/shutdown. No new Pi-core patch identity: the git/gh renderers extend the already-certified bash renderer surface (Tier C, exact Pi 0.83.0 within `>=0.83.0 <0.84.0`).

## Alternatives considered

### A standalone Git tool/UI replacing Bash

Rejected. It would duplicate shell execution and result plumbing, force context switching between Bash and Git UIs, require deep git-behavior knowledge inside the plugin, and break composition (`git diff | grep …`, `git -C`, env, aliases, `&&` chains).

### A dedicated "Git mode"

Rejected for the same reasons: a mode owns input and interpretation, which conflicts with Bash as the single execution primitive and makes pipe/redirect composition ambiguous.

### Regex-parsing the full command string

Rejected. The existing tokenizer plus parse gates with explicit raw fallback is strictly more robust than regexing long shell strings, and mirrors the certified `ls`/`find`/`grep` path.

### Registering keybindings for actions (`d diff`, `c checks`)

Rejected for v1. It is a new compatibility surface (binding ownership, conflicts with other extensions, Pi keybinding API contract) with no demonstrated need beyond discoverability; hints satisfy the current contract ("no independent scrollable fixed tool box in v1").

## Consequences

### Benefits

- one visual language: `git status` reads like `Grep`/`List`/`Glob`; `git diff` reuses the `Edit` diff component;
- zero execution duplication and no new compatibility patch identity;
- conservative by construction: any parse ambiguity or shell composition falls back to the certified raw shell;
- phases cleanly: Git porcelain first, `gh` workflow second.

### Costs

- parsers must tolerate porcelain variance (long vs `--short` status, diff stat column widths, locale-independent markers) and stay fail-closed;
- per-call registry state must be cleared on session lifecycle boundaries;
- test matrix grows (parser unit tests + render snapshots + fallback cases);
- `gh` scope needs discipline to avoid chasing free-form JSON.

## Validation implications

- Unit tests (`test/unit/`): `git status` long/`--short`, `diff --stat`, `log`, per-file diff splitting; `gh --json` pr/issue/run parsing; every parser returns `null` on hostile input.
- Render tests (`test/render/`): compact card snapshots, boxed diff reuse snapshots, raw-fallback snapshots, `Ctrl+O` expand preservation, `NO_COLOR` and ASCII mode.
- Requirement mapping: `TOOL-001` (no execution change), `TOOL-002` (states), `TOOL-003` (expansion preserved), `TOOL-004` (concise headers), `TOOL-005` (fallback), plus new `GIT-*`/`GH-*` requirements in `docs/ui/MESSAGES-AND-TOOLS.md`.
- Compatibility: extends the certified bash renderer surface only; unsupported Pi shapes disable the surface per ADR 0004, with native fallback intact.

## Supersedes

None. Superseded-by: none.
