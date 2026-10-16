# Editor and input zone

> Status: **Implemented — Phase 3 complete**

## Purpose

The editor provides the strongest compact visual identity in pi-style while retaining Pi input semantics. It is a lightweight `CustomEditor` treatment — not a shell mode, history manager, fixed zone, or private autocomplete renderer.

## Ownership and installation

Installed through `ctx.ui.setEditorComponent()` in interactive TUI mode only. It extends Pi's `CustomEditor` so app keybindings, abort, exit, model cycling, text editing, paste, and IME behavior remain native. Before installation pi-style records any previous editor factory and follows the composition policy in `LIFECYCLE-AND-COMPOSITION.md` and `COMPATIBILITY.md`.

## Styles

Code-defined layouts selected by configuration; users may override colors/glyphs but cannot provide arbitrary renderer code.

### `compact`

```text
  ❯ prompt text
────────────────────────────────────────────────────────
 model/context metadata only when owned by editor preset
```

1-cell horizontal padding, strong prompt glyph, one subtle divider, optional compact metadata row, no trailing blank row.

### `boxed`

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ❯ prompt text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  model  ·  ctx 42%  ·  branch main
```

2-cell padding where width permits, strong top/bottom or host border, metadata and optional runtime row, collapses to compact at narrow widths.

### `dock` (default)

```text
╭─ ❯ prompt text ──────────────────────────────────────╮
│ continuation / empty-hint text                       │
╰──────────────────────────────────────────────────────╯
```

Rounded box with vertical side borders — the default editor frame (`dock` style + `rounded` frame). Compact prompt gap, one owned status row, no attempt to become a fixed terminal zone. Side borders reserve two columns; the cursor marker stays inside the box (the TUI derives the cursor column from the rendered prefix, so the hardware cursor lands after the `│ ` border). Body rows are rendered at `width − 2` and wrapped in the session-selected border color (or the theme's primary `accent` color). The autocomplete dropdown is re-framed inside the same box. Falls back to `compact` bars below 40 columns and native below 20.

### `outline` frame

```text
┌─ ❯ prompt text ──────────────────────────────────────┐
└─ think:high · ctx 42% ───────────────────────────────┘
```

Square-corner box without side borders — the pre-rounded default, still available via `frame: "outline"` for backward compatibility.

### `native`

Native-looking Pi editor output with minimal decoration; both a user preference and the compatibility fallback.

## Frame modes

`auto` (choose by style/width/color capability), `halfblock`, `line`, `solid`, `outline`, `rounded`, `native`. Unknown or unsupported modes fall back to the style default. `rounded` renders the rounded box with side borders (see above); `outline` keeps the square-corner box without side borders.

## Empty-input hint

`editor.hint` renders a dim placeholder after the prompt while the input is empty (e.g. `"Ask Pi anything"`). The hint is drawn after the cursor cell, so typing replaces the input position exactly; the first keystroke makes the text non-empty and the hint disappears. Color comes from the semantic `hint` token (`theme.colors.hint`, default muted gray) so it stays a soft hint rather than body text. No hint is drawn while autocomplete is open (text is non-empty there) or at narrow widths where the row would overflow.

## Prompt and continuation alignment

Default prompt `❯`; Unicode/ASCII fallback `>`.

- prompt width is measured, never assumed to be one cell;
- multiline continuation indent aligns with text after the prompt and gap;
- cursor marker stays in the correct rendered position;
- wrapping accounts for panel padding, borders, prompt, and continuation prefix;
- editable input is wrapped, never truncated;
- very narrow width removes optional frame/padding before harming input usability.

## Bash mode (`!` prefix)

Pi treats an input starting with `!` as a direct bash command and switches the editor border to the `bashMode` color. pi-style makes that mode visible in the input itself:

```text
╭─ $ echo "zz" ─────────────────────────────────────────────╮
│  continuation / cursor                                    │
╰──────────────────────────────────────────────────────────╯
```

- Prompt glyph becomes `$` on every terminal; `theme.glyphs.bashPrompt` remains a user-controlled override, colored with the live bash border color.
- The leading `!` (and the `!!` context-exclusion run) is hidden from the display; the cursor stays correctly aligned (the hardware-cursor marker rides along). A cursor sitting on a hidden `!` keeps the native cursor block.
- Emptying the input returns to the normal `❯` prompt; the frame keeps the selected session color (or the theme's primary `accent` color).
- A bare bang submit (`!` / `!!` with no command after it) is dropped instead of being sent to the agent as a literal message: Pi's submit path already cleared the editor, so the input just returns to the normal prompt. Real bash commands (`!echo hi`) and non-interactive input sources are never touched.
- Display-only: the real editor text keeps the `!` prefix, so submit/history/undo and Pi's execution path are untouched.

## Input behavior

- Unhandled keys call `super.handleInput(data)`.
- No Bash mode, prompt stash, shell history, directory jumps, or custom navigation shortcuts.
- Paste and IME behavior inherited from Pi.
- Focus/cursor follows the TUI `Focusable` contract.
- Render decoration never modifies the editor's underlying text state.

## Autocomplete

The editor preserves the built-in slash/path autocomplete provider through normal `CustomEditor` construction; a prior editor's custom provider is preserved when a supported composition path exists. pi-style does not access private autocomplete list/state merely to restyle it — a future autocomplete treatment is a separate compatibility-gated requirement.

## Metadata rows

Available: model/provider, thinking level, context percentage/window, project/path, Git summary, extension statuses, and response speed or session usage when reliably provided. The preset resolves which values the editor owns; the default status-focused preset avoids duplicating model/path/Git text between editor and status line.

## Thinking and working state

Thinking level does not recolor the decorated editor frame. Use Pi's `/name` or `--name` to set the session title displayed as a solid badge on its top border. The badge uses the frame color as its background, terminal-background-colored text, and one cell of padding on each side. Use `/color #RGB`, `/color #RRGGBB`, or `pi --color '#RRGGBB'` to set a per-session frame color; `/color off` resets it to the theme's primary `accent` color. A saved `/color` setting survives resume and takes precedence over the CLI default for that session. Native editor style remains Pi-owned.

