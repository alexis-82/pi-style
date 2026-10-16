# ADR 0007: Turn tool summaries

- Status: **Accepted**
- Date: 2026-08-08

> Default merged presentation is now governed by [ADR 0011](0011-merged-run-disclosure.md). This record describes the opt-out legacy row/exemptions. Disclosure clicks in both modes now use native expansion controls rather than an independent run-open override.

## Context

After an agent turn finishes, the feed is dominated by completed tool blocks (read/ls/find/grep/bash/edit/write), each a box or tree panel. The user must scroll through tall completed output to reach the assistant's final answer — output that was already consumed while it streamed.

pi-style already implements the exact mechanism this feature needs, for consecutive quiet tools (read/ls/find) in `features/tools/boxed/batch.ts`:

1. the first call of a batch becomes its **leader**: the leader's call component renders the whole boxless panel (header + tree), reading live batch state on every render pass;
2. subsequent members render **zero lines** (`hideBatchMember`), so they consume no vertical space;
3. **errors stay visible**: failed members always render inline, even in the collapsed state.

"Collapse a finished turn to one line" is the same pattern generalized from batch granularity to whole-turn granularity.

Two facts verified against Pi 0.84.0 shape the contract:

- **Pi owns the tool-expansion state.** `app.tools.expand` (Ctrl+O, internally `app.ln`, default binding) toggles `setExpanded()` on every expandable feed child (`interactive-mode.js` `setToolsExpanded`); `ToolExecutionComponent` carries a per-block `expanded` field (default `false`) delivered to result renderers as `options.expanded`. pi-style's boxed renderers already consume it (`bash.ts` renders a tail preview plus a `Ctrl+O for more` footer when collapsed).
- **`pi.registerShortcut` exists as a public API, but there is no per-block focus model.** A shortcut handler cannot know which feed block the user means, so per-turn expansion would have to target "the last collapsed turn" — a new keybinding surface with binding-ownership and conflict policy implications, for no demonstrated need in v1.

## Decision

After the agent run completes (user request → `agent_end`), collapse that run's **finalized** tool blocks into a single summary line. Pi emits `turn_end` per assistant message, so every tool batch of the request appends to the same summary group and collapses together. The only expand gesture in v1 is Pi's existing global tool-output toggle (Ctrl+O); no new keybinding, no new Pi-core patch identity, no new compatibility surface.

### Renderer contract

```ts
showSummary(call) =
  turnEnded(call.toolCallId) &&            // derived from session content, not runtime flags
  !options.expanded &&                     // Pi's global tool-output state (read-only)
  config.tools.collapseAfterTurn === "on" &&
  (!isMutatingTool(call.toolName) || config.tools.collapseMutatingTools === "on");
```

- **Leader** = the first non-error, non-mutating tool item of the turn. It renders the summary line; every other collapsible tool item of the turn renders zero lines (the existing batch-member pattern). A turn whose members are all mutating or all erroring has no leader and collapses nothing.
- **Summary format**: `➔ Read 2 files, ran 4 shell commands · 3.1s` — per-tool-type counts (existing `pluralForm`), total elapsed from the wall-clock state registry, truncated via `safeTruncateToWidth`; Unicode/ASCII variants follow the glyph-mode config. The summary replaces the batch panel header too (a turn of only quiet tools collapses from one tree panel to one line). The summary counts and elapsed cover only the members it hides; mutating members' own footers carry their elapsed.
- **Mutating tools are exempt (default)**: `edit`/`write`/`quick_edit`/`substitute_edit`/`target_edit` blocks are the record of what was done to the user's files. With `tools.collapseMutatingTools: "off"` (default) they never collapse — after the turn they stay visible as their compact preview boxes beside the summary line, so a finished turn reads `➔ Read 2 files, ran 1 shell command · 2.1s` followed by the edit blocks. `tools.collapseMutatingTools: "on"` restores full collapse (the v1 behavior). `bash` is deliberately excluded from the classification: read-only and mutating commands are indistinguishable without parsing, and bash is the most common verbose tool — the summary keeps `ran N shell commands`.
- **Never collapsed**: error results (`isError`), partial/pending blocks (`isPartial`), turns that did not complete (interrupted by Esc or session end), and the currently running turn. Error blocks remain visible below the summary line; the summary may carry a `· 1 failure` marker pointing at them.
- **`user_bash` (`!command`) blocks are `BashExecutionComponent` items**, not tool calls of the agent turn — never summarized.
- **Expansion override**: when `options.expanded` is true (Ctrl+O), every block renders in full; pressing Ctrl+O again restores summaries. pi-style only *reads* Pi's flag — it never calls `setExpanded` and never mutates Pi's expansion state.

### State

