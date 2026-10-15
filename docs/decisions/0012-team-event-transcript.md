# ADR 0012 — Team event transcript

- **Status:** Accepted
- **Date:** 2026-10-15
- **Scope:** Presentation-only redesign of every pi-teams surface (`features/tools/boxed/teams.ts`, `features/messages/teammates.ts`, run-label supersede in `features/tools/boxed/team-run-labels.ts`, shared preview/model helpers in `features/tools/boxed/shared.ts`). Never touches tool result shapes, message content, or the teammate-notification producer contract; presentation only; every existing fail-closed guard (malformed input falls back to plain/verbatim) is retained. Native boxed tools' `➔`/`✓` glyphs (`shared/box.ts`) are explicitly out of scope.

## Problem

Team surfaces grew ad-hoc vocabularies: the spawn card said `● Spawn 2 background teammates` with a settled glyph from admission (before anything finished), completion notifications printed `● @name finished` heads with verbatim multi-line previews, `get_subagent_result` repeated `@name` in head and receipt, `list_models` dumped raw producer rows, and the merged run label rendered `Thought 0 times` noise for tools-only runs. Glyphs did not form a system, and there was no shared rule for collapsing verbose teammate output.

## Decision

### 1. Glyph system for all team surfaces

| State | Unicode / Nerd | ASCII | Fill rule |
| --- | --- | --- | --- |
| Running | `◌` / `\uF10C` | `~` | hollow |
| Settled | `●` / `\uF111` | `*` | filled |
| Failed | `✗` | `x` | crossed |
| Stopped/partial | `○` (dim, `stopped` label) | `o` | hollow again |

**Fill = progress:** the glyph flips exactly once, at settlement; partial/streaming updates never change it. Background Agent rows track the **run**, not the tool call: they stay `◌` after admission and flip to `●`/`✗` when the completion notification arrives (rule 5). Tree rows reuse the `├─ └─` + `… N more` truncation of the List/Glob/Grep/git boxless-card family; metadata is dim; duration/tokens sit at the line tail as `· 2m 03s · ↓146.5k`. Messages reuse the same event glyphs — `●` settled (muted tint; messages are not success/failure) and `✗` failed — with no separate envelope glyph (rule 9).

Glyph mode is resolved inside `features/tools/boxed/session-config.ts` from the existing `nerdFonts` flag; ASCII is detected from the coordinator's per-session `mergedSummaryGlyph === ">"` ascii marker so `pi/session-coordinator.ts` stays untouched. If that marker is ever decoupled from the ascii preset, ASCII silently degrades to the unicode set (fail-closed, no invented glyphs).

### 2. Shared `normalizePreview()`

One helper in `features/tools/boxed/shared.ts` backs **every** team preview (notification preview, `get_subagent_result` body, `tasks_output` result, partial results, mail bodies): strip markdown markers (`**…**`, `__…__`, leading `###` headings, backticks) keeping the text; split physical lines and drop empty/heading-only lines; compact leading `Key: value` labeled lines with ` · ` (pipe-separated segments on one line count as separate fields; a `dropFields` option drops record-shape noise like `Type:`); append the first prose line after `— `; collapsed bound 1–2 lines plus `… +N lines`; expanded stays verbatim. Long paths inside previews are middle-clipped via the existing `compactToolPath` approach. Malformed input falls back to cleaned verbatim lines.

### 3. Spawn (Agent) row

Collapsed single: `<glyph> Agent @name · <description> · <short-model>`. Model shows only the tail after `/`; explicit `fresh`/`resume`/`continue` context badges stay visible (dim); admitted `thinking`/`max N turns` metadata stays dim. Batch ≥2: `<glyph> Agent (N) · k/N` header + one tree row per member (`├─ ● @name · …`), `… N more · Ctrl+O to expand` when truncated. Expanded keeps the canonical full model ref (authoritative for `Agent.model`). Error/notice/receipt sub-rows and the 10000-line hard budget are unchanged.

### 4. Completion notification as a boxless card

Single: `<glyph> @name · 2m 03s · ↓146.5k tokens` head, then `  └ <normalized preview>`, then `  └ ↗ result.md` (the existing hyperlink capability logic in `resultLinkRows` is reused untouched). Grouped: `<glyph> N teammates finished · 2 ✓ · 1 ✗` head + tree rows; every failure keeps its own `└` reason row; successes may compress to name lists. Outcome glyphs: completed → `●` (success tint), failed → `✗` (error), stopped → `○` (dim). Duration/tokens render **only** from `details.durationMs`/`details.totalTokens` when the producer includes them — absent fields are omitted silently, never fabricated. The notification's own rows always render from message content alone (session-derived), so live and resume produce the same layout.

### 5. Minimal supersede (run-level glyph)

`features/tools/boxed/team-run-labels.ts` already remembers runs by `agentId`; it now also stores the Agent tool-call render `state` + `invalidate` (from `BoxedToolContext`) when the result renders in-process. When the teammate-notification renderer runs in the same process, it looks the run up, writes `{outcome, durationMs, totalTokens}` and calls `invalidate()` so the spawn row re-renders to its terminal glyph with the duration/tokens tail. Replay-safe: a run without live state renders `●` from admission, so resume layouts differ from the live feed only by the flip the live feed actually observed. Known bound: if a host replays history by re-invoking result renderers, replayed background rows re-register live handles and degrade to `◌`; the flip itself is unaffected.