Pi's native working indicator is embedded in the editor's top border through `CustomEditor`'s `embedWorkingStatus` option. The styled renderer delegates to the protected native `renderTopBorder()` hook at the full frame width (minus two columns for rounded/outline corners), preserving indicator ANSI, native message updates, spinner-only degradation, and the `↑ N more` scroll label. Normal and autocomplete rendering retain that line; native style delegates unchanged. Idle frame glyphs remain styled as before.

Pi owns the indicator instance, animation timer, lifecycle, interrupt handling, and disposal. pi-style neither reads the private indicator field nor creates a second loader/timer; animated border output is never cached. Older hosts without the border hook retain the idle styled frame and Pi's standalone status above the editor.

## Width behavior

Degradation order: remove optional metadata → abbreviate labels/values → reduce horizontal padding → replace outline/box with a single divider → hide metadata row → native/minimal frame while preserving prompt and editable text. No style reserves more rows than it renders.

## Theming

Consumes semantic tokens from `THEMING.md`: prompt/input text, background/frame, metadata label/value, primary accent border, active/working state. Pre-baked strings are rebuilt after theme invalidation.

## Existing editor conflict

| Situation | Behavior |
| --- | --- |
| No previous custom editor | Install pi-style. |
| Previous editor safely composable | Preserve supported provider behavior. |
| Not composable, `preferExistingEditor: true` | Keep prior editor; disable pi-style editor only. |
| User explicitly forces pi-style | Replace and report the decision. |
| Shutdown | Restore previous owner only if pi-style still owns the slot. |

Any constructor/render capability mismatch falls back to the previous/native editor before removing other pi-style features; the user is never left without a usable input component.

## Requirements

- **EDIT-001:** extend `CustomEditor` and preserve native app keybindings.
- **EDIT-002:** support compact, boxed, dock, and native styles.
- **EDIT-003:** multiline prompt, wrapping, continuation, and cursor alignment are width-correct.
- **EDIT-004:** session color overrides the primary accent editor frame; thinking level does not recolor it.
- **EDIT-005:** metadata follows preset ownership and avoids accidental duplication.
- **EDIT-006:** existing editor ownership follows documented composition settings.
- **EDIT-007:** disabling/shutdown restores a usable prior/native editor.
- **EDIT-008:** narrow widths remove decoration before harming input usability.
- **EDIT-009:** no unrelated shell/history/navigation workflow is introduced.
- **EDIT-010:** theme invalidation rebuilds themed content.
- **EDIT-011:** no private autocomplete state dependency is required for v1.

## Automated proof

- `test/unit/editor-working-indicator.test.ts` — native embedding, frame/width matrix, full-width delegation with one native render, indicator update/replacement/removal, scroll labels, real autocomplete provider and cursor-marker preservation, interrupt delegation, render-failure cleanup, and older-renderer fallback.
- `test/unit/editor.test.ts` — idle frames, prompt/input behavior, bash mode, and native render call counts.
- `test/performance/editor-rendering-bounds.test.ts` — render-plan reuse and bounded native render work.

Interactive terminal proof of host streaming/cleanup remains a manual check; the unit tests exercise the native border contract with a controllable indicator double.

## Roadmap coverage

- Implemented in: Phase 3.
- Full persistence/conflict commands: Phase 6.
- Terminal/IME/manual proof: Phase 7; manual evidence pending.
- Requirement IDs: `EDIT-001` through `EDIT-011`.