- A **turn registry** keyed by `toolCallId` (leader id, per-tool counts, total elapsed, failed count), populated by the app layer from the session snapshot at `turn_end`/`session_tree`, mirroring the batch and `bashTreeStates` registries, reset on session boundaries.
- **`turnEnded` is derived from session content** (the turn's message completed and a subsequent message or session end exists) — not from a runtime `turn_end` event flag — so scroll-back and session resume render identically. The renderer remains a pure function of content plus Pi's own `expanded` state.
- Summary counts/elapsed are computed when the turn is finalized; no render-time I/O, no filesystem/process work (TOOL-007 holds).

### Configuration

- New leaf `tools.collapseAfterTurn: "off" | "on"` (default `"on"`).
- New leaf `tools.collapseMutatingTools: "off" | "on"` (default `"off"`): mutating tools stay visible after the turn; `"on"` restores the v1 full-collapse behavior.
- Preset mapping: `default`/`compact`/`full`/`ascii` → `on`; `minimal`/`native` → `off` (for `collapseAfterTurn`). `collapseMutatingTools` defaults to `off` for every preset.
- Same precedence ladder, normalization-safe fallback, and `/pi-style set` support as every other leaf; `/pi-style doctor` reports the effective value.

### Compatibility

- **No new Pi-core patch identity.** The feature extends the already-certified boxed renderer surface (Tier C, exact Pi 0.83.0/0.84.0 subset). Unsupported host shapes disable only the affected surface per ADR 0004, with native fallback intact.
- Pi's expansion state and keybinding remain untouched; the `Ctrl+O for more` footer vocabulary is reused as the summary line's hint.

## Alternatives considered

### Per-turn expansion via `pi.registerShortcut`

Rejected for v1. The handler would have to target "the most recently collapsed turn" because Pi has no per-block focus model; that introduces a new keybinding surface (binding ownership, conflicts, keybinding.json id contract) for no demonstrated need. A v2 refinement if per-turn expand is requested.

### Folding by mutating Pi's per-block `setExpanded`

Rejected. Pi's `expanded` flag is Pi's own state machine (global toggle, persisted per component, resets on restart); writing it from the extension would fight Pi's status line (`Tool output: expanded/collapsed`), race with user toggles, and change behavior of surfaces pi-style does not own.

### Collapse from a runtime `turn_end` flag only

Rejected. Module-level flags reset when Pi restarts with a saved session, so history would render expanded after resume — inconsistent with the requirement that scroll-back and resume render collapsed.

### Summarizing `user_bash` blocks

Rejected. The user's own `!command` executions are scarce, intentional, and owned by a different component; keeping them visible preserves user agency over their own actions.

### Collapsing mutating tools into the summary (the v1 behavior)

Rejected as the default. `edit`/`write`/quick-edit blocks are the record of what was done to the user's files — hidden behind a dim `Edited 2 files` count, a completed turn leaves no reviewable trace of the changes, and the user must press Ctrl+O to audit what the agent did. Keeping them visible (compact previews beside the summary line) preserves clarity at the cost of vertical space on edit-heavy turns. The v1 behavior remains available via `tools.collapseMutatingTools: "on"`. `bash` is excluded from the classification either way: read-only and mutating commands are indistinguishable without parsing, and bash is the most common verbose tool — summarizing it (`ran N shell commands`) keeps the collapse effective.

## Consequences

### Benefits

- the feed compacts to one line per finished turn while the final answer stays put;
- changes to the user's files stay visible: mutating tool blocks survive the collapse as compact previews, so the feed keeps a record of what was edited/written;
- zero new surface, keybinding, or fingerprint — the mechanism and vocabulary already exist (batch panels, `Ctrl+O for more`);
- deterministic by construction: the same session content renders the same way in the live feed, scroll-back, and after resume.

### Costs

- assistant text between tool blocks remains in place (pi-style cannot remove Pi-owned text items), so a collapsed turn may leave scattered text chunks;
- edit/write-heavy turns keep their blocks visible, so such turns compress less (the user-visible record of changes wins over compactness);
- one layout shift when summaries replace boxes at turn end (mitigated by applying through the existing deferred scheduler pass);
- the turn registry must be rebuilt from the session snapshot on resume and cleared on session boundaries;
- the test matrix grows (registry unit tests, summary render snapshots, resume determinism, expand override, mutating-tool exemption).

## Validation implications

- Unit tests (`test/unit/`): turn grouping and leader selection from synthetic session trees; per-tool counts and elapsed totals; error/partial exclusion; mutating-tool exemption (leader skips mutating members, parts exclude them, all-mutating turns collapse nothing); registry rebuild on resume; `collapseAfterTurn`/`collapseMutatingTools` normalization and preset mapping.
- Render tests (`test/render/`): summary line formats (Unicode/ASCII/no-color), zero-line members, leader rendering, `expanded` override, error-block preservation, mutating blocks visible beside a collapsed turn, `user_bash` untouched.
- Lifecycle/e2e tests (`test/e2e/`): `turn_end` → deferred collapse; scroll-back consistency; reload and session-boundary resets; Ctrl+O expand/restore round-trip.
- Requirement mapping: new `SUM-001`–`SUM-006` in `docs/ui/MESSAGES-AND-TOOLS.md`; existing `TOOL-001`–`TOOL-007` remain in force.
- Compatibility: certified boxed renderer surface unchanged; no new fingerprint; unsupported shapes fall back per ADR 0004.

## Supersedes

None. Superseded-by: none.
