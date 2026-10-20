# @quandev104/pi-style

[![npm](https://img.shields.io/npm/v/@quandev104/pi-style)](https://www.npmjs.com/package/@quandev104/pi-style)
[![license](https://img.shields.io/npm/l/@quandev104/pi-style)](LICENSE)

> Pi extension for a cohesive, native-layout visual system across the startup view, status line, editor, messages, and tool presentation. Pi keeps ownership of the feed, scrolling, selection, and terminal layout; pi-style installs components into supported surfaces.

---

![pi-style demo](https://raw.githubusercontent.com/quanpersie2001/pi-style/refs/heads/main/assets/demo.png)

---

## Features

- **Status line** — responsive segment layout (model, thinking, path, Git, context, usage, cost, time, extension statuses) through native widgets above or below the editor.
- **Editor** — compact/boxed/dock `CustomEditor` treatments with prompt glyph, metadata rows, session name on the top border, and a session-selectable border color independent of thinking effort; preserves Pi keybindings and autocomplete.
- **Startup** — compact tri-color logo header and optional overlay with System & Context / Available Tools panels, rendered from snapshot data collected before mount.
- **Messages** — assistant prefix and inline skill badges and boxed compaction/branch/MCP special blocks, and certified tool call/result selectors with pending/running/error markers.
- **Merged run summaries** — interleaved `◈ Thought N times · Called M tools · Edit +A -R · K failures` progress rows: after a request completes, every commentary segment keeps its own row with the CUMULATIVE totals through that point (the last row carries the whole run's totals), so each summary stays attached to the text its work produced. No duplicate `➔ Read…` aggregate, no duration. Clicking any row opens/closes all run thoughts and finalized tools (including failures and edits); native Ctrl+O still expands/collapses tools. Incomplete runs stay visible (`messages.mergedTurnSummary`, `tools.collapseAfterTurn`).
- **Pi Teams companion UI** — compact `Agent` dispatch rows (adjacent spawns group into one tree), result/steer/message and task-board receipts, plus teammate completion/mailbox messages. Uses public tool renderers on Pi 1.0.4+ and the existing certified boxed dispatcher on older peers; no `pi-teams` dependency. Agent identity color, effective thinking and max-turn metadata appear only when supplied by the runtime, never inferred from an agent name or invocation override.
- **Chunk-merged reads** — a large file read through sequential truncation chunks (`read` caps at 2000 lines / 50KB, so the model continues with `offset`, one call per message) merges into ONE expanding inline line per file — `➔ Read chat.ts:525-2629 · 10 chunks · 1.2s` — instead of one line per chunk; live progress shows `done/total`, a failed chunk keeps its error visible, and the turn summary counts chunks of one file as one file (`tools.mergeChunkedReads`).
- **User-prompt image previews** — images attached to your prompt render inline **below your message** as display-only session entries (never sent to the LLM) with `#N · WxH` labels tying each image to its marker; multiple images lay out side-by-side on kitty-capable terminals (up to 3 columns, stacked fallback elsewhere), sized by `messages.previewMaxWidth` (default 30) with Pi's global Ctrl+O expanding to 60 (`messages.showImagePreviews`).
- **Clipboard image input** — the built-in `Ctrl+V` becomes a full image-paste flow with no other extension required: a sync native probe checks the clipboard at keystroke time, an `[Image #N] ` marker appears instantly in the editor (bytes attach asynchronously — no temp-file flash), backspacing right after a marker deletes it as one unit (discarding the image, image-paste semantics), and submit attaches real image attachments; raw pasted paths that bypass the editor still upgrade to `[image]` + attachment (`messages.clipboardImages`).
- **Auto theme** — the `titanium` palette is applied at TUI session start when no other theme is active (configurable via `theme.autoApply`, disable with `"off"`).
- **One visual system** — shared semantic theme, glyph modes (Unicode by default; ASCII preset), and ANSI-safe rendering across every surface.

All certified surfaces are **on by default**. The single OFF switch is:

```json
{ "compatibility": { "allowCorePatches": false } }
```

---

## Install

```bash
pi install npm:@quandev104/pi-style
```

Run a real TUI session with the extension source (development):

```bash
pi -e ./extension-src/pi-style/pi/index.ts

# Optional session title (Pi built-in) + editor-frame color (pi-style extension):
pi --name "Expand brand components" --color '#e879f9'
```

---

## Quick start

No configuration is required. The `default` preset enables:

- primary status row **below the editor** (`placement: "below"`), secondary row when it has content;
- `dock` editor (rounded input box) with metadata ownership resolved so the status line and editor do not duplicate text;
- `compact` startup header (tri-color logo block only; resource chips are opt-in);
- the `titanium` theme auto-applied at session start (`theme.autoApply`, default `"titanium"`; set `"off"` to keep your active Pi theme);
- certified message prefixes and boxed tool presentation when the runtime surface identity matches a recorded fingerprint;
- the complete image-paste flow out of the box: `Ctrl+V` → instant `[Image #N]` marker → submit → attachment + inline side-by-side preview below your message.

Override any documented leaf through global/project `piStyle` settings, environment, or session commands. Precedence:

```text
defaults < global < project < env < session override
```

Example settings file (`.pi/pi-style` or global config):

```json
{
  "piStyle": {
    "preset": "full",
    "placement": "above",
    "editor": { "style": "boxed", "frame": "line" },
    "startup": { "mode": "overlay", "showResources": true },
    "theme": { "autoApply": "titanium-light" }
  }
}
```

Invalid values never break startup: they fall back safely and appear in `/pi-style doctor` diagnostics.

---

## Presets

| Preset | Behavior |
|---|---|
| `default` | Balanced status line, rounded-box editor, compact startup, restrained message/tool styling. |
| `minimal` | Path/Git/context essentials, native-like editor, no startup overlay, low decoration. |
| `compact` | High information density for medium terminals. |
| `full` | Broad status data and all compatible visual surfaces. |
| `ascii` | ASCII labels and separators for accessibility. |
| `native` | Active Pi theme kept as-is (`theme.autoApply: "off"`) plus only low-risk status enhancements. |

---

## Configuration

The full schema, precedence, persistence, and migration policy live in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md). Summary:

### Environment variables

| Variable | Description |
|---|---|
| `PI_STYLE_DISABLED=1` | Disable all surfaces for emergency recovery. |
| `PI_STYLE_NERD_FONTS=1\|0` | Legacy compatibility setting; accepted but ignored for rendering. |
| `PI_STYLE_EDITOR=native\|compact\|boxed\|dock` | Temporary editor override. |
| `PI_STYLE_STATUS=above\|below\|off` | Temporary status placement/state. |
| `PI_STYLE_OSC11=1\|0` | Force terminal background sync policy. |
| `PI_STYLE_THEME=<name\|off>` | Override the auto-applied theme (`off` keeps the active Pi theme). |
| `PI_STYLE_DEBUG=1` | Enable bounded diagnostics. |

### CLI flags

Disable pi-style for one process only (nothing is persisted):

```bash
pi --disable-pi-style
```

This registers only the disable flag and skips all pi-style mutations, core patches, tools, commands, and hooks. Omit it on the next launch for normal behavior. There are no aliases, environment variables, host detection, or persistent settings for this flag. Like Pi boolean flags, any `=value` form (even `--disable-pi-style=false`) counts as presence. Put it before a standalone `--`; arguments after `--` are not flags.

Package themes are still discovered by Pi independently of extension activation. The extension must be loaded to register the flag: do not combine it with `--no-extensions` (or otherwise exclude pi-style), which leaves the flag unrecognized.

Tier C surfaces are immutable session authorizations, not persisted config:

```bash
--pi-style-core-patches
--pi-style-message-assistant
--pi-style-message-special-blocks
--pi-style-tools
--pi-style-readonly-tools
--pi-style-ascii
```

In `PI_TEAMS_CHILD=1` sessions, automatic read-only-tool activation is skipped so the parent-pinned tool set stays authoritative. Editor, footer and other authorized presentation surfaces still load normally.

---

## Commands

| Command | Description |
|---|---|
| `/pi-style` | Show active preset, surfaces, placement, glyph mode, and compatibility summary. |
| `/pi-style on\|off` | Toggle the package for the current session or selected persistence scope. |
| `/pi-style preset <name>` | Apply a named preset. |
| `/pi-style placement above\|below` | Move the primary status row. |
| `/pi-style editor <style> [frame]` | Select compact, boxed, dock, or native editor. |
| `/color #RGB\|#RRGGBB\|off` | Set or reset this session's editor border color; `/color` shows it. |
| `/name <title>` | Set Pi's session name, shown on the editor's top border. |
| `/pi-style startup <off\|compact\|overlay>` | Select startup mode. |
| `/pi-style surface <name> on\|off` | Toggle startup/status/editor/messages/tools. |
| `/pi-style set <path> <JSON>` | Set one documented leaf after validation, e.g. `set statusLine.layout.left ["model","git"]`. |
| `/pi-style persist global\|project set <path> <JSON>` | Persist the same validated mutation to the selected durable scope. |
| `/pi-style reload` | Re-read configuration and reinstall affected surfaces. |
| `/pi-style doctor` | Show capability/conflict/fallback diagnostics. |

Ordinary mutations are session-only; persistence requires an explicit `global` or `project` scope, and project writes require trust.

---

## Detached editor integration (optional)

In a TUI session, other extensions can use `globalThis[Symbol.for("@quandev104/pi-style:detached-editor")]` as an optional provider:

```ts
const provider = (globalThis as Record<symbol, { create?: Function }>)[
  Symbol.for("@quandev104/pi-style:detached-editor")
];
const editor = provider?.create?.(tui, theme, keybindings, {
  sessionName: "Child session",
  editorBorderColor: "#123456",
});
// Fall back to Pi's native editor when no provider/editor is available.
// Call editor?.dispose() when the detached overlay closes.
```

`create` accepts the full Pi `Theme` passed into `ctx.ui.custom` callbacks (not the smaller editor theme), and returns a standalone `StyledEditor` or `undefined` when styling is disabled. Its draft and identity are independent of Main; neither Main's snapshot nor clipboard image registry is inherited. Current pi-style config and the supplied theme are used at creation; config changes update live detached editors. Session shutdown unregisters the provider and stops config updates, restoring any previous symbol value; already-created editors remain usable until their overlay disposes them. No Pi editor component is installed or replaced by this API.

## Compatibility

- Public Pi APIs (widgets, editor, header, footer bridge) are preferred and enabled by default.
- Tier C core patches (message prefixes, special blocks, tool selectors) are identity-certified per surface against recorded fingerprints (Pi `0.83.0`–`0.85.1`, `0.99.1`–`0.99.2`, `1.0.0`, `1.1.0`, `1.2.0`, and `1.3.0` observed; Pi ≥`0.84.3` loads the CLI from a minified bundled runtime, so every surface also records the bundled identities; `0.85.1` rebundles with renamed minified parameters; `1.0.0` retains the `0.99.2` identities; `1.1.0` re-records three layout surfaces and `1.2.0` only `handleEvent`, carrying the rest forward; `1.3.0` preserves all `1.2.0` identities — every surface re-verified in both families), isolated, reversible, and flag/config gated; any surface whose runtime identity is not recorded falls back natively on its own.
- No render-time I/O: filesystem, Git, settings, and session data flow through cached providers into immutable snapshots.
- Terminal-global background synchronization is unsupported/off for technical v1; explicit cell backgrounds and Pi theme APIs remain supported.
- Terminal multiplexers gate kitty graphics: in herdr, previews (and Pi's own tool-result images) require `experimental.kitty_graphics = true` in `~/.config/herdr/config.toml` plus a server restart; tmux disables images upstream.

---

## Architecture

```text
shared → domain → features → app → pi
```

```text
extension-src/pi-style/
├── shared/     ANSI/width, box, elapsed, split-diff, render-budget, theme extras
├── domain/     config, theme, status presets/renderer, authorization
├── features/   status-line, editor, startup, messages, tools
├── app/        runtime, snapshot, scheduler, providers, commands, doctor
└── pi/         Pi event handlers, session coordinator, compatibility probe
```

Layer boundaries are enforced by dependency-cruiser.

---

## Documentation

Start with [`docs/README.md`](docs/README.md), then the product, architecture, and testing contracts. UI surface contracts live under [`docs/ui/`](docs/ui/README.md), and accepted decisions under [`docs/decisions/`](docs/decisions/README.md). The phase-by-phase plan is in [`ROADMAP.md`](ROADMAP.md).

---

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm run depcruise
npm test
npm run build
npm run check
```

`npm run check` runs all required automated gates in order.

Current test suite: 917 tests across 48 files.

---

## License

[MIT](LICENSE)

### Automatic render optimization

Assistant presentation updates are automatically buffered until Pi's next render
frame, and finished native renders are cached. There is no separate optimization
toggle. Existing Tier C core/assistant authorization flags and per-method
fingerprint certification are still required; both `render` and `updateContent`
must be installed successfully. Unsupported surfaces retain native behavior.

Pi still owns messages, history, input and repaint scheduling. Completion,
abort/error and thinking/theme invalidation rebuild immediately; pending deltas
flush before rendering or patch cleanup. Finished-render caching retains only one
width per component (up to 4,096 lines), invalidates on content/visibility/theme
updates, and never caches streaming output. No additional repaint throttle or
streaming timer is installed on top of Pi's native scheduler.

Verification: `npm test -- test/performance/presentation-buffer*.test.ts --silent=false --disableConsoleIntercept`
(native rebuild counts and deterministic lifecycle contracts), and
`npm test -- test/performance/message-render-benchmark.test.ts` (synthetic
message-decoration timing, not interactive terminal latency). Chat virtualization
is **not implemented**: this release preserves Pi's complete component tree and
history instead of parking private chat children. Long-chat benefit here is
limited to caching finished message renders.
