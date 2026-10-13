# Messages and tool presentation

> Status: **Implemented/certified subset — Pi 0.83.0 through 0.85.1, 0.99.1–0.99.2, and 1.0.0; capability-conditioned fallbacks remain native**

## Scope

This contract covers: the assistant message prefix; thinking and tool-only assistant presentation; compaction, skill, branch-summary, and custom (MCP) message blocks; and tool call headers, results, state, expansion, and metrics. These surfaces carry a higher compatibility burden than widgets and editors and always preserve native fallback.

## Shared visual primitives

Pure, theme-consuming primitives shared by feature-local renderers (no global theme import):

- `Badge` — short state/tool label;
- `Prefix` — message-role marker with continuation indent;
- `CompactBox` — optional border/background/padding shell;
- `MetricsLine` — elapsed time, counts, truncation, or key hint;
- `StateMark` — pending/success/error/partial indicators;
- ANSI-safe line wrapping/truncation.

## User and assistant messages

User messages render **native** (no leading glyph). The editor prompt glyph is also `❯`, so prefixing sent user messages made them indistinguishable from the live input box; the `❯` prefix was therefore removed entirely:

```text
user prompt text
continuation aligned here
```

Rules: no prefix is applied to user messages (the feature and its `messages.userPrefix` option were removed); native user-message background/text tokens remain the base; long content wraps (never truncates); images/attachments preserve native rendering. User messages are never patched: the certified `native-user-message` surface was removed, so only assistant and special-block message surfaces are certified.

### Skill invocations

On certified native user-routing surfaces, a skill and its accompanying prompt
render together: `[team-lead] Implement this…`. The badge uses the accent color;
only the badge is clickable. Ctrl+O also toggles the skill instructions, which
appear below the prompt with a lightweight `│` rail instead of a box.

The native user component still owns Markdown, transformers, padding and OSC
zones. Badge space is reserved before rendering; neither prompt text nor session
messages are rewritten. Very narrow terminals place the badge above the prompt.
Skill-only invocations use a compact badge. Uncertified routing keeps separate
components with the compact skill renderer; removing the session theme restores
native presentation. Ordinary user-message prototypes remain untouched.

### User-prompt image previews

Images attached to the user's prompt render as **inline previews** directly below the user message ([ADR 0008](../decisions/0008-user-prompt-image-previews.md)). The surface absorbs the presentation half of `@pi-archimedes/image-paste` while fixing its channel: previews are display-only **CustomEntries** (`appendEntry`, documented as not sent to the LLM), not custom messages — so no image bytes ride the session's context pipeline.

