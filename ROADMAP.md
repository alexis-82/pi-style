# pi-style roadmap

> Status: **Phase 7 verified** — the full v1 phase sequence (Phases 0–7) is verified. Terminal-global background synchronization remains unsupported/off for technical v1.

This roadmap defines the sequence for implementing the complete pi-style product. The phases are **sequencing boundaries, not an MVP scope reduction**. The intended v1 consists of every phase through Phase 7. Completing only the status line or editor is not completion of pi-style.

## Product direction

pi-style combines:

- native Pi layout with a responsive, segment-based status architecture;
- a compact, structured visual language shared across editor, startup, messages, and tools;
- a layered package/build/test structure.

The product contract lives in [`docs/PRODUCT.md`](docs/PRODUCT.md). Detailed behavior lives under [`docs/ui/`](docs/ui/README.md). Architecture decisions live under [`docs/decisions/`](docs/decisions/README.md).

## Guiding principles

- **Native Pi behavior first.** Pi owns feed scrolling, selection, resize, and terminal layout.
- **One visual system.** Status, editor, startup, messages, and tools share semantic themes and spacing.
- **No I/O in render.** Filesystem, Git, settings, and session aggregation use cached providers.
- **Compatibility is explicit.** Public APIs precede reflective composition; core patches are isolated and optional.
- **Incremental, not incomplete.** Each phase produces a usable slice, but the roadmap continues to the documented full product.
- **Proof accompanies features.** A phase is complete only when its automated/manual gates pass.

## Phase status summary

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Contract and repository foundation | **Completed** |
| 1 | Runtime, configuration, and theme foundation | **Completed (Phase 1A)** |
| 2 | Complete status-line subsystem | **Completed** |
| 3 | Complete styled editor subsystem | **Completed — executable implementation** |
| 4 | Startup presentation | **Completed — executable implementation** |
| 5 | Messages and tool presentation | **Completed — Peer accepted** |
| 6 | Full configurability and extension composition | **Completed — independently Peer accepted and Root validated** |
| 7 | Hardening, platform validation, and v1 release | **Verified** — terminal-global background synchronization unsupported/off for technical v1 |
| 8 | Git and GitHub semantic renderers | **Planned** |
| 9 | Turn tool summaries | **Planned** |
| 10 | User-prompt image previews | **Planned** |
| 10b | Clipboard image input | **Planned** — completes the image-paste absorption (ADR 0009) |

---

## Phase 0 — Contract and repository foundation

### Objective

Turn the initial workspace into a well-specified, buildable Pi package with enforceable architecture boundaries and a validation harness.

### Deliverables

#### Documentation

- Complete the product, architecture, configuration, lifecycle, compatibility, testing, and UI contracts under `docs/`.
- Record ADR 0001–0004.
- Define stable requirement identifiers and roadmap traceability.
- Add a root README summarizing installation intent and linking to docs once package identity is finalized.

#### Package scaffold

Create a structure modeled after `../pi-rules`:

```text
extension-src/pi-style/{shared,domain,features,app,pi}
themes/
test/{unit,render,integration,compatibility,performance,e2e,helpers}
dist/
```

Add:

- `package.json` with `pi-package` metadata;
- strict `tsconfig.json`;
- `tsup.config.ts`;
- `vitest.config.ts`;
- `biome.json`;
- dependency-cruiser configuration;
- `.gitignore`, `LICENSE`, `CHANGELOG.md`, and contribution/release basics;
- npm scripts for `typecheck`, `lint`, `depcruise`, `test`, `build`, and `check`.

#### Entrypoints

