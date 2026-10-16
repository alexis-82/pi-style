# Testing and validation

> Status: **Phase 7 verified**

## Goals

Visual output must be proven by executable contracts, not only screenshots. Tests distinguish pure layout correctness, Pi lifecycle integration, compatibility behavior, render performance, and real terminal validation.

## Validation ladder

```text
npm run typecheck
npm run lint
npm run depcruise
npm run test
npm run build
npm run check
```

`npm run check` runs all required automated gates in a stable order; release workflows run it from a clean checkout.

## Test structure

```text
test/
├── unit/
│   ├── foundation.test.ts            — config, scheduler, snapshot, theme/ANSI, disposal
│   ├── config-control-plane.test.ts  — precedence, persistence, commands, doctor, composition
│   ├── status.test.ts                — status contracts, responsive renderer, cached providers
│   ├── editor.test.ts                — styled editor renderer
│   ├── startup.test.ts               — startup presentation
│   ├── startup-lifecycle.test.ts     — startup lifecycle safety
│   ├── startup-logo.test.ts          — startup logo + ANSI foreground parsing
│   ├── startup-resources.test.ts     — startup tool resource collection
│   ├── session-usage.test.ts         — session usage aggregation
│   ├── boxed-tools.test.ts           — box primitives, boxed tools, special blocks
│   └── compatibility-probe.test.ts   — identity-certified compatibility probe and patch lifecycle
├── render/           surface-rendering-widths.test.ts
├── integration/      extension-load.test.ts, startup.test.ts
├── performance/      scheduler-runtime-lifecycle.test.ts, git-provider-cache.test.ts,
│                     status-rendering-bounds.test.ts
├── e2e/              render-no-io-boundary.test.ts
└── helpers/          fake-pi-host.ts, fake-theme.ts, render-assertions.ts
```

## Unit coverage

- config normalization and precedence;
- preset merging and explicit-empty-array semantics;
- segment registry and disabled/custom layout resolution;
- thinking-level mapping including `max`;
- responsive priority/overflow decisions;
- ANSI-aware visible width and truncation;
- path/model/Git formatting;
- theme semantic fallback and glyph mode;
- session usage cache updates;
- Git parser and invalidation state;
- doctor diagnostic classification.

## Render contract tests

Render tests call components or pure renderers at fixed widths and themes.

- **TEST-001:** every line satisfies `visibleWidth(line) <= width`.
- **TEST-002:** independently rendered lines end in safe/reset styling.
- **TEST-003:** empty/missing data does not leave duplicate separators.
- **TEST-004:** `NO_COLOR` preserves meaningful labels and state.
- **TEST-005:** Unicode/ASCII built-in glyphs contain no private-use code points.
- **TEST-006:** theme invalidation changes output when semantic colors change.

### Snapshot policy

Prefer semantic snapshots: strip/normalize ANSI when testing layout text, separately assert semantic color token usage, avoid raw full-screen byte snapshots, and use small golden fixtures for complex editor/message/tool examples.

## Fake Pi host

Integration tests use a bounded fake host recording: registered handlers and commands, widget/header/editor/footer installations, working indicator changes, render requests, current theme/model/thinking/context, footer branch and extension statuses, ownership restoration, and notifications/diagnostics. It supports capability toggles so tests simulate older/missing APIs without installing multiple Pi versions.

## Lifecycle and composition coverage

- factory starts no background resources; session start installs configured surfaces;
- model/thinking events update the snapshot and request render;
- shutdown disposes in reverse order; repeated start/shutdown leaves counts unchanged;
- late provider promises are ignored after generation changes;
- disable restores previous editor/footer/working indicator; reload changes only affected surfaces;
- print/json modes create no terminal components;
- previous editor/footer matrices: none, composable, preferred, forced, preserved-later-owner.

## Compatibility and patch coverage

For every Tier C patch: supported shape installs once; repeated install is idempotent; unsupported shape disables only the feature; restore succeeds while the wrapper is active; restore never overwrites a later replacement; streaming/partial render stays correct; native fallback remains available; doctor reports active/fallback state.

## Provider tests

**Git** — one in-flight command per key; stale-while-refresh; timeout/error backoff; write/edit invalidation; branch-changing command invalidation; not-a-repository behavior; process disposal.

**Usage/context** — no full branch scan on unchanged snapshot; compaction/tree change invalidates correctly; live usage never double counts finalized usage; missing model context window produces hidden/unknown state.

## Performance tests

- no filesystem/process/network call inside render;
- cached status render is within an agreed local budget;
- a streaming burst produces bounded render requests;
- layout work is linear in configured segment count;
- usage aggregation is incremental/cached;
- repeated reload does not grow memory/listeners/timers;
- Git refreshes are deduplicated and bounded.

Performance regressions fail CI only after stable baselines exist; before that, record measurements and alert thresholds.

## Manual terminal matrix

| Dimension | Cases |
| --- | --- |
| Terminal | Ghostty, iTerm2, Kitty, WezTerm, Linux terminal, Windows Terminal/WSL |
| Width | 40, 60, 80, 120, 160 columns |
| Height | short and normal viewports |
| Glyph mode | Unicode default, ASCII mode |
| Color | truecolor, 256-color approximation, `NO_COLOR` |
| Environment | local, tmux, SSH where practical |
| Lifecycle | startup, reload, new/resume/fork, shutdown |
| Content | long model/path/branch, multiline prompt, streaming, expanded tools |

Manual evidence records Pi version, terminal/version, OS, config preset, and observed limitations. This remains manual evidence pending for the real-terminal matrix.

## Feature-specific proof

Each file under `docs/ui/` defines acceptance criteria. A feature is not `Implemented` until every requirement ID has at least one automated or explicitly manual proof, automated tests pass, manual-only claims are labeled, and fallback behavior is tested — not only the happy path.

## Phase gates

| Phase | Required proof |
| --- | --- |
| 0 | Typecheck/lint/depcruise/test/build scaffold. |
| 1 | Config, theme, runtime, scheduler, disposal, fake-host tests. |
| 2 | Status segments/layout/providers/render-width tests. |
| 3 | Editor alignment/composition/lifecycle/render tests. |
| 4 | Startup reasons/dismissal/stale-generation/render tests. |
| 5 | Message/tool patch idempotence, streaming, fallback tests. |
| 6 | Persistence, migration, commands, conflict and doctor tests. |
| 7 | Full check, performance audit, package smoke, terminal matrix. |

## Release checklist

- `npm ci` and `npm run check` pass from a clean checkout.
- Packed contents include only declared runtime files, docs, themes, and licenses.
- `pi -e` package smoke starts and shuts down cleanly; install/update/remove paths are tested.
- Peer dependency range matches tested Pi versions.
- Changelog lists compatibility-sensitive changes; docs no longer describe shipped behavior as planned.
- No unresolved blocking diagnostic exists for edited files.

## Testing requirements

- **TEST-007:** tests never depend on external reference repositories at runtime.
- **TEST-008:** renderer tests exercise width extremes and missing data.
- **TEST-009:** compatibility tests prove disposal identity safety.
- **TEST-010:** manual terminal claims record reproducible environment details.
- **TEST-011:** a phase cannot be marked complete with failing required gates.

## Roadmap coverage

- Harness/scaffold: Phase 0.
- Expanded continuously through Phases 1–6.
- Full release proof: Phase 7.
- Requirement IDs: `TEST-001` through `TEST-011`.
