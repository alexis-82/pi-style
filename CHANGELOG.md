# Changelog

## [0.5.13] - 2026-10-20

### Bug Fixes

- *(ansi)* Truncate by terminal cell width, not UTF-16 length (#1)
- *(status)* Avoid truncating fitted right-aligned rows (#3)

### Features

- *(compat)* Support Pi 1.3 (#2)

## [0.5.12] - 2026-10-20

### Features

- Add process-only --disable-pi-style flag

## [0.5.11] - 2026-10-19

### Features

- *(ui)* Unify team card structure and per-teammate notifications

## [0.5.10] - 2026-10-16

### Bug Fixes

- Standardize built-in glyphs on portable Unicode

## [0.5.9] - 2026-10-16

### Features

- *(ui)* Adopt team event glyph system and task delta cards (ADR 0012, 0013)

## [0.5.8] - 2026-10-13

### Bug Fixes

- Match working indicator color to editor border
- Restore Pi server dependency for clean test installs

### Features

- Optimize assistant rendering and update Pi compatibility
- Render unified team tools and teammate results

### Testing

- Account for read chunk line counting in performance budget

## [0.5.7] - 2026-10-12

### Features

- *(messages)* Render skill invocations as inline prompt badges

### Miscellaneous Tasks

- Add demo image to package gallery

## [0.5.5] - 2026-10-09

### Bug Fixes

- Preserve compact tool styles when expanding run summaries

### Features

- Expose detached styled editor for child views

## [0.5.4] - 2026-10-09

### Bug Fixes

- *(teams)* Label Get result receipts with the admitted teammate
- *(teams)* Color teammate references across UI

### Miscellaneous Tasks

- Merge remote v0.5.3 release

## [0.5.3] - 2026-10-07

### Bug Fixes

- *(teams)* Render effective teammate instance identity
- *(teams)* Preserve child tool pins and literal editor colors

### Features

- Add session editor badges and redesign compaction cards
- Add compact pi-teams companion UI

## [0.5.2] - 2026-10-07

### Features

- *(messages)* Interleaved cumulative run-summary labels

## [0.5.1] - 2026-10-05

### Bug Fixes

- *(startup)* Match Pi logo reference brand colors
- *(editor)* Preserve native working indicator in styled frames
- *(summary)* Unify run disclosure and native expansion state

## [0.5.0] - 2026-10-05

### Bug Fixes

- *(messages)* Finalize merged summaries before rebuilding tools

### Features

- *(tools)* Grep panels list matching files only

## [0.4.1] - 2026-10-02

### Bug Fixes

- *(tools)* Compact path labels and certify Pi 1.0.0

## [0.4.0] - 2026-10-01

### Features

- *(expand)* Consistent click + Ctrl+O expansion; fix hidden-message gaps

## [0.3.3] - 2026-10-01

### Features

- *(messages)* One merged summary line per agent run; fix agent_end ordering

## [0.3.2] - 2026-10-01

### Bug Fixes

- *(messages)* Attribute thinking-less tool messages to the latest thought group

## [0.3.1] - 2026-10-01

### Bug Fixes

- *(messages)* Publish merged-summary stats at turn_end; certify pi 0.99.2

## [0.3.0] - 2026-09-30

### Features

- Pi 0.99.1 support, merged turn summary, compaction transcript preservation

## [0.2.11] - 2026-09-09

### Bug Fixes

- *(messages)* Stabilize segmented thought summaries

## [0.2.10] - 2026-09-07

### Bug Fixes

- *(compat)* Support Pi 0.85.1 runtime identities

### Documentation

- *(changelog)* Describe the unreleased tools work; refresh test counts

### Features

- *(messages)* Surface completed thinking runs as a clickable summary row
- *(tools)* Report aggregate diff stats in the collapsed turn summary
- *(tools)* Boxes own their status background; failed boxes render error frames

## [0.2.9] - 2026-09-04

### Bug Fixes

- *(compat)* Support Pi 0.85.0 runtime identities
- *(startup)* Show the current project path in the heading; simpler logo

## [0.2.7] - 2026-08-25

### Bug Fixes

- *(compat)* Support Pi 0.84.3 bundled runtime identities

## [0.2.5] - 2026-08-25

### Bug Fixes

- *(messages)* Preserve text in tool-calling messages

## [0.2.3] - 2026-08-22

### Documentation

- *(readme)* Document image features, herdr caveat, absolute demo URL

### Features

- *(status-line)* Pipe-delimited context block with token totals
- *(images)* User-prompt image previews and clipboard image input

## [0.2.2] - 2026-08-17

### Performance

- Fix audit findings C1-C5/H1-H4/M1-M7 across render hot paths

### Testing

- Widen perf-regression timing bounds for CI runners

## [0.2.1] - 2026-08-12

### Performance

- Optimize interactive rendering hot paths

## [0.2.0] - 2026-08-08

### Bug Fixes

- *(turn-summary,box)* Broken frames on collapse/expand, faileds plural, stray placeholder rows

### Features

- *(turn-summary)* Keep mutating tool blocks visible after the turn

## [0.1.7] - 2026-08-07

### Features

- *(turn-summary)* Collapse completed agent runs into one dim summary line

## [0.1.6] - 2026-08-06

### Features

- *(compat)* Identity-first certification, support Pi 0.84.0 without version pinning

## [0.1.5] - 2026-08-05

### Bug Fixes

- *(box)* Visible dim terminal-default frame borders (match omp)
- *(box)* Dim terminal-default for tree/divider/gutter lines (match omp)
- *(git,gh)* Dim terminal-default tree branches (match omp)
- *(box)* Rename find tool header label from Glob to Find

### Features

- Rounded dock editor frame with dim hint, zero-trace thinking collapse
- Add titanium dark/light themes ported from omp defaults
- *(box)* State-dynamic tool frame color mirroring omp borders
- Git and gh semantic renderers as bash presentation adapters (Phase 8)
- *(theme)* Auto-apply titanium theme at TUI session start
- *(box)* Render lone read calls as a single inline line
- *(editor,tools)* Bash-mode prompt icon, hidden bang, boxed bash execution

### Miscellaneous Tasks

- Biome format 7 boxed-tool files to pass npm run check
- *(assets)* Refresh demo screenshot

## [0.1.4] - 2026-08-05

### Features

- Strict boxed tool-card state machine with live running/streaming/terminal states

## [0.1.3] - 2026-08-04

### Bug Fixes

- *(test)* Drop timing-dependent 0.00s assertion in batch header

### Features

- Group consecutive quiet-tool calls into a boxless batch panel

### Refactor

- Render lone read/ls/find calls with the same boxless tree
- Boxless output trees, readonly tool activation, drop user prefix

## [0.1.2] - 2026-08-04

### Bug Fixes

- Re-decorate tool/message boxes after session resume

### Features

- Adaptive unified/split diffs and rounded boxed tool surfaces

## [0.1.1] - 2026-08-03

### Documentation

- Add demo screenshot to README

### Features

- Implement phase 1A foundation
- Implement phase 2 status line foundation
- Complete phase 2 status line
- Complete phase 3 styled editor
- Complete phase 4 startup presentation
- Complete phase 5 messages and tools
- Complete phase 6 configuration and composition
- Boxed tool/message presentation ported from pi-droid-styling

### Miscellaneous Tasks

- Complete phase 0 foundation
- Add CI and release workflows with git-cliff changelog
- Point changelog repo links at quanpersie2001/pi-style
- Use npm ci for deterministic installs
- Use npm install like pi-rules to tolerate cross-platform lockfile gaps

### Styling

- More breathing room inside boxed surfaces

### Testing

- Close phase 2 status line gaps

