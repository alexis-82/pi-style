# Startup presentation

> Status: **Implemented — Phase 4 complete**

## Purpose

The startup surface introduces the pi-style visual identity and summarizes the active environment without delaying entry into the editor. It uses Pi's public header and overlay APIs, with a namespaced widget fallback when the header API is unavailable.

## Modes

### `compact` (default)

Rendered through Pi's public `setHeader` API above the chat and editor; when unavailable, the namespaced widget (`pi-style.startup`, `aboveEditor`) is used. An injected `getHeaderFactory` ownership adapter, when present, guards against overwriting a later header owner; without it the public header API is used directly.

The compact presentation is the tri-color logo block only:

1. **Tri-color logo header** — eight-line block-art Pi logo with fixed brand colors: coral (`#f09082`) for the cap and dot, blue (`#509bb9`) for the P, and gold (`#f0c055`) for the i stem. Side details show the `π <project-path>` title — the home-contracted session cwd, i.e. the repo currently being worked in (falls back to its basename, then the brand, when no cwd is known; tail-truncated with a leading `…` so the repo name survives narrow widths) — the `/ commands` and `! bash` hints (each on its own row), and `● ready` when wide enough; the logo stacks above details on narrow widths and collapses to title + status on very narrow widths. The logo colors are independent of the active theme accent; under `NO_COLOR`, the logo renders plain unless `theme.colors.colorOverride` is `on`.
2. **Resource chips** (optional, `startup.showResources`) — `◆ Resources` followed by `label count` chips for context files, extensions, skills, prompts, tools, and models (only groups with data).
3. **Panels** (`showResources` + `alwaysExpanded`) — boxed **System & Context** (`Type | Path | Words/Lines`) and **Available Tools** (`Source | Count | Tools`) tables fed by snapshot `details`/`toolDetails` fields. Panels render only at ≥72 columns so the box stays intact; rows are bounded to host-collected data.

The whole block carries a four-column left margin plus two blank rows above and below.

### `overlay`

Centered overlay through `ctx.ui.custom(..., { overlay: true })`. Visual presentation only; falls back to compact when the capability is unavailable. Responsive: hides below its minimum usable width/height. Always shows the panels (subject to the width gate) and adds an `enter prompt to continue · esc dismiss` hint.

### `off`

No header, overlay, widget, input listener, or startup timer is installed.

## Information model

Consumes model, thinking level, project/cwd, context percentage, active preset, and pre-captured resource summaries from the runtime. Resource discovery happens outside render: the pi/ layer collects system prompt text, active tool details (compact source labels), and scoped-model count at session start; the app layer converts them into bounded snapshot fields. Missing or malformed optional fields are omitted; zero values are never invented; resource errors show a bounded summary without exposing settings or secrets. Startup render performs no filesystem, process, network, session, or resource discovery.

## Session reason rules

Pi exposes `startup`, `reload`, `new`, `resume`, and `fork`. Compact is eligible for all supported reasons; the overlay is limited to the initial `startup` reason to avoid interrupting replacement sessions.

## Dismissal and lifecycle

Overlay dismissal is idempotent and triggered by terminal input, `input`, `agent_start`, tool execution start, explicit handle dismissal, or runtime disposal. The runtime generation guard prevents stale updates from mutating a replacement session. Header/widget cleanup uses namespaced ownership and restores only when the installed header factory is still the current owner. Timeout state is cancellable through the cleanup path.

## Width behavior

Every output line is measured with ANSI-aware width helpers and truncated safely; width zero returns no output. The overlay uses public responsive `visible` checks for minimum width/height; compact retains the identity line and drops optional content when narrow. The logo collapses progressively (side details → stacked → title/status); panels render only at 72+ columns, with cell widths computed from content and a final width pass guaranteeing every line fits.

## Theme and glyphs

Resolves semantic colors from the active Pi theme supplied by the public factory callback; `invalidate()` requests a fresh render rather than retaining old ANSI strings. The shared resolver provides Unicode/ASCII/no-color behavior; Unicode is the default; ASCII remains available for accessibility.

## Failure fallback

| Failure | Behavior |
| --- | --- |
| Missing header API | Compact startup widget; otherwise no startup surface. |
| Missing overlay API / overlay failure | Compact header/widget fallback. |
| Headless `print`/`json`/RPC | No terminal startup installation; status/editor remain independent. |
| Startup installation failure | Only the startup surface is disabled. |
| Header owner conflict | `getHeaderFactory` adapter preserves the prior/later owner (widget fallback or refusal); without the adapter the header is claimed directly. |

## Requirements

- **START-001:** compact startup is the default mode.
- **START-002:** overlay is optional and nonblocking.
- **START-003:** startup render performs no resource/filesystem discovery.
- **START-004:** dismissal is safe across session generations.
- **START-005:** startup reason behavior is deterministic and nonintrusive.
- **START-006:** narrow/no-color/ASCII modes remain readable.
- **START-007:** headless modes mount no custom terminal UI.
- **START-008:** startup never exposes secrets or full settings.

## Automated proof

- `test/unit/startup.test.ts` — mode behavior, missing data, no invented values, chips/panels expansion, overlay structure, widths `0, 1, 20, 40, 60, 80, 120, 160`;
- `test/unit/startup-logo.test.ts` — brand color placement, unchanged silhouette, no-color/override behavior, side/stacked/collapsed layouts, ANSI→RGB parsing;
- `test/unit/startup-resources.test.ts` — tool source labeling and active-tool filtering;
- lifecycle tests — headless installation, repeated startup/shutdown cleanup, status/editor independence.

Real Pi smoke proof: `pi --mode json --no-session -e ./extension-src/pi-style/pi/index.ts` exits successfully without terminal UI installation. Full terminal matrix proof remains manual evidence pending.

## Roadmap coverage

- Implemented in: Phase 4.
- Full command/config control: Phase 6.
- Terminal/manual proof: Phase 7; manual evidence pending.
- Requirement IDs: `START-001` through `START-008`.
