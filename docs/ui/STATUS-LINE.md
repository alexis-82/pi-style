# Status line

> Status: **Implemented — Phase 2 complete**

## Purpose

The status line is the primary information surface in pi-style: a segment/preset/responsive model built as pure domain logic plus native Pi widgets. It answers, at a glance: which model and thinking level are active, where the session is working, whether the repository is clean, how much context is used, what the session consumes, and which extension states are relevant.

## Native surface layout

Namespaced widgets through the public widget API:

```text
aboveEditor:                pi-style.notifications
aboveEditor | belowEditor:  pi-style.status.primary   (default: below the editor, under the input)
belowEditor:                pi-style.status.secondary (only when it has visible content)
```

While enabled, pi-style replaces the native footer with an empty owned component so native footer/status output is not duplicated; the footer factory's data provider feeds native git branch and extension statuses into the segment snapshot. Disabling or disposing restores the native footer with `setFooter(undefined)`.

## Segment contract

```ts
interface StatusSegment {
  id: StatusSegmentId;
  defaultPriority: number;
  render(context: SegmentContext): SegmentRenderResult;
}

interface SegmentRenderResult {
  visible: boolean;
  content: string;
  compactContent?: string;
  minWidth?: number;
}
```

Required properties: stable ID for layout/configuration; visibility without throwing; normal and optional compact representations; priority and width behavior separate from styling; no I/O in `render()`.

`SegmentContext` is an immutable subset of the current `UiSnapshot`: model/provider, thinking level, cwd/project path, Git snapshot, context tokens/window/percentage, usage totals and live usage, cache read/write, cost and subscription mode, session identity, compaction state, extension statuses/custom items, glyph/separator set, semantic theme, and normalized segment options. Segments never reach back into `ExtensionContext` or session storage.

## Built-in segments

| ID | Content | Default importance |
| --- | --- | --- |
| `pi` | Package/Pi glyph | Decorative; first to drop |
| `model` | Model name, optionally provider | Essential |
| `thinking` | Live `think:off|min|low|med|high|xhigh|max` | Essential for reasoning models |
| `model_effort` | Model + provider + thinking, right-aligned (`(deepseek) deepseek-v4-flash • high`) | High; drops last (moves to secondary on overflow) |
| `path` | Basename, abbreviated, or full cwd | High |
| `git` | Branch and staged/unstaged/untracked indicators | High in repositories |
| `context_pct` | Context percentage and threshold state | High |
| `context_bar` | Pipe-delimited context block (`[█████░░░░░] \| 47% used \| 235K/1.0M`, delimited by the segment separator on both sides; bar width via `contextBarWidth`, totals appended when token counts are known), green <50%, yellow 50–70%, red >70% | High |
| `context_total` | Current/window token counts | Medium |
| `auto_compact` | Auto/custom compaction state | Medium |
| `token_in` / `token_out` | Input/output tokens | Medium |
| `cache_read` / `cache_write` | Cache usage | Low/medium |
| `cost` | Session cost when meaningful | Medium |
| `time_spent` / `time` | Session elapsed / clock | Low |
| `hostname` | Host identity | Low; useful remotely |
| `session` | Session name/short ID | Low/medium |
| `extension_statuses` | Remaining Pi extension statuses | Secondary |
| configured custom item | Selected status by key | User-defined |

Segments with unavailable or unreliable data hide themselves instead of showing invented zero values.

## Live thinking-level indicator

Resolution order: latest live `thinking_level_select` event → current context/API value on session start → restored branch/session value → `off` fallback. The event handler updates the snapshot and requests an immediate render without typing deferral.