- One entry (`pi-style-image-preview`) per agent run carrying images — staged at `before_agent_start` (the event carries the prompt's `images`) and flushed at the first `message_start(assistant)` so the entry lands **below the user message** both live (the host inserts it before the streaming component) and in the session file (user → preview → assistant; resume renders identically).
- The entry renderer builds one pi-tui `Image` per attached image, each with a `#N · WxH` label row tying it to its `[Image #N]` marker, themed `fallbackColor` via `toolOutput`.
- Multiple images render **side-by-side** on kitty-capable terminals (up to 3 columns, min 14 cells each, 2-cell gap; kitty graphics sequences are zero-width so per-row line zipping composes columns) and stacked when the terminal is too narrow or the protocol is not kitty.
- Collapsed previews cap at `messages.previewMaxWidth` cells per image (default **30**, bounds 8–60); Pi's global tool expansion (Ctrl+O) lifts the cap to 60.
- Terminals without image support degrade to a single ANSI-safe fallback line per image (mime + dimensions) — never raw base64, never unprintable sequences. Malformed entry data renders zero lines.

#### Multiplexer caveat (herdr)

Terminal multiplexers sit between pi and the real terminal and may drop the kitty graphics protocol even when the outer terminal supports it. herdr gates pane graphics behind an experimental flag: without `experimental.kitty_graphics = true` in `~/.config/herdr/config.toml` (plus `herdr server reload-config` or a restart), every image — previews and Pi's own tool-result images — is silently dropped while capability detection still reports "kitty" (it sees the outer terminal's `TERM_PROGRAM`). tmux is handled upstream (pi-tui disables images there); other multiplexers have the same failure shape: if previews show as nothing in a graphical terminal, check the multiplexer's graphics passthrough first.
- `messages.showImagePreviews: false` (default `true`) stops appending new entries **and** makes the renderer return nothing, so persisted entries also collapse to zero lines without a reload.
- No clipboard reading, no input transform, no shortcut, no new Pi-core patch identity — public extension APIs only. Installing an input extension that also previews (e.g. image-paste's custom messages) yields a double render; disable one side via `messages.showImagePreviews: false`.

### Clipboard image input

Pasting an image with Pi's built-in `Ctrl+V` natively inserts a `<tmpdir>/pi-clipboard-<uuid>.<ext>` path as plain text — the model just sees a path it has to `read`. pi-style upgrades those artifacts to real image attachments in two layers ([ADR 0009](../decisions/0009-clipboard-image-input.md)):

- **Editor marker** (keystroke time): the installed `StyledEditor` owns the built-in paste keystroke when a sync native probe confirms the clipboard holds an image — an `[Image #N] ` marker is inserted **instantly** (single hop, no path flash, no temp file; ~127 ms measured end-to-end), and the bytes fill the pending registry asynchronously from the native clipboard module. A clipboard read failure discards the entry (the marker stays plain text). Text pastes and probe-unavailable hosts fall through to the native path.
- **Atomic marker backspace**: backspacing directly after a registered `[Image #N] ` marker deletes the whole marker as one unit (one undo step) and discards the image; unregistered marker-looking text backspaces character-by-character.
- **Submit transform** (`input` event, `source: "interactive"` only): `[Image #N]` markers resolve against the pending registry — one-shot per submit (markers kept verbatim; a submit awaits in-flight fills; removed markers discard their images — image-paste semantics). Raw clipboard path tokens that bypassed the editor (native editor, probe unavailable, config toggled after paste) are still upgraded: each readable ≤ 20 MB token is attached as `ImageContent` (extension-derived mime type) and rewritten to `[image]`; the text never becomes empty.
- Missing/unreadable or oversized tokens keep their path verbatim — nothing is lost. No matching tokens and no registered markers → no transform (native behavior).
- The attached images flow to `before_agent_start`, so the preview entry above appears with no extra wiring.
- The pattern is deliberately narrow: user-typed image paths (`./shot.png`, URLs) are text the user meant and are never converted — only Pi's own paste artifacts match. `!` bash input never reaches the transform (interactive-mode intercepts it earlier).
- No shortcut registration, no clipboard reading, no core patch — the built-in keystroke and file handling stay untouched (unlike image-paste's `ctrl+v` re-registration). `messages.clipboardImages: false` (default `true`) restores the exact native flow on both layers.

Assistant presentation uses a restrained prefix only when it improves role separation. It must handle normal text streaming, thinking-only updates, tool-only messages, mixed text and tool calls, aborted/error states, and final render cache reuse without stale partial content. Assistant text always remains visible when the same message carries tool calls: tool presence is not a reliable signal that adjacent prose is disposable narration. Thinking text uses Pi's thinking token and does not visually compete with final assistant text. By default the `Thinking...` placeholder label for hidden thinking blocks is suppressed entirely (`messages.hideThinkingLabel: true`): Pi wraps even an empty label in ANSI codes so its `Text` still occupies one invisible row, and the native layout appends a trailing spacer — together the visible gap where the label used to sit. A certified `AssistantMessageComponent.updateContent` patch (fingerprint-verified 0.83.0, fail-closed elsewhere) drops the invisible row and that trailing spacer, so a hidden thinking block leaves the same single top padding as a text-only message; a FINALIZED message whose every block is hidden (thinking collapsed, no text, no aggregate label, no error rows) collapses to zero lines entirely — its top spacer is dropped too, so the one-blank-line-per-message residue that stacked into large blank gaps between a run's summary rows is gone (tool blocks carry their own leading spacer, so nothing glues).

With `messages.mergedTurnSummary: false`, once the **agent run completes**, the same patch surfaces one clickable aggregate per contiguous thought segment (`messages.thoughtSummary: true`; requires `hideThinkingLabel`). Default merged mode instead interleaves cumulative run-progress labels, described below:

```text
◈ 2 thoughts · 8.4s
```

- Substantive assistant text is a hard visual boundary: `thinking → visible text → thinking` produces two independent summary rows in their original transcript positions. Tool calls/results do not split a segment, so repeated `thinking → tool-only → thinking` cycles may still collapse into one row instead of recreating a stack of adjacent generic labels.
- While the agent is active, hidden intermediate thinking labels remain zero-trace. At `agent_end`, each segment's first thinking run becomes its leader and renders that segment's only aggregate row.
- Count follows Pi's native maximal consecutive thinking-run grouping within the segment. Duration is summed only when every grouped run has a real live measurement; partial/unknown totals are omitted. The bounded content-signature cache is process-scoped, so component rebuilds and extension/session reloads recover durations in the same Pi process. A process restart or disk-only resume renders `◈ N thoughts` without fabricated time.
- Clicking a collapsed row or expanded header writes only that segment's native `thinkingVisibilityOverrides`, then rebuilds its bound assistant components. Other segments remain unchanged. Pi's global thinking visibility remains authoritative.
- The assistant-role prefix (`│ `) never lands on an aggregate row. Expanded thinking content renders as a quote block across that segment's members — every content line and internal blank line carries the `│ ` rail, including thinking-only tool-calling messages:

```text
◈ 1 thought · 4.2s
│  Verifying package metadata

│  Bước 1: Đọc package.json

◈ 2 thoughts · 8.4s
│  Planning the next tool-only checks
│
│  Verifying the grep result

│  Final answer…
```
- Restore/tree rebuilds derive the same boundaries from session content, and a user message always closes the current segment.
- No session theme cached → fail-safe to the plain zero-trace collapse.
- Aggregates are presentation-only: message/session content is untouched; only Pi's existing per-run visibility override maps are changed when clicked.

## Compatibility status

The certified Tier C subset targets recorded runtime identities (observed on Pi `0.83.0`–`0.85.1`, `0.99.1`–`0.99.2`, and `1.0.0`; policy range `>=0.83.0 <0.86.0 || >=0.99.0 <0.100.0 || >=1.0.0 <1.1.0`). Installation is session-only; the core/message/tool surface flags are default-on (fingerprint-certified, fail-closed elsewhere, conflict-preserving), and the OFF switch is `compatibility.allowCorePatches: false` in config. No execution, tool registration, prompt, filesystem, or process behavior is changed.

Certified presentation: assistant prefix; tool call/result selectors with exact markers `[tool]`, `[tool:result]`, `[tool:pending]`, `[tool:running]`, `[tool:error]` (marker style); and boxed special blocks when `tools.style: "compact-box"` and `messages.specialBlocks` are active. Boxed special blocks are certified adapters over the native `updateDisplay`/`rebuild` identities (fingerprint-verified) and fall back to native layout whenever no session theme is cached or the component shape is unsupported. ASCII mode uses configured ASCII markers on already-authorized surfaces.

## Special message blocks

When `messages.specialBlocks` is enabled and authorized:

- compaction summaries — `▾ Compaction · 12,345 tokens` (expanded), `▸` when collapsed;
- skill invocations — `⊟ Skill · <name>`;
- branch summaries — `⊟ Branch`;
- extension custom (MCP) messages — `⊟ Custom · <customType>`, preserving a provided `customRenderer` inside the boxed shell.

Each block embeds its title in a rounded top border and falls back to native layout when no session theme is cached, the shape is unsupported, or the surface is unauthorized.

Compaction uses a dense summary card with no shell breathing rows. It retains its default-expanded behavior and full Markdown summary. Collapsing shows one genuine summary line (preferring prose over headings), truncated to the available width, rather than an empty box; an empty summary omits the body row entirely. The bottom border shows the configured expand/collapse key hint, and clicking still toggles the native state. The parent container's native layout padding is preserved.

Its background is a neutral card surface, not a success/error state: the fill is Pi's `userMessageBg` token; an optional `extras.compactionBgColor` override (hex or theme variable/color reference) still wins when the active theme file provides one. The bundled themes define no `extras` — Pi's theme schema rejects unknown top-level keys at startup — and their `userMessageBg` values match the fills previously set through extras (titanium `darkTitanium` `#0f1216`, titanium-light `userMsgBg` `#e8e8e8`), keeping the tool-card tone without inheriting tool status. Other special blocks retain `customMessageBg`. Native background is restored when the compaction patch is removed.

## Tool call header

Compact boxed shape (`tools.style: "compact-box"`):

```text
╭─ ➔ Read ✓ · Path: src/index.ts ──────────────────────╮
│                                                      │
╰─ 1.2s · ~10k words ──────────────────────────────────╯
```

Full boxed shape (bash/edit/quick-edit/fallback), with the title in the top border, a single labeled divider before the result, and the metrics footer embedded in the bottom border. Boxes carry the semantic status fill themselves (`toolPendingBg`/`toolErrorBg`/`toolSuccessBg` — box ⇒ background), while boxless surfaces (quiet-tool rows/tree panels, git/gh semantic cards, turn summaries) stay transparent; the native container fill is always neutralized so a single tool can mix both (git: boxless card + boxed diff frames). The `Response` divider and the metrics footer appear **only when the tool settles** — while a call runs, the same box stays open with a live running status instead of a premature result frame:

```text
╭─ ➔ Bash ◌ ─────────────────────────────────────────╮
│                                                    │
│  $ npm test                                        │
│  No output received yet                            │
│                                                    │
╰─ ◌ Running · 12.4s ────────────────────────────────╯
```

Partial output streams into the open card under an `Output` divider (no `Response`), and the first partial result renders nothing so the running card is never duplicated below a second box. Only the terminal result adds the `Response` divider and the status footer:

```text
╭─ ➔ Bash ✓ ─────────────────────────────────────────╮
│                                                    │
│  $ npm test                                        │
│                                                    │
├─ Response ────────────────────────────────────────┤
│                                                    │
│  ✓ tests passed                                    │
│                                                    │
╰─ Exit 0 · 1.2s · ~3 words ── Ctrl+O for more ───────╯
```

Compact (summary) tools render `➔ <Tool> ✓ · <detail>` with the footer in the bottom border; bash renders a full call box with the command, a `Response` divider, and the expand hint on the bottom border when output is truncated. Edit/quick-edit render the path **and the diff stats** in the header (`➔ Edit ✓ · path · +3 -0`) with the diff body continuing the box directly — no `Diff` divider. Write renders a compact preview box: the path in the top border, the written content as numbered lines (cat -n style) in the body, and the metrics footer in the bottom border with a `Ctrl+O for more` hint when the preview is truncated; expanded reveals the expanded line budget. `tools.style: "marker"` keeps the marker style (`[read] src/index.ts`).

### Tool state machine

Boxed cards follow `queued → running → streaming output → completed | failed | timed out | cancelled`. The assistant's own response follows the tool's terminal state, and the renderers never draw a result frame before it:

- **Queued** (execution not started): closed card, plain `➔ Tool` title, `… Waiting for output…` footer.
- **Running** (execution started, no result yet): closed card, `➔ Tool ◌` title, `◌ Running · 12.4s` footer (live elapsed via a 1s re-render ticker), `No output received yet` body line.
- **Streaming** (partial result): the call box stays open and the result continues it — streamed output under an `Output` divider (no divider while there is nothing to show) with a `◌ Running · 12.4s` footer. The first partial result renders zero lines so the running card stands alone.
- **Completed** (`Exit 0 · 3.21s · ~45 words`), **failed** (`Exit 2 · …` or `Failed`), **timed out** (`✗ Timed out` label, `Terminated after 300.0s` footer), **cancelled** (`✗ Cancelled` label, `Cancelled` footer): `Response` divider, then the status footer.

Empty-output text is state-dependent and never `∅ (no output)`: `No output received yet` while running, `Command completed without producing output` on success, `Command failed without producing output` on failure, `No output was received before the timeout` on timeout, `Command was cancelled without producing output` on cancel. A silent command whose base command is interactive (`pi`, `vim`, `less`, `top`, …) additionally hints `The process may be waiting for terminal input` after ~1s. Elapsed is computed live from execution start and only freezes when the result is terminal, so a completed footer never shows a stale `0.00s`.

### Quiet-tool batching

Consecutive calls of the same quiet tool (`read`, `ls`, `find`) inside one assistant turn collapse into a **single boxless tree panel** instead of one box per call. Grouping is always on. The first call becomes the batch leader and renders the whole panel; later calls render zero lines, so N boxes become one. Batching is per turn and per tool: a non-batchable call (bash/edit/write/…) or the next message closes the batch, so reads separated by an edit never merge, and session history is not re-grouped.

The panel has **no surrounding box and never collapses** — the tree stays open in every state (one box per call is exactly the noise this feature removes). `read` members render a single path row; `ls`/`find` members render their **parsed output** as a file subtree once the result arrives. States:

```text
◌ Read (3) · 1/3
  ├─ ✓ backend/api/.../entities.py
  ├─ ◌ backend/api/.../dto.py
  └─ ◌ backend/api/.../ports.py
```

- **Pending** header `➔ Read (N)`.
- **Running** header `◌ Read (N) · k/N`; tree shows `✓`/`◌` per member.
- **Done** header ` Read (N) · 0.08s` (open-tree glyph; `●` unicode fallback, nerd `\u{F111}`); tree keeps the first 5 members and a `└─ N more` row.
- **Per-file color**: files read successfully render in the primary (accent) color; failed members render in the error color with the error text indented beneath, and the header becomes `✗ Read (N) · 1 failed`. Errors stay open.
- **`read` lone call**: a single read collapses to one inline line — ` Read <path:range> · <elapsed>` (pending `➔ Read <path:range>`, failed `✗ Read <path:range>` with the error beneath). No tree row, no `(1)` count.

#### ls / find output trees

A lone `ls`/`find` renders its parsed output as a **file-anchored boxless tree** (ADR 0006) under a `List:`/`Glob:` summary header; batched (2+) calls render **nested per-member subtrees**. Pending/failed calls without output fall back to the path-row tree above.

```text
Glob: **/*.ts 152 files · in .
src/
  pi/index.ts
  features/tools/index.ts
test/
  unit/output-trees.test.ts
  … 149 more files
```

- Header: `List: <N> files · in <path>` (ls) / `Glob: <pattern> <N> files · in <path>` (find); directories keep their `/` suffix.
- Body: clean indented rows (no `├─/└─` glyphs). `find` path entries group under their directory as a header row with nested entry rows; single-directory `ls` renders flat. The first ~6 entries show, then a `… N more files` row when truncated.
- Batched calls use the `<glyph> Glob/List (N) · <total> files` header with one subtree per member (`├─ <path> · <n> files` → clean indented entries).
- **File-type icons** (Nerd Font mode only): each entry is prefixed with its file icon — ` ` (folder), ` ` (TypeScript), ` ` (Markdown), … — via `theme.n` glyph mode; Unicode/ASCII modes render plain entries.

#### grep output tree

`grep` renders a **boxless tree panel** that lists **one row per matching file** — match content is never rendered (the counts in the header carry the match total; the file list is the scan target). `grep` is unbatched so each call owns its panel:

```text
Grep: createConfig 3 matches · 2 files · in .
  ├─ src/config.ts
  └─ test/config.test.ts
```

- File rows render `├─/└─ <path>` in the accent color (Nerd Font file icons in nerd mode), first-seen order; a trailing `└─ … N more files` row collapses long results (head budget ~6 files).
- **Expansion** (header click or Pi's global Ctrl+O) lifts the file-list head limit — every matching file renders, still without match content. Raw match lines stay available through Pi's native raw-result view.
- Context lines are not parsed into the tree; the parsers keep only `file:line:` match records to compute counts and group files.

#### Compact path labels

Tool path labels are capped at **60 terminal columns**, with a smaller budget when the row/frame has less room. Short paths stay unchanged; long paths keep the first directory and basename while replacing the middle with the display-only `../../../` marker, e.g. `src/../../../AcceptStageWorkflow.cs:1-20`. Read line ranges and directory `/` suffixes are retained; very long basenames are middle-clipped, preserving the beginning and ending (including extension). Narrow terminals prefer the basename over directory context.

The common `compactToolPath` helper applies to read rows (lone, batched, chunk-merged, expanded), write/edit-family headers, ls/find entries, grep file nodes, and bash semantic tree/Git path labels. It runs before theme styling, measures terminal cells, and never replaces raw arguments, parser records, cache identity or read chunk merge keys. Raw expanded result bodies remain unchanged.

Header requirements: stable human-readable tool label (`formatToolName`); concise primary argument; pending/success/error via `✓`/`✗` glyphs, the self-applied `toolPendingBg`/`toolErrorBg`/`toolSuccessBg` status tint on framed boxes, and — on failure — an error-colored frame (borders and side bars render in the theme's error color; direct-bash cancelled boxes use warning); boxless surfaces stay transparent (see the background rule above); no leaking of hidden/sensitive values beyond native Pi behavior; incomplete streaming arguments render safely; labels and glyphs remain meaningful in ASCII/no-color mode.

#### git / gh semantic views

`git` and `gh` results render as **semantic views** ([ADR 0005](../decisions/0005-git-github-semantic-renderers.md)) when the command is a plain invocation (same gate as bash trees: no pipes, redirects, `;`, `&&`, or command substitution), otherwise the boxed command/response shell renders unchanged. A parser that cannot produce structured records always falls back to the raw shell — approximate rendering is never used. Execution, environment, timeout, and shell behavior are never changed.

Three presentation tiers, matching the bash tree pattern:

| Content | Box | Shape |
| --- | --- | --- |
| `git status`, `add`, `commit`, `push`, `pull`, `fetch`, `restore`, `reset`, `switch`/`checkout`, `diff --stat`, `show --stat`, short `log` | Boxless compact card | summary header + `├─/└─` rows + `… N more` (same family as `List`/`Glob`/`Grep`) |
| `git diff`, `git show`, conflict, CI logs | Box on the content only | `renderBoxedToolResult` + the same adaptive diff component `Edit` uses (`path · +N -M` frame header, one frame per file) |
| `gh pr list/view/checks/create`, `issue list/view`, `run list/view` | Boxless compact card | summary header + state-colored `├─/└─` rows + `… N more` (same family as the git cards) |
| `gh run view --job=<id>` job log | Box on the content only | `renderBoxedToolResult` + a `Log · <id>` divider (one frame, head/tail budget for long logs) |

```text
Git status · main

  15 modified   1 untracked   0 staged
  +370 −71 across 16 files

  M  extension-src/pi-style/features/editor/index.ts
  M  extension-src/pi-style/features/messages/index.ts
  ?  test/unit/message-thinking-collapse.test.ts
  … 13 more

  d diff   f files   Ctrl+O raw
```

Rules:

- **No double-box.** The Git header lives outside the box; only viewer content (diff, log, error) gets a frame.
- **Branch only when it affects the result** (push/merge/ahead-behind/PR base-head) — the status line owns `⎇ main`.
- **Nonzero exit** keeps the raw stderr; a semantic error view only when the output still parses, otherwise raw fallback.
- **Git vs GitHub** is icon + title (`git` / `PR` / `Issue` / `Checks`), not a separate component system.
- **Action lines** (`d diff`, `c checks`, `Enter details`, `Ctrl+O raw`) are hints only — no keybinding registration.
- **Icons** are gated by Nerd Font mode like `List`/`Glob` file icons.
- **Out of scope:** plumbing (`git cat-file`, `rev-parse`, `for-each-ref`), `gh api`, extensions, and free-form JSON stay raw.

## Tool result body

Default body is compact when settled and supports native expansion. pi-style never suppresses information the user or model needs. States: pending/partial, success, error, cancelled, timed out, truncated, empty. `MetricsLine` can show elapsed time, result count, bytes/lines, or expansion hints when reliably available. The `Response` divider and metrics footer only render in terminal states (see [Tool state machine](#tool-state-machine)).

### Edit / quick-edit diffs

Edit, quick-edit, substitute-edit, and target-edit render their diff **adaptively**: split (side-by-side `old │ new`) only for short corresponding changes on a wide terminal, unified otherwise — additions/removals-only diffs, narrow terminals, and lines that would wrap badly in a half pane always render unified. Long runs of unchanged context collapse into a single `⋯ N unchanged lines hidden` row instead of arbitrary truncation; when the diff still exceeds the row budget a `⋯ N lines omitted · Ctrl+O to show full diff` row is shown, and a `Ctrl+O more` hint sits on the bottom border's right side. There is no `Diff` divider — the change stats (`+3 -0`, colored) live in the box header next to the path, published by the result renderer through the shared renderer state (the same call/result state-sharing contract as the write footer), and the footer carries only the elapsed time (a single edited file is implied, so no `1 file` filler):

```text
╭─ ➔ Edit ✓ · CHANGELOG.md · +3 -0 ─────────────╮
│                                                │
│     1  # Changelog                             │
│  +  5  - **Fixed: ...                          │
│  ⋯ 23 unchanged lines hidden                   │
│                                                │
╰─ 1.2s ────────────────────────── Ctrl+O more ──╯
```

## Tool-specific presentation

| Tool | Presentation |
| --- | --- |
| Read | Badge + normalized path, optional line range; native syntax-highlighted content when possible; truncation notice preserved. Consecutive reads batch into one boxless tree panel. |
| Write | Path in the header; numbered preview of the written content (cat -n style, `Ctrl+O for more` hint when truncated, expanded reveals more); concise success/error. |
| Edit | Path **and diff stats** in the header (`path · +3 -0`); adaptive diff (unified/split) with collapsed unchanged context; failed unique-match errors prominent. |
| Find/list/grep | Boxless tree panel: `ls`/`find` render a `List:`/`Glob: <pattern> <N> files · in <path>` tree (clean rows; `find` paths grouped by directory; nested per call when batched); `grep` renders a `Grep: <pattern> <N> matches · <M> files · in <path>` tree that lists **matching files only** (`├─ file` rows, `… N more files` truncation; match content is never rendered — expansion lifts the file-list head limit). `ls`/`find` batch like reads; `grep` is unbatched. Pending/failed calls without output fall back to the path-row tree. |
| Bash | Concise command header, running/exit status (including timeout/cancelled), stdout/stderr distinction where host data supports it. When the command is a plain `ls`/`find`/`grep`/`rg` (no pipes, redirects, `;`, `&&`, or command substitution), its output renders as the same boxless output tree as the native tool — including `ls -l`/`ls -la` long format (parsed into names) and single-file `rg`/`grep` (`line: content` attributed to the file). `git`/`gh` invocations render as semantic views (status/diff/log cards, boxed diffs, PR/issue/run summaries; see [git / gh semantic views](#git--gh-semantic-views)) with the same gate. Unparseable output (e.g. `rg -c`, `rg -l`) falls back to the boxed command/response shell. Execution, environment, timeout, and shell behavior are never changed. |

## Direct bash execution (`!command`)

Pi's direct bash execution (the `!`/`!!` input prefix, separate from the agent Bash tool) renders natively with plain full-width bars. pi-style re-frames it into the same rounded box as the boxed tools via a fingerprint-certified additive `render` patch on `BashExecutionComponent` (exact 0.83.0; the patch certifies the class constructor identity and installs the only own `render`, so it is active from the first frame):

```text
╭─ ➔ Bash ◌ ───────────────────────────────────────────────╮
│                                                          │
│  $ echo "zz"                                             │
│                                                          │
│  zz                                                      │
│                                                          │
╰─ ◌ Running · 0.0s ───────────────────────────────────────╯
```

- Title `➔ Bash` carries the live state glyph (`◌` running / `✓` done / `✗` failed or cancelled) and the `bashPromptColor` extra / `bashMode` color.
- The `$ command` header, streamed output, loader, and native status lines keep their native content and colors inside the box; the footer shows `◌ Running · Ns` (elapsed from the first boxed render) or the terminal state (`Exit 0` / `Exit N` / `Cancelled`). The `!!` context-exclusion variant gets the same box (its native dim border distinction is not carried into the box).
- While no session theme is cached or the component shape is unsupported, the native bars render unchanged (fail-closed). No execution, streaming, expansion, or truncation behavior is changed.

## Expansion and collapse

- Use Pi's configured tool expansion state where available; default collapsed line count is configurable.
- Errors may show more detail by default than successes.
- Custom key hints use Pi keybinding helpers rather than hardcoded keys.
- No independent scrollable fixed tool box in v1.

## Merged run summary (default)

At `agent_end`, interleaved progress rows represent the user request ([ADR 0011](../decisions/0011-merged-run-disclosure.md)): every commentary segment keeps one row right before its text, carrying the CUMULATIVE totals through that segment — the last row carries the run totals, and each row reads in the context of the work that produced the following text:

```text
◈ Thought 4 times · Called 12 tools · Edit +41 -12
│  Round 1 commentary…
◈ Thought 11 times · Called 33 tools · Edit +108 -43 · 4 failures
│  Final answer…
```

- **One row per segment:** visible assistant commentary splits the labels but never detaches a summary from its text; contiguous `thinking → tool-only → thinking` rounds still collapse into one row instead of a stack of adjacent labels. There is no duplicate `➔ Read…` aggregate, including while opened, and no duration on the merged rows.
- **Complete attribution:** include tool rounds before the first thinking run and thinking-less continuations. Count each assistant message's tools once even when it belongs to several thinking groups. Count applied edit/quick-edit diffs from result data, not error diffs. Tools-only runs use the same format with `Thought 0 times` at their first tool; runs/prefixes without tool calls render `◈ Thought N times` with no `Called` part. ASCII uses `>`.
- **Whole-run click:** one desired open/closed state controls every native thinking run and every tool member. Opening invokes native `setExpanded(true)` for every tool, so quiet batch/chunk members render their own output rather than remaining hidden in a batch. Re-click closes all finalized blocks, including failures/mutations and previously individually opened leaves.
- **Native authority:** native render-context expansion flags win over fallback run state. Ctrl+O still controls tools globally and Ctrl+T thinking globally; a prior aggregate click cannot defeat a native close. No keyboard/core patch is added.
- **Zero-height closed members:** native component spacers and image containers disappear with their hidden tool. Error/diff totals remain visible in the header; individual failures and mutations are inspectable by opening it.
- **Safe boundaries:** running/partial/incomplete runs and `user_bash` blocks do not collapse. Visible assistant prose is never removed. Per-tool `maxExpandedLines` and explicit truncation notices still apply; opening reveals every tool, not unlimited output.
- **Replay:** startup/tree rebuilds use the selected branch (`getBranch`), reset stale attribution/turn mappings, and prefer replacement native components over detached predecessors. Retained tools are invalidated after rebind.
- **Cleanup:** a terminal result stops its elapsed ticker and freezes its timestamp before the collapse gate, even when its per-tool renderer is skipped.

`messages.mergedTurnSummary: false` explicitly selects the legacy ADR 0007 `➔ Read 2 files, ran 4 shell commands · 3.1s` row and segment-local thought rows. In that mode error blocks stay visible, mutations are exempt unless `tools.collapseMutatingTools` is enabled, and the legacy tool summary retains its own close affordance. `tools.collapseAfterTurn: false` disables automatic tool hiding in either mode.

Regression evidence: `test/unit/merged-summary-toggle-regressions.test.ts` drives real patched native components through repeated open/close, batch/chunk output, native setters, errors/mutations, stats dedup, replay and replacement; `test/integration/summary-active-branch.test.ts` exercises a real branching in-memory session through extension lifecycle events.

## Streaming correctness

Message/tool renderers must distinguish partial from finalized state; cached finalized output cannot replace newer partial output or vice versa. `context.lastComponent` may be reused only when component state is explicitly updated and invalidated.

## Output safety

Preserve built-in truncation notices; never inject untrusted output into raw terminal controls without Pi-consistent sanitization; lines remain ANSI-contained; background fills do not bleed; no tool result shape is changed merely for presentation.

## Integration strategy

Preference order: public custom renderer/registration API → renderer-only override preserving execution/result shapes → isolated, version/capability-gated component patch → native fallback. Re-registering built-in tools for styling is not the default because it risks execution/prompt semantics and conflicts with other extensions.

## Conflict behavior

If another extension already owns a message/tool renderer: compose only through a supported public mechanism; otherwise preserve the existing owner by default; allow explicit user preference only with diagnostics; restore only the pi-style-installed identity on shutdown.

## Requirements — messages

- **MSG-001:** the assistant prefix is optional and width-safe.
- **MSG-002:** streaming, thinking-only, tool-only, and mixed messages render correctly.
- **MSG-003:** special blocks alter presentation, not model/session content.
- **MSG-004:** unsupported shapes use native rendering.
- **MSG-005:** message patches are idempotent and reversible.
- **MSG-006:** images and native rich content remain usable.
- **MSG-007:** assistant text remains visible when a message also carries tool calls; presentation must never infer that mixed-message text is disposable narration.
- **MSG-008:** after an agent run completes, each maximal thought segment renders one clickable `◈ N thoughts · <time>` aggregate on its leader (`>` in ASCII mode): substantive assistant text splits segments, while tool calls/results do not; active runs keep zero-trace, duration is shown only when every member was measured live (the process-scoped bounded registry recovers it across component and extension/session rebinds; duration-less after process restart), clicking expands/collapses only that segment through Pi's visibility override map, neither aggregate nor expanded thinking shifts the answer's `│ ` landing spot, expanded segment content is continuously `│ `-railed, and a missing session theme fails safe to zero-trace.
- **IMG-001:** images attached to a user prompt render as an inline preview entry directly below the user message; the entry is a CustomEntry (display-only, never sent to the LLM).
- **IMG-002:** previews persist in the session and render identically live, in scroll-back, and after resume — no in-process event state.
- **IMG-003:** terminals without image support render one ANSI-safe fallback line per image (mime + dimensions, themed); base64 data never leaks into any rendered line, and malformed entry data renders zero lines.
- **IMG-004:** `messages.showImagePreviews: false` disables both staging and rendering of previews without a session reload; the default is `true`.
- **IMG-011:** each preview image carries a `#N · WxH` label row matching its `[Image #N]` marker; multiple images render side-by-side on kitty-capable terminals (≤3 columns, stacked fallback when too narrow or non-kitty), and collapsed previews cap at `messages.previewMaxWidth` cells (default 30, bounds 8–60) with Ctrl+O expansion rendering at 60.
- **IMG-005:** the surface registers no keybinding, intercepts no input, and adds no new Pi-core patch identity; the `before_agent_start` path performs no image decoding.
- **IMG-006:** the built-in paste keystroke inserts an `[Image #N] ` marker instantly when the clipboard holds an image (sync native probe; async byte fill; no temp artifact); on interactive submit, markers resolve against the pending registry one-shot and stay verbatim in the text; raw clipboard path tokens whose files are readable and ≤ 20 MB are attached as real `ImageContent` and rewritten to `[image]`; the message text never becomes empty.
- **IMG-007:** clipboard read failures discard the pending entry (marker stays plain text); missing/unreadable/oversized artifact tokens keep their original text verbatim; markers removed from a submitted text discard their images (registry one-shot per submit); text with no matching tokens passes through untransformed (native behavior when `messages.clipboardImages: false`).
- **IMG-010:** backspacing with the cursor directly after a registered `[Image #N] ` marker deletes the whole marker as one atomic unit (single undo step, cursor preserved at the deletion point) and discards the pending image; marker-shaped text without a registry entry backspaces character-by-character.
- **IMG-008:** only Pi's clipboard-paste artifact pattern is converted — user-typed image paths, URLs, and non-interactive sources are never transformed; `!` bash input never reaches the transform.
- **IMG-009:** the input transform registers no shortcut, performs no clipboard reads (only the file Pi's paste already wrote), and keeps renderers I/O-free.

## Requirements — tools

- **TOOL-001:** styling never changes built-in execution semantics.
- **TOOL-002:** certified pending/partial/success/error states are distinct without color alone; cancelled/truncated distinction is native/neutral when reliable host state is unavailable.
- **TOOL-003:** built-in expansion and truncation behavior is preserved.
- **TOOL-004:** tool-specific headers remain concise and sanitize incomplete arguments.
- **TOOL-005:** renderer conflict/failure falls back to the existing/native renderer.
- **TOOL-006:** patches/overrides are idempotent, reversible, and identity-safe.
- **TOOL-007:** renderers perform no filesystem/process work.
- **SUM-001:** when the agent run completes, that run's finalized collapsible tool blocks collapse into a single summary line (leader renders the summary; other collapsible tool items render zero lines) when `tools.collapseAfterTurn` is enabled; a turn made of mutating tools only collapses nothing.
- **SUM-002:** the summary aggregates per-tool counts with total elapsed; error/partial/interrupted blocks are never collapsed and remain visible (a `· N failure(s)` marker may reference them). Aggregate edit-family diff stats render as `· Edit +N -M` (diff colors) computed from tool-result data (`details.diff`, quick-edit output) — registry-derived, so resume renders identically; `write` and error members contribute nothing.
- **SUM-003:** collapse state is derived from session content, so scroll-back and session resume render identically without in-process `turn_end` events.
- **SUM-004:** Pi's global expansion state is preserved — when expanded (Ctrl+O) every block renders in full and toggling back restores summaries; pi-style never mutates Pi's expansion state.
- **SUM-005:** `user_bash` blocks and the running turn are never summarized; rendering performs no filesystem/process work and no new Pi-core patch identity.
- **SUM-006:** mutating tools (`edit`/`write`/`quick_edit`/`substitute_edit`/`target_edit`) are not summarized when `tools.collapseMutatingTools` is off (default): their blocks remain visible beside the summary line, and the summary counts/elapsed cover only the collapsed (read-only) members.
- **GIT-001:** `git status`/`add`/`commit`/`push`/`pull`/`fetch`/`restore`/`reset`/`switch`/`checkout`/`merge`/`rebase`/`diff --stat`/`show --stat`/short `log` render as a boxless compact card (summary + grouped `├─/└─` rows + `… N more`), not a full boxed shell.
- **GIT-002:** `git diff`/`git show`/conflict render the diff in a content box using the same adaptive diff component as `Edit` (per-file frame with `path · +N -M` in the top border), without a second diff visual language.
- **GIT-003:** a `git`/`gh` command with pipes/redirects/`&&`/`;`/command substitution, an unparseable result, or a plumbing/`gh api` scope renders the raw boxed Bash shell unchanged.
- **GIT-004:** nonzero exit preserves raw stderr; a semantic error view renders only when the output still parses.
- **GH-001:** `gh pr list/view/checks/create` and `issue list/view` render as boxless summary cards (table output or `gh --json`); `gh run list/view` render as boxless run cards, `gh run view --job=<id>` renders the job log in a boxed result (`Log · <id>` divider), and `gh run watch`/`gh api` stay raw.
- **GH-002:** action hints (`d diff`, `c checks`, `Enter details`, `Ctrl+O raw`) are presentation only — no keybinding registration.

## Pi Teams instance identity

Agent receipts and `teammate-notification` messages prefer runtime `details.teammateName` and use `details.color` when supplied. Peer messages use runtime `details.from` and `details.color`. Hex colors style only the `@identity`, rather than appearing as literal metadata; when no valid color is published, `@references` use the theme's generic accent (not a synthesized teammate-specific color). Requested `name` is a pending-call fallback only; specialist names, model labels and unrelated metadata do not synthesize teammate identity or color. `Get result` receipts resolve their run ID to `@teammate` and its admitted color from Agent details, including while waiting and after restoring the active session branch. Task-board `owner` references use the generic accent because task JSON does not publish per-owner colors. The structured `Teammate: @name` line in expanded Get result output keeps its color; free-form tool output and message bodies are left intact. Unknown run IDs retain the abbreviated ID; Pi still calls the tool with the full ID so repeated assignments to one teammate remain distinct.

Pi Teams retains ownership of execution and roster state. Pi Style uses its existing public/certified tool and custom-message renderers, with native fallback; neither a second Pi Teams renderer nor a runtime dependency is required.

## Certified and fallback tests

- assistant multiline prefixes at wide/narrow widths; partial/final transitions;
- thought segments: active zero-trace, visible-text boundaries within/across assistant messages, tool-only cycles aggregated, one leader per segment, count/pluralization, all-or-nothing summed duration, duration recovery across component replacement and session/extension rebind in the same process, duration-less disk history, restored boundary reconstruction, segment-scoped click collapse/expand, ASCII glyph, role-prefix never on thought rows, expanded `│ ` quote rails, global visibility, theme-missing fallback, `thoughtSummary: off` zero-trace;
- thinking-only/tool-only/mixed messages; each special block collapsed/expanded;
- built-in tools with incomplete args, partial updates, success, error, cancellation, truncation;
- diff and syntax-highlight preservation; no-color/ASCII/theme invalidation;
- git/gh parsers (long and `--short` status, `diff --stat`, `log`, `gh --json` records) accept valid output and return `null` on hostile input;
- git/gh render snapshots: compact card, boxed diff reuse, raw fallback, nonzero-exit stderr preservation;
- turn summary render snapshots: Nerd/Unicode/ASCII/no-color line formats, zero-line members, leader rendering, `expanded` override, error-block preservation, diff-stats part (diff colors, omission when diff-less), registry diff extraction (`details.diff`, quick-edit output, restore parity, write/error exclusion);
- turn registry unit tests: grouping, leader selection, counts/elapsed, resume rebuild, session-boundary resets;
- lifecycle/e2e: `turn_end` → deferred collapse, scroll-back consistency, Ctrl+O expand/restore round-trip;
- unsupported target shapes; repeated reload and later-owner replacement; native fallback snapshots;
- image preview entries: renderer structure and width caps, `#N` labels, kitty side-by-side zip (same-row payloads) with stacked degradation, fallback line on non-image terminals (no base64 leakage), malformed-entry zero-line guard, config gate on both stage and render sides, ordering (entry below the user message, live and persisted);
- clipboard image input: pattern acceptance/rejection (near-miss shapes), transform attachment + `[image]` rewrite, mixed missing/oversize passthrough, never-empty text, config gate, live-tmpdir file fixture.

## Roadmap coverage

- Implemented in: Phase 5; git/gh semantic views: Phase 8; turn tool summaries: Phase 9; user-prompt image previews: Phase 10.
- Full conflict/config controls: Phase 6.
- Performance/platform/release proof: Phase 7; manual evidence pending.
- Requirement IDs: `MSG-001` through `MSG-007`, `TOOL-001` through `TOOL-007`, `GIT-001` through `GIT-004`, `GH-001` through `GH-002`, `SUM-001` through `SUM-006`, `IMG-001` through `IMG-010`.