- Create a thin Pi extension entry at `extension-src/pi-style/pi/index.ts`.
- Declare the TypeScript extension entry at `extension-src/pi-style/pi/index.ts` through the package manifest (Pi's jiti loader aliases `@earendil-works/*` to runtime copies so prototype patches hit the real classes) and build an ESM bundle at `dist/extensions/pi-style.js` as a compile check.
- Declare optional theme resources through the Pi package manifest.
- Do not add a public library entry until Phase 6 identifies reusable contracts.

#### Test foundation

- Build a fake Pi host that records handlers, widgets, editor/footer/header ownership, themes, render requests, and cleanup.
- Add architecture tests or dependency-cruiser rules.
- Add one package load/start/shutdown smoke test.

### Dependencies

None.

### Exit criteria

- `npm run check` passes from a clean install.
- The extension loads in a fake host and performs no background work before `session_start`.
- Layer violations fail the architecture gate.
- Every planned v1 surface has acceptance criteria in docs.
- The package can be run with `pi -e ./extension-src/pi-style/pi/index.ts` without corrupting startup, even though features are not yet implemented.

### Primary docs

- [`docs/PRODUCT.md`](docs/PRODUCT.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TESTING.md`](docs/TESTING.md)
- ADR 0001–0004

---

## Phase 1 — Runtime, configuration, and theme foundation

> Phase 1A exit criteria passed: configuration, generation-safe runtime/disposal, scheduler, snapshots, semantic themes/glyphs, ANSI-safe helpers, capability diagnostics, headless preservation, lifecycle tests, package/build smoke, and required static diagnostics.

### Objective

Build the shared services required by every UI surface before implementing visible feature complexity.

### Deliverables

#### Configuration

- Define `PiStyleConfig`, normalized config, defaults, and schema version.
- Read global and trusted project `piStyle` settings.
- Implement precedence: defaults < global < project < env < session override.
- Normalize invalid types/enums/arrays without startup failure.
- Implement minimal `/pi-style`, `/pi-style on|off`, `/pi-style reload`, and `/pi-style doctor` foundation.

#### Runtime and lifecycle

- Create explicit runtime state and generation tokens.
- Implement `DisposableStore`.
- Implement shared render scheduler with immediate/coalesced/deferred update classes.
- Implement immutable `UiSnapshot` and revision tracking.
- Add headless mode guards.
- Implement idempotent session start/shutdown and config reload orchestration.

#### Theme and rendering foundation

- Implement semantic theme resolver over the active Pi theme.
- Implement portable glyph sets: Unicode default and explicit ASCII preset.
- Use Unicode by default and an explicit ASCII preset; accept legacy font settings without affecting rendering.
- Add ANSI-safe width/truncation/wrapping helpers.
- Implement `NO_COLOR` behavior.
- Terminal-global background synchronization is unsupported/off for technical v1; explicit cell backgrounds and Pi theme APIs remain supported.

#### Provider foundation

- Define injected provider interfaces for model, thinking, context, footer data, Git, usage, extension statuses, and capabilities.
- Implement capability detection and doctor diagnostic records.

### Dependencies

Phase 0.

### Exit criteria

- Config precedence and invalid-input tests pass.
- Ten fake start/shutdown/reload cycles leave no timers/listeners/installations.
- Theme resolution works with dark, light, custom, missing-token, no-color, Unicode, and ASCII cases.
- Render helpers prove width and ANSI containment.
- Headless modes start no TUI/terminal resources.
- Doctor output explains effective config and detected capabilities without secrets.

### Primary docs

- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)
- [`docs/LIFECYCLE-AND-COMPOSITION.md`](docs/LIFECYCLE-AND-COMPOSITION.md)
- [`docs/ui/THEMING.md`](docs/ui/THEMING.md)
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)

---

## Phase 2 — Complete status-line subsystem

### Objective

Implement the full segment-based information surface using native Pi widgets, including live thinking level, responsive layout, smart defaults, providers, and extension-status integration.

### Deliverables

#### Segment domain

- Segment contracts, registry, priorities, normal/compact variants, and options.
- Built-in segments: Pi/model/thinking/path/Git/context/compaction/usage/cache/cost/time/host/session/extension statuses.
- Stable formatting for model, path, tokens, percentages, costs, time, and Git indicators.

#### Presets and layout

- `default`, `minimal`, `compact`, `full`, `ascii`, and `native` presets.
- Custom `left`, logical `right`, and `secondary` groups.
- Explicit-empty and deduplication semantics.
- Disabled segments and configured custom extension-status items.
- Separator styles with Unicode/ASCII glyphs.

#### Responsive renderer

- Primary and secondary row fitting by priority.
- Compact variants and controlled truncation.
- No orphan separators or blank rows.
- Width-safe behavior down to very narrow terminals.
- Render cache keyed by width/theme/config/snapshot revision.

#### Live state

- Immediate `thinking_level_select` updates.
- `model_select`, context, session name/tree/compaction, usage, and extension-status updates.
- Shared snapshot integration for later editor/startup use.

#### Providers

- Async cached Git provider with timeout, stale-while-refresh, deduplication, invalidation, and disposal.
- Incremental/cached usage aggregation.
- Context/compaction and subscription-aware cost behavior.
- Footer data bridge only when compatible and necessary.

#### Native UI installation

- Notifications widget.
- Primary widget configurable above/below editor.
- Secondary widget below editor.
- Stable namespaced widget IDs and complete removal.

### Dependencies

Phase 1 runtime, snapshots, theme, scheduler, providers, and capabilities.

### Exit criteria

- All `STAT-*` requirements are proven.
- Every preset passes render tests at 40/60/80/120/160 columns.
- Thinking changes are visible immediately.
- Git and session work never runs inside render.
- Missing footer/Git/usage data hides only affected segments.
- Another footer owner can be preserved with documented degradation.
- Streaming bursts produce bounded render requests.
- ASCII/no-color output remains understandable.

### Primary doc

- [`docs/ui/STATUS-LINE.md`](docs/ui/STATUS-LINE.md)

---

## Phase 3 — Complete styled editor subsystem ✅ Implemented

### Objective

Implement the primary compact, structured input experience while preserving Pi editing, keybindings, cursor/IME behavior, and existing extension ownership.

**Status:** Implemented with executable render/lifecycle proof; manual IME and terminal-matrix verification remains manual evidence.

### Deliverables

#### Editor styles

- `compact` default style.
- `boxed` structured style.
- `dock` outlined style.
- `native` fallback style.
- Frame modes: auto, halfblock, line, solid, outline, native.

#### Input rendering

- Prompt glyph and fallback.
- Correct padding, wrapping, multiline continuation, and cursor marker alignment.
- Thinking-level border semantics.
- Subtle working/streaming state without excessive animation.
- Narrow-width degradation before input usability is affected.

#### Metadata

- Optional model/thinking/context/path/Git/extension-status rows using the shared snapshot.
- Preset-driven metadata ownership so the default does not duplicate the status line.
- Theme and no-color support.

#### Composition

- Capture previous editor factory.
- Preserve supported autocomplete/provider behavior where possible.
- Prefer existing editor by default when composition is impossible.
- Explicit force/preference diagnostics.
- Identity-safe restoration on disable/reload/shutdown.

#### Scope protection

Do not add Bash mode, prompt stash, shell history, directory-jump shortcuts, or private autocomplete-state styling.

### Dependencies

Phase 1 foundation and Phase 2 shared status snapshot/metadata contracts.

### Exit criteria

- All `EDIT-*` requirements are proven.
- Multiline prompt/cursor alignment passes render and manual IME checks.
- All styles remain usable at narrow widths and in ASCII/no-color mode.
- Existing editor conflict scenarios behave according to config.
- Disable/reload/session replacement restores a usable editor.
- No private autocomplete state is required.

### Primary doc

- [`docs/ui/EDITOR.md`](docs/ui/EDITOR.md)

---

## Phase 4 — Startup presentation ✅ Implemented

### Status

Implemented with public API integration, snapshot-only rendering, reason-aware compact/overlay behavior, dismissal/timeout lifecycle proof, headless fallback, resource snapshot capture, and generation-safe cleanup. Full terminal matrix proof remains manual evidence.

### Objective

Add a compact, branded, informative startup experience without blocking the editor or duplicating resource discovery work.

### Deliverables

#### Compact mode

- Header/resource summary using public Pi header API or safe widget fallback.
- Model/thinking/project/context and resource counts.
- Active preset and compatibility fallback summary where useful.

#### Overlay mode

- Optional responsive overlay with branded hierarchy and concise hints.
- Minimum width/height checks.
- Escape/input/agent/tool/timeout dismissal.

#### Lifecycle

- Show rules by session reason.
- Quiet and off modes.
- Snapshot resource data before mount; no render-time discovery.
- Generation-safe dismissal and shutdown cleanup.
- Headless fallback.

### Dependencies

Phase 1 runtime/theme/lifecycle; may consume Phase 2 snapshot values.

### Exit criteria

- All `START-*` requirements are proven.
- Startup appears only for configured reasons.
- Stale overlay callbacks cannot affect a new session.
- Resource errors degrade to known model/project information.
- Narrow/short/no-color/ASCII cases remain usable.
- Startup never delays prompt use for normal compact mode.

### Primary doc

- [`docs/ui/STARTUP.md`](docs/ui/STARTUP.md)

---

## Phase 5 — Messages and tool presentation

### Objective

Extend the compact visual system into the conversation feed while respecting Pi version risk, native rich content, built-in tool semantics, and other extensions.

**Acceptance disposition:** Phase 5 is complete and Peer accepted for the certified exact Pi `0.83.0` subset within `>=0.83.0 <0.84.0`. Certified surfaces are user/assistant message prefixes and tool call/result selectors with exact pending/running/error markers. Approved fallbacks remain native for special message blocks, unreliable generic cancelled/truncated distinction, and image-specific decoration. The checkpoint contains 69 passing tests across 8 files. This does not authorize Phase 6 or claim full release/platform completion.

### Deliverables

#### Shared render primitives

- Role prefix, badge, compact box, state marker, metrics line.
- Shared width/theme/background safety.

#### Messages

- Optional user and assistant prefixes. **Accepted certified subset:** exact Pi 0.83.0, explicit core+surface flags, native fallback otherwise.
- Streaming, thinking-only, tool-only, and mixed assistant states.
- Compaction, skill, branch-summary, and custom (MCP) message blocks, boxed when `messages.specialBlocks` is authorized (**certified adapters over the native `updateDisplay`/`rebuild` identities; theme-cached native fallback otherwise**).
- Expanded/collapsed behavior where host support exists.

#### Tools

- Compact boxed state-aware call headers and results for read/write/edit/find/list/grep/bash/quick-edit/substitute-edit/target-edit plus a boxed generic fallback. **Accepted certified subset:** tool call/result selectors with `marker` (`[tool]`, `[tool:result]`) or `compact-box` rendering, pending/running/error state; cancelled/truncated remains native/neutral when unavailable.
- Native syntax highlight/diff/truncation/expansion preservation.
- Partial, success, error, cancellation, empty, and truncated result states.
- Elapsed/result metrics when reliable (wall-clock state tracking; no tool re-registration).

#### Integration and patches

- Prefer public renderer hooks.
- Use renderer-only override before execution override.
- Add isolated Tier C patches only for documented missing hooks.
- Patch registry, capability/version gates, idempotence, identity-safe restore, and doctor reporting.
- Native/existing renderer fallback.

### Dependencies

Phase 1 theme/lifecycle/capabilities; Phase 0 ADR 0004; compatibility fake-host support.

### Exit criteria

- All `MSG-*` and `TOOL-*` requirements are proven.
- Streaming/partial/final transitions are correct.
- Built-in tool execution and result shapes remain unchanged.
- Unsupported host shapes disable only the affected surface.
- Repeated reload does not stack patches.
- Cleanup does not overwrite a later extension owner.
- Native fallback snapshots remain valid.

### Primary docs

- [`docs/ui/MESSAGES-AND-TOOLS.md`](docs/ui/MESSAGES-AND-TOOLS.md)
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)
- [ADR 0004](docs/decisions/0004-compatibility-tiers-and-patch-policy.md)

---

## Phase 6 — Full configurability and extension composition

### Objective

Complete the user-facing control plane, persistence, migrations, cross-extension behavior, and diagnostics. Public package reuse remains intentionally unclaimed because no external reuse is demonstrated.

**Acceptance disposition:** Phase 6 is accepted after fresh independent frozen-scope Peer acceptance and Root validation. The observed evidence includes 135 tests across 9 files in the full suite, 112 focused Phase 6/startup/compatibility tests, 26 changed-file primary LSP checks clean, clean typecheck/lint/depcruise/build/package smoke/check/pack dry-run/diff gates, no full-Lens errors, and real Pi JSON/print headless smokes exiting 0. Phase 5 remains separately accepted for its exact certified subset. This disposition does not claim release, platform, performance, or terminal-matrix completion.

### Deliverables

#### Configuration completeness

- Persisted global/project settings with non-destructive writes.
- Full command surface and TUI settings selectors.
- Per-surface enable/disable.
- Preset, placement, editor style/frame, startup mode, message/tool style controls.
- Custom status layout/items and theme/glyph overrides.
- Config schema version and migrations.
- Environment emergency recovery overrides.

#### Runtime reconfiguration

- Diff-based reinstall of changed surfaces.
- Preserve unchanged providers where safe.
- Immediate theme/layout invalidation.
- Session-only versus persisted command behavior.

#### Composition

- Existing editor/footer/message/tool owner preference matrix.
- Explicit force options only where safe and documented.
- Extension-status custom item integration.
- Diagnostics for active/disabled/conflicted/failed surfaces.

#### Doctor and public contracts

- Complete `/pi-style doctor` output.
- Pure configuration presets, migration validation, storage adapters, and bounded doctor foundations are implemented without adding a public package entry. Full cross-extension composition remains bounded by existing Pi capabilities.
- Document compatibility and migration support policy.

### Dependencies

Phases 1–5.

### Exit criteria

- All `CFG-*`, remaining `LIFE-*`, and composition `COMPAT-*` requirements are proven.
- Global/project/env/session precedence works and reports value sources.
- Invalid configuration cannot break startup.
- Commands persist only to explicit scope.
- Runtime changes do not require full Pi restart where reload is sufficient.
- Conflicts produce actionable diagnostics and safe fallback.
- Config migration fixtures cover all released schema versions.

### Primary docs

- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)
- [`docs/LIFECYCLE-AND-COMPOSITION.md`](docs/LIFECYCLE-AND-COMPOSITION.md)
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)

---

## Phase 7 — Hardening, platform validation, and v1 release

**Status:** Verified. The phase-7 evidence (performance/resource audits, render bounds, runtime lifecycle, boxed tools/special blocks, startup logo/resources) passes the full `npm run check` gate. Terminal-global background synchronization remains unsupported/off for technical v1; physical terminal/platform/color fidelity stays unclaimed.

### Objective

Prove the complete product under performance, terminal, lifecycle, packaging, and release constraints.

### Deliverables

#### Performance and resource audit

- Render benchmarks for status/editor/messages/tools.
- Streaming render request/coalescing measurements.
- Git/session provider cache audits.
- Memory/listener/timer/process leak tests.
- Large session and long path/model/branch stress cases.

#### Terminal and accessibility matrix

- Ghostty, iTerm2, Kitty, WezTerm.
- Common Linux terminal.
- Windows Terminal native and WSL.
- tmux/SSH where practical.
- Unicode default and ASCII glyph modes.
- truecolor, 256-color approximation, and `NO_COLOR`.
- widths 40/60/80/120/160 and short heights.
- terminal-global background synchronization remains unsupported/off for technical v1 unless mandatory platform evidence changes this decision.

#### Pi compatibility matrix

- Define tested Pi version range.
- Run public API and capability tests on supported versions/builds.
- Record Tier C surface support/fallback.
- Verify another-editor/footer/renderer coexistence cases.

#### Packaging and release

- Final package name/version/metadata and `pi-package` gallery assets.
- Correct peer dependencies and externals.
- `npm pack` contents audit.
- install/update/remove and `pi -e` smoke tests.
- README, CONTRIBUTING, LICENSE attribution, CHANGELOG, CI, and publish workflow.
- Screenshot/manual smoke protocol.

#### Documentation reconciliation

- Update all shipped features from `Planned` to `Implemented`.
- Remove or clearly label unsupported claims.
- Ensure every v1 requirement is implemented, superseded, or rejected through an accepted ADR.

### Dependencies

Phases 0–6.

### Exit criteria

- Full `npm run check` passes from a clean checkout.
- Required terminal and Pi compatibility evidence is recorded.
- No required surface relies on an undocumented fallback.
- Optional Tier C/Tier-global-terminal behaviors are clearly disclosed.
- Package install, reload, session switch, disable, shutdown, update, and removal are clean.
- All v1 requirement IDs have proof or an accepted disposition.
- No earlier phase remains a hidden “MVP shortcut.”

### Primary docs

- [`docs/TESTING.md`](docs/TESTING.md)
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)
- [`docs/ui/THEMING.md`](docs/ui/THEMING.md)
- [`docs/PRODUCT.md`](docs/PRODUCT.md)

---

## Phase 8 — Git and GitHub semantic renderers

**Status:** Planned. Design accepted as [ADR 0005](docs/decisions/0005-git-github-semantic-renderers.md) (2026-08-05).

### Objective

Render `git` and `gh` results semantically as **presentation adapters of the Bash result**: the Bash tool keeps executing the command unchanged, and only the presentation of the result changes. Git/GitHub views reuse the existing boxless tree family (`List`/`Glob`/`Grep`), the boxed result shell, and the `Edit` adaptive diff component — no new tool registration, no "Git mode", no second diff visual language. Anything that cannot be parsed safely (pipes/redirects/`&&`/`;`, plumbing, `gh api`, hostile output, nonzero exit with unparseable output) falls back to the raw boxed Bash shell. This phase is **presentation-only** and is distinct from the post-v1 "Shell/Bash mode" research item, which would own input/interpretation.

### Deliverables

#### Phase 8A — Git summary cards (boxless)

- `classifyGitCommand` + registry keyed by `toolCallId` (mirrors `bashTreeStates`; reset on session start/shutdown).
- Parsers: `git status` (long and `--short`), `git diff --stat`, short `git log`; every parser returns `null` on hostile input.
- Compact card rendering reusing `renderOutputTree` rows: summary counts (modified/untracked/staged/deleted/renamed/conflicted), grouped `├─/└─` file rows, `… N more` collapse.
- Branch shown only when it affects the result (push/merge/ahead-behind); the status line owns `⎇ main`.
- Plain Git/GitHub labels without font-dependent icons.

#### Phase 8B — Boxed diffs and content

- `git diff` / `git show` / conflict: split the unified output per file, render each file through the same `AdaptiveDiffComponent` `Edit` uses, framed by `renderBoxedToolResult` with a `Diff · +N -M` divider and `Ctrl+O` expand preservation.
- `git show --stat` is the exception: a commit header + stat block, so it renders as a diff-stat-style boxless card (not a boxed diff). A plain `git show` keeps the boxed per-file diff.
- No double-box: Git header outside, frame only around viewer content.
- Nonzero-exit results preserve raw stderr; semantic error view only when output still parses.

#### Phase 8C — Git state-change commands

- `git commit`, `push`, `pull`, `fetch`, `add`, `restore`, `reset`, `switch`, `checkout`, `merge`, `rebase`: status-summary cards when output parses (staged-file lists, push summaries, ahead/behind), raw fallback otherwise.

#### Phase 8D — `gh` workflow commands

- `gh pr list/view/create/checks`, `issue list/view`, `run list/view/watch` via `gh --json` output: boxless summaries (PR state, base/head, checks, reviews, mergeability) with boxed checks/logs for detail.
- Action hints (`d diff`, `c checks`, `Enter details`, `Ctrl+O raw`) are presentation only — no keybinding registration.
- `gh api`, extensions, and free-form JSON stay raw.

### Dependencies

Phase 5 (bash tree classification + boxed result shell + `Edit` diff component); ADR 0005. No new Pi-core patch identity — the renderers extend the already-certified bash renderer surface.

### Exit criteria

- All `GIT-001`–`GIT-004` and `GH-001`–`GH-002` requirements are proven.
- Parser unit tests accept valid long/`--short`/`diff --stat`/`log`/`gh --json` output and return `null` on hostile input.
- Render snapshots cover compact cards, boxed diff reuse, raw fallback, and nonzero-exit stderr preservation; `NO_COLOR`, Unicode, and ASCII modes are readable.
- Built-in Bash execution and result shapes remain unchanged (`TOOL-001`).
- Unparseable/unsupported commands render the raw boxed Bash shell (`GIT-003`).
- `npm run check` passes.

### Primary docs

- [`docs/decisions/0005-git-github-semantic-renderers.md`](docs/decisions/0005-git-github-semantic-renderers.md)
- [`docs/ui/MESSAGES-AND-TOOLS.md`](docs/ui/MESSAGES-AND-TOOLS.md)
- [`docs/ui/THEMING.md`](docs/ui/THEMING.md)

---

## Phase 9 — Turn tool summaries

**Status:** Planned. Design accepted as [ADR 0007](docs/decisions/0007-turn-tool-summaries.md) (2026-08-08).

### Objective

When a turn completes, collapse that turn's finalized tool blocks into a single summary line (`➔ Read 2 files, ran 4 shell commands · 3.1s`), reclaiming feed space without touching Pi's execution, expansion state, or keybinding surface. This is a presentation-only extension of the certified boxed renderer surface — no new Pi-core patch identity, no new keybinding, no new compatibility surface. Expansion is Pi's existing global tool-output toggle (`app.tools.expand`, Ctrl+O): pi-style only reads `options.expanded`.

### Deliverables

#### Turn registry (app layer)

- Turn grouping keyed by `toolCallId`: leader id, per-tool counts, total elapsed, failed count.
- Populated from the session snapshot at `turn_end`/`session_tree`; rebuilt on resume; reset on session start/shutdown.
- `turnEnded` derived from session content (message completed, subsequent message or session end exists), never from runtime event flags.

#### Summary rendering (boxed renderer)

- Leader renders the summary line; other tool items of the turn render zero lines (batch-member pattern).
- `➔ Read 2 files, ran 4 shell commands · 3.1s` format with `pluralForm`, wall-clock elapsed, `safeTruncateToWidth`; Unicode/ASCII glyph variants.
- Never collapsed: errors, partial/pending, interrupted turns, the running turn, `user_bash` blocks. Error blocks stay visible; optional `· N failure(s)` marker.
- `expanded` override: full boxes when Pi's global toggle is on; summaries when off.

#### Configuration

- Leaf `tools.collapseAfterTurn: "off" | "on"` (default `on`).
- Preset mapping: `default`/`compact`/`full`/`ascii` → `on`; `minimal`/`native` → `off`.
- Same precedence ladder, normalization-safe fallback, `/pi-style set` support, doctor diagnostics.

### Dependencies

Phase 5 (boxed renderer, batch registry patterns, `bashTreeStates`); ADR 0007. No new Pi-core patch identity — the feature extends the already-certified boxed renderer surface.

### Exit criteria

- `SUM-001`–`SUM-005` are proven.
- Resume determinism: history renders collapsed after a session reload with no in-process `turn_end` events.
- Expand override: Ctrl+O round-trip renders full blocks and restores summaries; pi-style never calls `setExpanded`.
- Error/partial/interrupted blocks remain visible in every collapsed state.
- `npm run check` passes.

### Primary docs

- [`docs/decisions/0007-turn-tool-summaries.md`](docs/decisions/0007-turn-tool-summaries.md)
- [`docs/ui/MESSAGES-AND-TOOLS.md`](docs/ui/MESSAGES-AND-TOOLS.md)

---

## Phase 10 — User-prompt image previews

**Status:** Planned. Design accepted as [ADR 0008](docs/decisions/0008-user-prompt-image-previews.md) (2026-08-22). Absorbs the presentation half of `@pi-archimedes/image-paste`; the input half is Phase 10b.

### Objective

Images attached to the user's prompt currently render nowhere in the feed. Render them as inline previews directly below the user message through a display-only channel that never touches the LLM context: a `pi-style-image-preview` **CustomEntry** appended at `before_agent_start` (the event carries the prompt's `images`) and rendered via `registerEntryRenderer` with pi-tui `Image` components (`maxWidthCells: 60`, themed fallback line on terminals without image support). CustomEntry — not image-paste's display-only custom messages — is the channel: `custom_message` entries map into the session's context message list, CustomEntries are documented as not sent to the LLM.

### Deliverables

- Entry renderer (`features/messages/image-preview.ts`): one `Image` per attached image, ANSI-safe fallback (mime + dimensions, no base64 leakage), malformed-entry zero-line guard.
- Wiring (`pi/index.ts`): register the entry renderer at extension load; append one entry per run carrying images from `before_agent_start` (no image decoding on the event path).
- Config leaf `messages.showImagePreviews: boolean` (default `true`) gating both append and render; messages render-config module mirrors the tools `session-config` pattern.
- Documented conflict behavior: double render when an input extension that also previews is installed — disable one side.

### Dependencies

ADR 0008. No new Pi-core patch identity — public extension APIs only (`registerEntryRenderer`, `appendEntry`, `before_agent_start`).

### Exit criteria

- `IMG-001`–`IMG-005` are proven.
- Resume determinism: persisted entries render identically in scroll-back and after reload.
- No base64 data in any rendered fallback line.
- `npm run check` passes.

### Primary docs

- [`docs/decisions/0008-user-prompt-image-previews.md`](docs/decisions/0008-user-prompt-image-previews.md)
- [`docs/ui/MESSAGES-AND-TOOLS.md`](docs/ui/MESSAGES-AND-TOOLS.md)

---

## Phase 10b — Clipboard image input

**Status:** Planned. Design accepted as [ADR 0009](docs/decisions/0009-clipboard-image-input.md) (2026-08-22).

### Objective

Make the complete image-paste feature — paste → attach → preview — work with pi-style alone. Pi's built-in `Ctrl+V` writes the clipboard image to `<tmpdir>/pi-clipboard-<uuid>.<ext>` and inserts the path as text; pi-style intercepts those tokens on the `input` event (`source: "interactive"`), attaches the bytes as real `ImageContent` (≤ 20 MB, extension-derived mime), rewrites the token to `[image]`, and lets ADR 0008's preview surface render it. No shortcut registration (the built-in keystroke stays), no clipboard reading (Pi already wrote the file), no core patch.

### Deliverables

- Input transform (`features/messages/image-input.ts`): token pattern (tmpdir + UUID + png/jpg/jpeg/webp/gif), fs read + size guard, `[image]` rewrite, verbatim passthrough for missing/oversized tokens.
- Wiring: `pi.on("input")` handler (interactive source only) returns `{ action: "transform", text, images }`; images flow to `before_agent_start` → preview entry.
- Config leaf `messages.clipboardImages: boolean` (default `true`) in `render-config` alongside `showImagePreviews`.

### Dependencies

ADR 0009; ADR 0008 (preview surface, unchanged). No new Pi-core patch identity.

### Exit criteria

- `IMG-006`–`IMG-009` are proven.
- Native passthrough: config `false` or no matching tokens → input text reaches the model verbatim.
- `npm run check` passes.

### Primary docs

- [`docs/decisions/0009-clipboard-image-input.md`](docs/decisions/0009-clipboard-image-input.md)
- [`docs/ui/MESSAGES-AND-TOOLS.md`](docs/ui/MESSAGES-AND-TOOLS.md)

---

## Post-v1 research lane

These items are not silently included in v1. Each requires a new product contract, ADR, compatibility tier, and validation plan.

| Research item | Entry condition |
| --- | --- |
| Fixed user zone | A concrete UX problem cannot be solved with native Pi layout. |
| Terminal scroll-region compositor | Fixed-zone ADR accepted with terminal/resize/selection matrix. |
| Fixed-zone selection and clipboard | Only after compositor ownership exists. |
| Chat virtualization | Profiling demonstrates feed size/render bottleneck. |
| Physical buffer synchronization/self-heal | Reproducible terminal drift remains after native fixes. |
| Shell/Bash mode | Separate product approval; not a styling feature. |
| Prompt stash/history/navigation | Separate productivity package or explicit scope expansion. |
| AI working vibes | Separate optional extension, not core pi-style. |

## Phase-to-document traceability

| Phase | Product/architecture | Primary UI contract | Compatibility | Required proof |
| --- | --- | --- | --- | --- |
| 0 | Product, architecture, ADRs | All contracts drafted | Tier policy defined | Scaffold and architecture gates |
| 1 | Config, runtime, lifecycle | Theming | Capabilities/headless | Unit and lifecycle integration |
| 2 | Snapshot/providers | Status line | Widget/footer composition | Status/render/provider tests |
| 3 | Metadata ownership | Editor | Existing editor composition | Alignment/render/lifecycle tests |
| 4 | Startup scope | Startup | Header/overlay fallback | Reason/dismissal/stale-session tests |
| 5 | Feed presentation | Messages/tools | Tier C patches | Streaming/patch/fallback tests |
| 6 | User control/migrations | All configurable surfaces | Conflict/doctor matrix | Persistence/composition tests |
| 7 | Full product completion | All | Platform/version matrix | Full check, benchmarks, manual smoke |
| 8 | Git/GitHub semantic renderers | Messages/tools | Certified bash renderer surface | Parser/render/fallback tests, full check |
| 9 | Turn tool summaries | Messages/tools | Certified boxed renderer surface | Registry/render/lifecycle tests, full check |
| 10 | User-prompt image previews | Messages | Public entry-renderer API (no patch) | Renderer/config/lifecycle tests, full check |

## Rules for roadmap updates

- Moving a deliverable between phases is allowed when dependencies change, but does not remove it from v1.
- Removing a v1 deliverable requires updating `PRODUCT.md`, its UI contract, and an accepted ADR when architectural.
- A phase is not complete with failing required tests or unresolved cleanup/compatibility errors.
- New ideas first update the product contract and owning UI contract, then are assigned a phase or post-v1 lane.
- Release notes should identify which requirement IDs and roadmap deliverables changed.