| Pi level | Text |
| --- | --- |
| `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | `think:off` / `think:min` / `think:low` / `think:med` / `think:high` / `think:xhigh` / `think:max` |

High levels may use stronger semantic styling, but color/glyph is never the sole indication.

## Model and path formatting

**Model** — favor a recognizable short ID; strip redundant date/vendor prefixes only through tested normalization rules; retain enough provider/model text when scoped models become ambiguous. Use compact content before truncating identifiers at narrow widths.

**Path** — modes: `basename` (directory name), `abbreviated` (`~` + shortened components), `full` (normalized, width-bounded). Never reveal a path beyond what Pi already displays locally; never send path data externally.

## Git provider and rendering

```ts
interface GitSnapshot {
  available: boolean;
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead?: number;
  behind?: number;
  refreshing: boolean;
  error?: string;
}
```

Default compact rendering: `⎇ main +2 *1 ?3` — clean branch uses `gitClean` semantics; any change uses `gitDirty` plus state indicators; staged `+N`, unstaged `*N`, untracked `?N`; options can hide individual counters; not-a-repository hides the segment; provider errors keep a stale value when safe and appear in doctor output. Work happens asynchronously outside render; refreshes are timeout-bounded and deduplicated. Invalidation sources include writes/edits and detected branch/worktree-changing Bash commands.

## Context and compaction

Context uses Pi's usage API when available: percentage and optionally current/window tokens. Thresholds (shared by status/editor/startup):

| Usage | Semantic state |
| --- | --- |
| <50% | low |
| 50–74% | medium |
| 75–89% | high |
| ≥90% | critical |

Auto-compaction is a compact marker/label; detected custom compaction status takes precedence over a misleading native auto marker.

## Usage and cost

Usage aggregation includes finalized assistant usage and tool-reported nested model usage. Live streaming usage may temporarily replace the latest finalized usage but never double counts after finalization. Cost is hidden when no reliable cost exists, subscription/OAuth mode makes currency cost misleading, or all totals are zero and the preset omits zeros. No network currency conversion exists.

## Extension statuses and custom items

Extensions publish status through `ctx.ui.setStatus(key, text)`; Pi aggregates them in the footer data provider and pi-style surfaces them via the `extension_statuses` segment — only the values (which carry their own labels), sorted by key and joined with spaces. The default preset places them on the secondary row; moving the segment into `left`/`right` merges them into the main row. Configured custom items add label/icon/color/priority and select a status key; they cannot execute code or parse arbitrary terminal control sequences. Notifications that must stay visually separate use the notifications widget.

## Presets

| Preset | Layout |
| --- | --- |
| `default` | `left: path, git, context_bar, cost` · `right: model_effort` · `secondary: extension_statuses` · separator `\|` (plain pipe); one blank row below the primary row (`bottomMargin`). |
| `minimal` | `left: path, git` · trailing `context_pct` · dot/slash separator. |
| `compact` | `left: model, thinking, git` · trailing `context_pct` · `secondary: extension_statuses`. |
| `full` | `left: hostname, model, thinking, path, git, session` · trailing `token_in, token_out, cache_read, cost, context_pct, time_spent, time` · `secondary: extension_statuses`. |
| `ascii` | ASCII labels and separators. |
| `native` | Minimal color and decoration preserving the active Pi theme. |

## Custom layout

Layout groups are `left`, `right` (right-aligned trailing), and `secondary`; configuration semantics are defined in `CONFIGURATION.md`. The right group renders flush to the right edge with a minimum two-space gap after a deliberate separator. Alignment is stable under ANSI width and narrow widths because the primary line is padded to the exact widget width and truncated only as a last resort.

## Responsive algorithm

1. Resolve layout; remove disabled/duplicate IDs.
2. Render each candidate once into normal/compact variants; drop invisible/empty.
3. Calculate ANSI-aware widths including separators and padding.
4. Fit essential segments in order; replace eligible items with compact variants.
5. Move overflow-capable items to the secondary row by priority.
6. Remove lowest-priority optional items when secondary also overflows.
7. Truncate only segments that explicitly allow it (usually path/model/custom text).
8. Verify both output lines fit the width.

Essential order defaults to model → thinking → path/Git → context; presets can alter priority.

## Caching and refresh

Cache key includes width, layout/config revision, snapshot revision, theme generation, glyph mode, and streaming state where it changes values. Refresh triggers: model/thinking selection, context/usage update, Git completion/invalidation, extension status change, theme/config change, session tree/compaction/name change, and terminal resize.

## Error and fallback behavior

- A failing segment is omitted and recorded, never allowed to break the row.
- Missing footer data hides only dependent segments.
- Unknown separators fall back to a safe Unicode/ASCII separator.
- Extremely narrow widths may render only `model think:<level>` or one truncated essential segment; width ≤ 0 returns no lines.

## Requirements

- **STAT-001:** use native Pi widget layout.
- **STAT-002:** thinking level updates live.
- **STAT-003:** configured segments are deterministic and deduplicated.
- **STAT-004:** primary and secondary lines never exceed width.
- **STAT-005:** render performs no I/O/session scan.
- **STAT-006:** Git refresh is cached, asynchronous, deduplicated, and invalidatable.
- **STAT-007:** missing data hides only affected segments.
- **STAT-008:** ASCII/no-font mode remains meaningful.
- **STAT-009:** extension statuses can be surfaced without altering their owners.
- **STAT-010:** theme/config/session changes invalidate relevant caches.
- **STAT-011:** usage aggregation avoids double counting.
- **STAT-012:** the right layout group is right-aligned flush to the edge with a stable minimum gap under ANSI width and narrow widths.

## Validation coverage

- every preset at widths 40/60/80/120/160;
- all thinking levels, including model changes that clamp a level;
- long model/path/branch/custom status;
- no Git, clean Git, all dirty counters, Git error/stale refresh;
- context thresholds and missing window; subscription vs API-cost mode;
- duplicate/disabled/explicit-empty layout configuration;
- Unicode, ASCII, and no-color rendering; live/final usage transition;
- widget install/remove and render-request events.

## Roadmap coverage

- Implemented in: Phase 2.
- Extended custom configuration: Phase 6.
- Platform/performance proof: Phase 7; manual evidence pending.
- Requirement IDs: `STAT-001` through `STAT-012`.
