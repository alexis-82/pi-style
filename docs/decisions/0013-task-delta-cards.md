# ADR 0013 — Task delta cards

- **Status:** Accepted
- **Date:** 2026-10-15
- **Scope:** Presentation-only redesign of the `tasks_*` tool results (`features/tools/boxed/teams.ts` `teamTool` branches). Extends the [ADR 0012](0012-team-event-transcript.md) event system to the task board. Never changes task JSON result shapes, `details`, or tool text; the disclaimer and every model-facing string stay intact in the payload — only the rendered transcript omits them.

## Problem

Task tools rendered state, not change: `tasks_update · completed` dumped the whole task record — a long title (≤90 chars), a full multi-line `Summary`, all artifacts comma-joined on one line, every verification row at full length, and remaining issues. Nothing answered "what changed". `tasks_execute` carried a model-facing disclaimer ("attempt execution does not imply task acceptance") into the transcript, and `tasks_output` bodies bypassed `normalizePreview`, so markdown could still leak on this surface.

## Decision

**Head = operation, result line = delta, details live behind expansion.** Call heads keep their current static `●` (muted) shape — these operations complete near-instantly and the ADR 0012 state machine adds nothing.

### 1. Delta line per status (verb + actor)

| Tool / status | Result line |
| --- | --- |
| `tasks_create` | `  └ T5 created · pending` |
| `tasks_update → in_progress` | `  └ T5 claimed · @owner` |
| `tasks_update → in_review` | `  └ T5 submitted for review · @owner` |
| `tasks_update → completed` | `  └ T5 accepted · @owner · 4 checks: 4 passed · 1 issue remaining · 3 artifacts` |
| `tasks_update → pending` | `  └ T5 claim released` |
| `tasks_cancel` | `  └ T5 cancelled` |
| `tasks_execute` | `  └ T5 · in_progress · attempt → @teammate` (no disclaimer row) |
| `tasks_stop` | `  └ T5 attempt stop requested` / `no running attempt` |

`@owner` keeps the identity color resolution ADR 0012 established (generic accent when the task JSON publishes no roster color). Unknown/unmapped statuses fall back to the existing `code · title · status` summary line — fail-closed, never invented verbs.

### 2. Outcome compression (completed results)

The collapsed delta compresses the outcome to counts: `N checks: a passed · b failed`, `N issue(s) remaining`, `N artifacts`. Any failed check breaks out of the compression into its own loud `✗ <check>` row (the notification-card failure rule: successes compress, failures never do).

### 3. Expanded shape

```
● Update T5 · completed
  └ T5 accepted · @reminder-retirement · 4 checks: 4 passed · 1 issue remaining · 3 artifacts
  │ Summary: Main accepts bounded end-to-end native Reminder SOURCE retirement…
  ├─ ↗ …/delta-reminder-retirement-build-20261015-052517.log
  ├─ ↗ …/delta-reminder-retirement-targeted-20261015-052530.log
  └─ ↗ …/delta-reminder-retirement-suite-20261015-052601.log
```

- `Summary` renders as a dim row (no rail glyph; revised 2026-10, shared rule with ADR 0012 §1) hanging from the card head, with continuation rows aligned under it; the first line is collapsed-clipped.
- Artifacts render as labelled `artifact: <path>` rows (no `↗` glyph, revised 2026-10), paths middle-clipped via `compactToolPath`; hyperlinks follow the existing capability logic where the renderer has a real path.
- Verification rows keep `✓/✗` + first evidence line; remaining issues render as railed rows.

### 4. `tasks_output` and `tasks_list`

- `tasks_output` is one status line: `└─ <status> · @teammate · error: <reason>` (the reason joins the line instead of printing a second `ERROR` row), then the body — `normalizePreview` for the collapsed dim row, verbatim expanded. `… N more` tails never carry a `· Ctrl+O to expand` hint.
- `tasks_list` renders a hanging card (max 3 + `   … N more · Ctrl+O to expand`): the first row carries the dim `└─` branch and later rows align under it. Row shape is `<glyph> T3 @owner Title` (`tasks_get` keeps the audit line until its expansion) and the call head lifts the counts (`● Tasks (1 in progress, 5 open)`), so the card prints one header instead of repeating the board summary. *(Revised 2026-10: the earlier `code title · status · @owner` tree rows were rejected because they duplicated the inline Tasks widget with a second status vocabulary; glyphs come from the pi-teams task table.)*

## Alternatives

- **Dump the record on every write** (status quo): rejected — a completion acceptance produced a 9-line wall whose first two lines repeated the call head's information.
- **Status glyph per task row** (Hub-style colored circles): rejected at the time — task status is a five-value dimension and text status inside dim rows kept one glyph language. Revised: `tasks_list` now uses the shared task glyph table because the inline widget already renders it and two vocabularies for one board read as a bug.
- **Rewriting `taskSummary` for all tools**: rejected — `tasks_get`/`tasks_list` reads want the full identifier line; only the mutation results switch to delta lines.

## Consequences

Mutation results answer "what changed" in one line; acceptance receipts stay auditable behind Ctrl+O with clipped paths and counted checks. The disclaimer disappearance is presentation-only — the model still reads it in the tool text. `outcomeLines`' compressed/expanded split becomes the single place task outcomes are formatted.

## Validation

- `test/unit/teammate-presentation.test.ts`: delta lines per status, outcome compression with a failed check breaking out, expanded artifact/verification rows, `tasks_output` normalization, unknown-status fallback.
- Existing `tasks_list`/`tasks_get` assertions stay green.
- Full release gates (`npm run typecheck`, `npm run lint`, `npm run depcruise`, `npm run test`).

## Related decisions

- [0012 — Team event transcript](0012-team-event-transcript.md): the glyph system, `normalizePreview`, `compactToolPath` clipping, and identity-color rules this ADR reuses.