### 6. `list_models` card + `normalizeModelLabel()`

Collapsed model labels show the tail after `/`; expanded/full-detail contexts keep the canonical full ref. Display-name dedupe: `— DisplayName` renders only when its normalized form (lowercase, non-alphanumerics stripped) differs from the id tail (`glm-5.3-flash — GLM-5.3-Flash` → drop the display). Result rendering parses `provider/modelId — Name` rows, lifts a trailing `N of M matching models shown` line into the header (`● Models · <query> · N/M`), renders body tree rows dim, and shows the full canonical ref on the `└` row for the 1-match case (it is the copyable payload). Unparseable results keep the verbatim fail-closed fallback.

### 7. Thought summary

`shared/turn-summary-bridge.ts` `mergedSummaryText` omits the thought clause entirely for tools-only runs (`◈ Called N tools · Edit +a -r`); `Thought N times` appears only when N > 0.

### 8. `get_subagent_result`

Head `◌ Get result @name` while waiting (`· wait` suffix only when `wait: true`), settled `●`. The result row is `  └ Status: partial · Verdict: undetermined — No actionable bugs…` via `normalizePreview`, parsing the `Type: … | Status: …` header lines as labeled fields and dropping `Type:`/`Teammate:` noise so `@name` never prints twice. Expanded rendering stays verbatim.

### 9. Message surfaces (minimal disclosure)

All three message surfaces (`teammate-message`, `send_message`, `steer_subagent`) share one minimal shape — the collapsed line answers only "who → whom"; the body lives entirely behind expansion; receipts are dropped because the settled `●` glyph itself is the receipt (success quiet, failure loud):

- **Collapsed — exactly one line:** `● Message from @worker (Ctrl+O to expand)` (inbound `teammate-message`), `● Message to @worker (Ctrl+O to expand)` (`send_message`), `● Steer to @worker (Ctrl+O to expand)` (`steer_subagent`). No preview, no verb slots, no `queued`/`accepted` receipts.
- **Failure:** `✗ Message to @worker · not sent: <reason>` / `✗ Steer to @worker · <reason>` (error tint; the reason is always visible).
- **Glyphs** are the same event glyphs: `●` muted, `✗` error; ASCII `*`/`x`; nerd `\uF111`. No envelope glyph exists anywhere.
- **Identity:** `@name` keeps its color from `details.color` (inbound) or the existing roster/label resolution (outbound/steer targets).
- **Hint:** `(Ctrl+O to expand)` renders dim, only when collapsed AND hidden body content exists; never when expanded, never on an empty body.
- **Expanded:** the identical head line minus the hint (no repeated sender badge, no `❯` echo), then the full body as `│ `-railed quote rows — 2-space indent + `│ ` on every physical line including blanks (the thinking-quote rail language, not tree rows). Bodies stay verbatim after the existing `clean`/`lines` ANSI/control guards; `normalizePreview` is NOT applied (there is no collapsed preview to normalize).

## Alternatives

- **Per-surface preview logic:** rejected; five renderers already drifted apart, and the failure mode (one surface collapsing markdown, another leaking it) is exactly what a shared helper prevents.
- **Supersede via message-content rewrite:** rejected; mutating session content breaks the producer contract and resume determinism. The flip is a live-only renderer enhancement.
- **Settled glyph at background admission:** rejected; a filled glyph at admission lies about progress — the whole point of fill-equals-progress.
- **ASCII glyph resolution in `pi/session-coordinator.ts`:** rejected to keep the coordinator out of scope; the `mergedSummaryGlyph` ascii marker already carries the per-session preset.

## Consequences

Live background fleets read as running (`◌`) until each agent actually finishes; resumed sessions render `●` from admission (documented replay bound, rule 5). Model identity stays copyable: expanded contexts and the 1-match `list_models` row keep `provider/modelId` verbatim. All previews collapse deterministically from message content, so scroll-back, resume, and live agree. The ascii glyph coupling to `mergedSummaryGlyph` is confined to `session-config.ts` and documented above.

## Validation

- `test/unit/teammate-presentation.test.ts`: updated spawn/result/notification/mail formats, supersede flip (`◌` → `●` with tail via `settleTeammateRun`, `●` after `resetTeammateRuns`), `list_models` card, `get_subagent_result` rows, fail-closed fallbacks.
- `test/unit/team-preview-normalization.test.ts`: `normalizePreview` (markdown stripping, labeled compaction, `… +N lines` truncation, path clipping), `normalizeModelLabel` (dedupe, tail), `formatDuration`/`formatTokens`.
- `test/unit/merged-turn-summary.test.ts`, `test/unit/merged-summary-toggle-regressions.test.ts`: tools-only labels without `Thought 0 times`.
- Full release gates (`npm run typecheck`, `npm run lint`, `npm run depcruise`, `npm run test`) required.

## Related decisions

- [0011 — One merged agent-run disclosure](0011-merged-run-disclosure.md): the merged label this ADR refines; disclosure mechanics unchanged.
- [0005 — Git/GitHub semantic renderers](0005-git-github-semantic-renderers.md): the boxless-card family whose tree rows team surfaces now reuse.
