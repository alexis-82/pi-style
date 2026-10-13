# Theming and visual system

> Status: **Implemented — shared semantic theme consumed by status, editor, startup, messages, and tools**

## Goals

All pi-style surfaces consume one semantic visual system. Layout presets decide structure; themes decide colors and glyph values. This prevents each surface from becoming a separate skin.

## Resolution hierarchy

```text
explicit piStyle theme overrides
  → optional pi-style extras from active theme metadata
  → active Pi semantic theme tokens
  → built-in pi-style safe defaults
```

A missing optional source must never block startup.

## Semantic tokens

Tokens are grouped by meaning, not component implementation. Implementations may reduce the list where Pi already exposes an exact semantic token; new tokens require docs, defaults, no-color behavior, and tests.

| Group | Tokens |
| --- | --- |
| Core | `surface`, `surfaceRaised`, `surfaceMuted`, `text`, `muted`, `dim`, `accent`, `accentStrong`, `border`, `borderMuted`, `borderActive`, `success`, `warning`, `error` |
| Status data | `model`, `thinking`, `path`, `gitClean`, `gitDirty`, `contextLow`, `contextMedium`, `contextHigh`, `contextCritical`, `tokens`, `cache`, `cost`, `time`, `separator` |
| Editor | `editorPrompt`, `editorText`, `editorBackground`, `editorBorder`, `editorBorderActive`, `editorMetadataLabel`, `editorMetadataValue`, `hint`; thinking levels map to Pi's `thinkingOff`–`thinkingMax` tokens |
| Messages/tools | `assistantPrefix`, `thinkingText`, `messageBorder`, `messageBackground`, `toolTitle`, `toolOutput`, `toolPending`, `toolSuccess`, `toolError`; diff colors defer to Pi's diff tokens |

## Style presets versus themes

- A **style preset** defines surface enablement, spacing/padding, status segment groups, editor layout/frame, message/tool density, and startup mode.
- A **theme** defines color values, glyphs, separators, and background behavior.

Users combine a style preset with any compatible Pi theme. The `theme.autoApply` leaf (default `"titanium"`) switches the active Pi theme at TUI session start when no other theme is active, resolving the target before switching so an unresolvable name never reaches Pi (its `setTheme` would fall back to the dark theme on load error). Setting `theme.autoApply: "off"` (or the `native` preset, or `PI_STYLE_THEME=off`) keeps the user's active theme untouched; the value may use Pi's `light/dark` auto syntax, e.g. `"titanium-light/titanium"`.

## Active Pi theme integration

Components use the theme object provided by Pi callbacks — never a global theme singleton. The resolver maps pi-style semantics onto Pi tokens (`accent`, `text`, `muted`, `dim`, borders, `success`/`warning`/`error`, tool/message/markdown tokens, thinking-level tokens). Theme invalidation must clear strings containing pre-baked ANSI codes.

## Glyph sets

| Set | Content |
| --- | --- |
| Nerd | Segment separators and private-use icons for Pi, model, folder, branch, context, cache, time, agents. |
| Unicode-safe | Common Unicode: `π`, `⎇`, `·`, `│`, `◫`, and text labels where symbol support is uncertain. |
| ASCII | Plain labels/separators: `pi`, `git`, `ctx`, `|`, `>`, `<`. |

No essential meaning may exist only in a private-use glyph.

## Nerd Font detection

Conservative order: explicit `PI_STYLE_NERD_FONTS=1|0` → explicit config `on|off` → strong signals like `GHOSTTY_RESOURCES_DIR` → case-insensitive known-terminal heuristic → Unicode/ASCII fallback. The doctor command explains why a mode was selected; auto-detection never claims certainty about the configured font.

## ANSI and width

- All width calculations use Pi TUI's `visibleWidth()` or an equivalent tested wrapper; truncation uses ANSI-aware helpers.
- Multi-line styled output reapplies style per line; each line is self-contained and ends safely.
- Background/foreground state never leaks into adjacent Pi content.

## Background rendering

Paint backgrounds only across cells owned by the component; never assume the terminal default background matches a chosen theme. When a box/background extends to the component width, padding is included in width calculations and ANSI reset behavior.

### Compaction card background

The Compaction fill is a neutral message surface, never a tool status token: it comes from Pi's `userMessageBg` token. The extension also honors an optional `extras.compactionBgColor` override (hex or theme variable/color reference) when the active theme file provides one; missing/invalid values fall back to `userMessageBg`. The bundled themes carry no `extras`: Pi's theme schema (enforced at startup since 1.2.0) sets `additionalProperties: false` and rejects unknown top-level keys. Their `userMessageBg` values — `darkTitanium` (`#0f1216`) in titanium, `userMsgBg` (`#e8e8e8`) in titanium-light — match the fills previously set through extras. Resolution is cached outside render; truecolor and 256-color terminals are supported. Themes without background styling retain the card layout without a fill. Other special blocks keep their native `customMessageBg`.

## Terminal-global background synchronization

Unsupported/off for technical v1: production emits no OSC 10/11/111, performs no terminal query or polling, installs no terminal-background widget, and claims no terminal-global ownership. Explicit cell backgrounds and Pi theme APIs remain supported; physical terminal/platform/color synchronization stays unclaimed unless mandatory platform evidence requires a future decision.

## `NO_COLOR`

Foreground/background colors are removed; labels, prefixes, borders, and state text remain; selected/active state uses glyph/text differences; errors retain words or symbols such as `error`, `!`, or `x`; no contrast assumption is required.

## Contrast and accessibility

- Critical state is never indicated only by red/green.
- Context thresholds include a number/label, not color alone.
- Pending/success/error tools have distinct symbols/text.
- Dim text is not used for essential prompt/input content.
- Configurable glyph overrides support terminals with width/rendering issues.

## Theme resources

Optional complete Pi themes ship under `themes/` (`titanium.json`, `titanium-light.json`) and are auto-applied through `theme.autoApply`; the extension still works with any active theme through semantic mapping when auto-apply is off. Both stay within Pi's theme schema (`https://pi.dev/schemas/theme.schema.json`) — `name`, `vars`, `colors`, `export`, no `extras` — so they load on runtimes that validate theme JSON at startup and reject unknown top-level keys.

## Theme requirements

- **THEME-001:** all surfaces use the shared resolver.
- **THEME-002:** theme change invalidates pre-baked styled caches.
- **THEME-003:** essential meaning survives no-color and ASCII modes.
- **THEME-004:** auto font detection has an explicit override.
- **THEME-005:** every rendered line is ANSI-contained.
- **THEME-006:** terminal-global background synchronization is unsupported/off for technical v1; explicit cell backgrounds and Pi theme APIs remain supported.
- **THEME-007:** invalid user overrides fall back safely.
- **THEME-008:** style presets and color themes remain separate concepts.

## Roadmap coverage

- Resolver/glyph/ANSI foundation: Phase 1A.
- Feature consumption: Phases 2–5.
- Full overrides/themes/accessibility/platform proof: Phases 6–7.
- Requirement IDs: `THEME-001` through `THEME-008`.
