# pi-style documentation

> Status: **Phase 7 verified** — the full v1 phase sequence (Phases 0–7) has been verified. Terminal-global background synchronization remains unsupported/off for technical v1.

pi-style is a cohesive Pi UI package: it preserves Pi's native ownership of the feed, selection, editor, and terminal layout while adding a compact, responsive visual system across the startup view, status line, editor, messages, and tool presentation.

The target is a complete, maintainable UI plugin—not a single screen, a standalone theme, or a wholesale fork of any external project. The implementation is delivered incrementally, but all phases through the v1 release gate are part of the intended product.

## Documentation map

| Document | Purpose |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | Product goals, full v1 scope, non-goals, UX principles, and supported surfaces. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layered source layout, dependency rules, runtime model, rendering constraints, and failure boundaries. |
| [CONFIGURATION.md](CONFIGURATION.md) | Configuration schema, precedence, persistence, commands, defaults, and migration policy. |
| [LIFECYCLE-AND-COMPOSITION.md](LIFECYCLE-AND-COMPOSITION.md) | Session lifecycle, UI installation, editor/footer composition, render scheduling, and cleanup. |
| [COMPATIBILITY.md](COMPATIBILITY.md) | Pi API compatibility tiers, patch policy, extension coexistence, terminals, ANSI, and fallback behavior. |
| [TESTING.md](TESTING.md) | Automated proof, render contracts, performance checks, terminal validation, and release gates. |
| [ui/README.md](ui/README.md) | UI surface map and shared rendering rules. |
| [ui/STATUS-LINE.md](ui/STATUS-LINE.md) | Status segments, presets, providers, layout, responsiveness, and live updates. |
| [ui/EDITOR.md](ui/EDITOR.md) | Compact/boxed/dock editor styles, composition, metadata, alignment, and fallback behavior. |
| [ui/STARTUP.md](ui/STARTUP.md) | Compact startup/header presentation and optional overlay behavior. |
| [ui/MESSAGES-AND-TOOLS.md](ui/MESSAGES-AND-TOOLS.md) | Message prefixes, special blocks, tool badges, tool results, and compatibility constraints. |
| [ui/THEMING.md](ui/THEMING.md) | Semantic colors, glyphs, style presets, Unicode/ASCII glyph modes, backgrounds, and accessibility. |
| [decisions/README.md](decisions/README.md) | Accepted architecture decision records. |
| [../ROADMAP.md](../ROADMAP.md) | Phased implementation plan, dependencies, milestones, and exit criteria. |

## Source-of-truth hierarchy

When documents disagree, use this order:

1. The latest explicit user requirement.
2. `PRODUCT.md` for scope and user-facing behavior.
3. The owning file under `docs/ui/` for a UI surface contract.
4. `ARCHITECTURE.md`, `CONFIGURATION.md`, and accepted decision records for implementation constraints.
5. `ROADMAP.md` for sequencing—not for weakening the product contract.
6. Tests and implementation once they exist.

## Document status terms

- **Planned** — accepted intended behavior, not implemented.
- **In progress** — implementation work is active.
- **Implemented** — code and executable proof exist.
- **Deferred** — valid idea intentionally outside the current release sequence.
- **Rejected** — intentionally not part of pi-style.
- **Experimental** — available only behind explicit opt-in and without the normal compatibility guarantee.

Each implementation PR should update affected documents from `Planned` to `In progress` or `Implemented` only when the matching acceptance criteria are actually proven.

## Requirement identifiers

Requirements use stable prefixes so tests and roadmap items can refer to contracts without copying prose:

| Prefix | Area |
| --- | --- |
| `PROD-*` | Product-wide behavior |
| `ARCH-*` | Architecture invariants |
| `CFG-*` | Configuration |
| `LIFE-*` | Lifecycle and composition |
| `STAT-*` | Status line |
| `EDIT-*` | Editor |
| `START-*` | Startup UI |
| `MSG-*` | User/assistant/special messages |
| `TOOL-*` | Tool call/result presentation |
| `THEME-*` | Theme, glyph, ANSI, and accessibility |
| `COMPAT-*` | Compatibility and fallback |
| `TEST-*` | Validation and release proof |

## Recommended reading paths

### Implementing the package skeleton

Read `PRODUCT.md` → `ARCHITECTURE.md` → decision records → `TESTING.md` → Phase 0 in `ROADMAP.md`. Phase 0 foundation is complete; begin new work from the current phase in `ROADMAP.md`.

### Implementing the status line

Read `ui/STATUS-LINE.md` → `ui/THEMING.md` → `LIFECYCLE-AND-COMPOSITION.md` → `CONFIGURATION.md` → Phase 2.

### Implementing the editor

Read `ui/EDITOR.md` → `COMPATIBILITY.md` → `ui/THEMING.md` → `LIFECYCLE-AND-COMPOSITION.md` → Phase 3.

### Implementing message or tool styling

Read `ui/MESSAGES-AND-TOOLS.md` → `COMPATIBILITY.md` → ADR 0004 → Phase 5. These surfaces have a higher compatibility burden than widgets and editors.

### Changing product scope

Update `PRODUCT.md`, the owning UI contract, the roadmap, and—when architecture changes—add or supersede an ADR.

## Documentation change protocol

A change is incomplete if it changes behavior without updating the corresponding contract:

- new config field → `CONFIGURATION.md`, defaults, normalization, persistence, and tests;
- new UI surface → `PRODUCT.md`, `ui/README.md`, a dedicated contract, roadmap phase, and tests;
- new Pi-internal patch → `COMPATIBILITY.md`, ADR 0004 compliance, disposal tests, and version/capability gates;
- new visual token → `ui/THEMING.md`, theme fallback, no-color behavior, and render tests;
- changed phase sequencing → `ROADMAP.md`, without silently reducing the full product target.
