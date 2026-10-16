# Architecture

> Status: **Phase 7 verified**

## Goals

The architecture must support a richer product than the initial status-line slice without reproducing a monolithic single-entry structure. It keeps Pi-specific integration thin, makes render logic testable, isolates compatibility patches, and allows each UI surface to fail or be disabled independently.

## Repository structure

```text
extension-src/pi-style/
├── shared/     ANSI/width, box, elapsed, split-diff, render-budget, theme-extras, disposable-store
├── domain/     config (types, normalization, presets, migrations, authorization, diagnostics),
│               theme, status (segments, presets, renderer), providers, capabilities
├── features/   status-line, editor, startup (index, logo), messages (index, boxed-block,
│               special-blocks), tools (index, boxed/*)
├── app/        index (app factory), runtime, snapshot, render-scheduler, providers,
│               command-service, commands, config-storage, doctor, config-diff
└── pi/         index (extension factory), session-coordinator, compatibility-probe,
                compatibility-registry, compatibility-coordinator, config-host, config-session,
                operational-state, commands, session-usage, startup-resources
```

Themes live under `themes/`, tests under `test/{unit,render,integration,performance,e2e,helpers}`, and the ESM bundle compiles to `dist/extensions/pi-style.js`.

## Layer model

```text
shared → domain → features → app → pi
```

| Layer | Responsibility |
| --- | --- |
| `shared/` | Host-independent primitives (ANSI-safe width, boxes, metrics, diff, disposal). No product policy; may import Node/external utilities but never Pi extension types or higher layers. |
| `domain/` | Pure contracts and calculations: normalized config, presets, migrations, theme resolution, status segments/renderer, provider interfaces, capability descriptions. Deterministic and testable without a TUI or filesystem. |
| `features/` | One folder per user-visible surface: converts domain snapshots into Pi TUI components, exposes installers returning disposable handles, owns feature-local caches. Never imports sibling features. |
| `app/` | Composition and runtime: loads/normalizes config, owns session generation and runtime state, builds snapshots, starts providers, schedules renders, composes installers, owns the disposable store. |
| `pi/` | The only layer aware of the concrete Pi lifecycle: default extension factory, event/command/flag registration, capability detection, singleton install/restore, compatibility patches. `pi/index.ts` stays thin. |

## Dependency rules

- **ARCH-001:** Dependencies flow only from left to right in the layer diagram.
- **ARCH-002:** `shared/` never imports `domain/`, `features/`, `app/`, or `pi/`.
- **ARCH-003:** `domain/` never imports Pi packages or feature modules.
- **ARCH-004:** Feature modules never import sibling feature modules.
- **ARCH-005:** `app/` is the only layer that coordinates multiple features.
- **ARCH-006:** Direct Pi API access is restricted to `pi/`, except Pi TUI component types needed by a renderer implementation.
- **ARCH-007:** Compatibility patches live behind `pi/compatibility-*` and feature-specific adapters, not in domain code.
- **ARCH-008:** Dependency-cruiser enforces the above rules in CI.

## Runtime composition

A session runtime holds explicit state rather than closure-spread mutable variables:

```ts
interface PiStyleRuntime {
  generation: number;
  config: NormalizedPiStyleConfig;
  capabilities: PiStyleCapabilities;
  snapshot: UiSnapshot;
  scheduler: RenderScheduler;
  disposables: DisposableStore;
  providers: RuntimeProviders;
  installations: FeatureInstallations;
}
```

### Providers

Providers isolate expensive or host-specific work: active model/thinking level, context usage, footer branch and extension statuses, Git refresh, session usage aggregation, project/settings information, and terminal/font capabilities. Features consume provider results or immutable snapshots; they never execute Git, parse settings, or scan sessions during render.

## Render data flow

```text
Pi events / provider refreshes
        ↓
mutable runtime state
        ↓
immutable UiSnapshot
        ↓
pure feature layout and formatting
        ↓
Pi TUI component render(width)
```

A `UiSnapshot` contains only render-ready values or cheap derived primitives and is safe to read repeatedly from synchronous render methods.

## Render-path invariants

- **ARCH-009:** `render(width)` performs no filesystem access.
- **ARCH-010:** `render(width)` starts no process and performs no network access.
- **ARCH-011:** `render(width)` does not rescan the full session branch.
- **ARCH-012:** every emitted line has visible width ≤ `width`.
- **ARCH-013:** cache keys include every state that affects output: width, theme generation, glyph mode, and relevant snapshot revision.
- **ARCH-014:** `invalidate()` clears themed/render caches and never performs expensive discovery.
- **ARCH-015:** streaming refreshes are bounded and coalesced.

## Background provider model

**Git** — cwd/project-keyed cache with bounded refresh interval, one in-flight refresh per key, stale-while-refresh, explicit invalidation after `write`/`edit` and branch-changing shell commands, timeouts, error backoff, and disposal on shutdown.

**Session usage** — caches the last processed branch identity/length or a stable revision; updates incrementally and never sums the whole branch per frame.

**Theme discovery** — the active Pi theme is primary; optional pi-style theme-extra discovery happens outside render and fails softly.

## Feature installation contract

Every installer returns a disposable and must be: idempotent for the same runtime, safe after a failed previous attempt, reversible when it owns a singleton surface, explicit about replaced/wrapped owners, and able to report a disabled-fallback reason to diagnostics.

## Snapshot ownership and metadata deduplication

The app layer builds one `UiSnapshot` shared by status, editor, and startup. Each preset resolves a metadata ownership map (e.g. `model → status line`, `thinking → status line + editor border`, `path → status line`, `context → editor metadata row`) so features do not derive the same values independently and no datum is duplicated.

## Scheduling

A shared render scheduler supports immediate updates (thinking/model selection), coalesced updates (streaming usage), delayed refresh (after Git-changing commands), typing deferral (noncritical status), and cancellation with generation checks on shutdown. It never retains stale `ExtensionContext` objects across session replacement.

## Compatibility isolation

Public Pi APIs are used directly. Reflective/internal access is isolated behind capability adapters. Prototype or built-in renderer patches must be feature-scoped, record the original identity, avoid duplicate wrapping, restore only while pi-style still owns the wrapper, catch shape mismatches, and report their tier to `/pi-style doctor`. See `COMPATIBILITY.md` and ADR 0004.

## Build and package architecture

- strict TypeScript, ESM source, tsup build;
- Pi extension entry at `extension-src/pi-style/pi/index.ts` — loaded through Pi's jiti loader so `@earendil-works/*` resolve to the runtime instances; the ESM bundle under `dist/extensions/pi-style.js` is a compile check;
- Pi core packages are peer dependencies and externals;
- optional theme resources ship under `themes/`;
- no public library entry: reusable pure contracts are not yet externally consumed.

## Error boundaries and degradation

A feature failure must not tear down unrelated surfaces:

| Failure | Required behavior |
| --- | --- |
| Invalid config | Normalize field to default and record a bounded warning. |
| Git command failure | Hide/stale Git segment; keep status line alive. |
| Editor conflict | Keep native/prior editor and continue other features. |
| Message patch mismatch | Disable message styling only. |
| Tool renderer conflict | Preserve existing/native renderer. |
| Theme-extra discovery failure | Use active Pi theme and built-in fallback. |
| Terminal glyph support | Use Unicode by default; ASCII preset is available. |
| Stale session callback | Ignore through generation check. |

## Roadmap coverage

- Introduced: Phase 0.
- Completed by: Phase 7.
- Requirement IDs: `ARCH-001` through `ARCH-015`.
- Blocking decisions: ADR 0001, 0002, and 0004.
