# Product contract

> Status: **Implemented — Phase 7 verified**

## Product statement

pi-style is a cohesive UI package for the Pi coding agent. It preserves Pi's native ownership of the conversation feed, scrolling, selection, editor placement, and terminal lifecycle while adding a compact, responsive visual system across the startup view, status line, editor, messages, and tool presentation.

Its information architecture uses native Pi layout with a responsive, segment-based status line; its visual density, framing, prompts, badges, and message hierarchy form one compact, structured visual language shared across all surfaces.

## Product goals

- **PROD-001 — Native layout first.** Pi remains responsible for feed scrolling, selection, resize behavior, and editor positioning.
- **PROD-002 — Cohesive visual identity.** All supported UI surfaces use one semantic theme and spacing system.
- **PROD-003 — Information without noise.** Model, thinking level, path, Git, context, usage, and extension status are shown according to priority and available width.
- **PROD-004 — Live state.** Model, thinking level, context, Git, streaming, and tool state update without requiring a session restart.
- **PROD-005 — Responsive behavior.** Narrow terminals degrade by collapsing, moving, abbreviating, or hiding optional information; they must not emit over-width lines.
- **PROD-006 — Safe defaults.** Font, glyph, color, placement, and compatibility choices work without mandatory user configuration.
- **PROD-007 — User control.** Users can select presets, placement, editor style, individual surfaces, glyph mode, and compatibility policy.
- **PROD-008 — Extension coexistence.** pi-style preserves prior editor/autocomplete behavior when possible and disables only conflicting surfaces when composition is impossible.
- **PROD-009 — Maintainability.** Rendering is bounded and testable; compatibility-sensitive patches are isolated, reversible, and version/capability gated.
- **PROD-010 — Full product by phases.** Incremental delivery is a sequencing strategy. The intended v1 includes all roadmap phases through hardening and release.

## Feature set by surface

| Surface | Delivered behavior |
| --- | --- |
| Status line | Native Pi widgets above/below the editor; segment registry and named presets; model, live thinking, path, Git, context, usage, cache, cost, time; extension statuses and custom items; responsive primary/secondary rows; Unicode by default; ASCII accessibility preset. |
| Editor | Compact/boxed/dock/native `CustomEditor` treatments preserving Pi keybindings; prompt glyph and continuation alignment; thinking-level border; optional metadata rows fed by the shared status snapshot; previous-editor composition. |
| Startup | Compact tri-color logo header by default; optional overlay with System & Context / Available Tools panels; quiet/off modes; snapshot-only rendering; width-safe dismissal and timeout. |
| Messages | Assistant prefix; thinking and tool-only assistant states; boxed compaction/skill/branch/custom (MCP) blocks; native rich content preserved. |
| Tools | Compact boxed call/result presentation for built-in tools with pending/running/error markers; elapsed metrics; native expansion/truncation/diff preserved; completed turns collapse into a single summary line with global Ctrl+O expand (ADR 0007). |
| Theme | Shared semantic resolver over the active Pi theme; Unicode default and ASCII glyph modes; `NO_COLOR` and ANSI-safe output; explicit overrides. |
| Operations | Global/project settings, `/pi-style` commands, reload-safe lifecycle, `/pi-style doctor` diagnostics, automated unit/integration/render/performance tests. |

## User experience principles

1. **Native behavior before decoration.** A styled screen that breaks selection, scrolling, autocomplete, or keybindings is a product failure.
2. **Compact, not cryptic.** Short labels (`think:high`, `ctx:42%`) are acceptable when stable; ambiguous glyph-only output is not.
3. **Hierarchy before color.** Spacing, grouping, framing, and placement must communicate structure in no-color mode.
4. **No accidental duplication.** Presets choose one primary owner per datum; the default must not show the same text twice.
5. **Graceful degradation.** Missing Git data, unsupported terminals, unknown component shapes, or extension conflicts disable one surface—never crash Pi or corrupt the terminal.
6. **Predictable configuration.** Defaults, global, project, env, and session commands use one documented precedence ladder; invalid values normalize safely.

## Supported UI surfaces

| Surface | Default v1 ownership | Compatibility level |
| --- | --- | --- |
| Header/startup | Pi public header/overlay APIs | Public API |
| Primary/secondary status rows | Named Pi widgets | Public API |
| Footer data | Native footer or minimal data bridge only when necessary | Public API, composition constraints |
| Editor | `CustomEditor` through Pi UI API | Public API; singleton conflict possible |
| Working indicator | `setWorkingIndicator()` | Public API |
| User/assistant messages | Optional renderer patch/adapter | Compatibility-gated |
| Special message blocks | Optional component patch/adapter | Compatibility-gated |
| Built-in tools | Renderer registration or isolated patch | Compatibility-gated |
| Terminal background | Explicit cell painting; optional OSC 11 | Platform-gated |

## Scope boundaries

**Pi owns:** conversation storage/branching, feed scrolling and resize, selection and clipboard, model execution, core editor semantics and keybindings, the canonical theme/settings system, and built-in tool execution.

**pi-style owns:** visual presets and semantic style resolution; UI snapshots and caches; segment selection/ordering/responsive layout; the optional editor render treatment; UI installation, scheduling, cleanup, and diagnostics; compatibility fallback for surfaces it modifies.

**Other extensions own:** their tool semantics and session state; their extension-status text; their own editors/footers/renderers when explicitly preferred; productivity workflows unrelated to styling.

## Explicit non-goals for v1

- persistent shell/Bash mode;
- prompt stash and shell history management;
- `/cd` or directory-jump ownership;
- AI-generated working messages ("vibes");
- fixed terminal scroll-region compositor;
- custom selection/copy inside a fixed zone;
- chat virtualization;
- physical terminal-buffer self-healing;
- reimplementation of Pi's session browser or multiplexer.

Fixed-zone compositor ideas may be researched after v1 only through a new ADR and explicit product approval.

## v1 completion definition

The product is ready for v1 only when:

1. all roadmap phases through Phase 7 satisfy their exit criteria;
2. all accepted requirement IDs are implemented or explicitly superseded/rejected by an ADR;
3. public API surfaces work without compatibility patches;
4. compatibility-sensitive surfaces degrade independently with disposal tests;
5. width, no-color, ASCII, and terminal-matrix checks are recorded;
6. install, reload, disable, session switching, and shutdown are proven;
7. documentation describes actual behavior rather than planned behavior.

## Roadmap coverage

- Introduced: Phase 0.
- Completed by: Phase 7.
- Requirement IDs: `PROD-001` through `PROD-010`.
- Blocking decisions: ADR 0001–0004.
