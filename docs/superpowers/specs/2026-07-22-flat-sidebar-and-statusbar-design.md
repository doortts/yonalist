# Flat Sidebar and Status Bar Design

## Goal

Flatten the application chrome without changing pane layout or behavior.

## Accepted UI Contract

- The bottom status bar has a transparent background.
- The status bar has no top divider and keeps its existing spacing, text, and actions.
- The left navigation pane has a transparent background.
- The left navigation pane has no border or box shadow.
- List, notification, detail, and settings content panes keep their current styling.

## Implementation

Make a scoped CSS-only change in `src/styles.css`:

- Change `.app-statusbar` background to `transparent`.
- Override `.sidebar` border and box shadow in its existing sidebar rule.
- Change `.sidebar` background to `transparent`.

No component, state, data, IPC, or persistence changes are required.

## Verification

- Add or update a focused style contract test if an existing CSS assertion pattern is available.
- Run the relevant application tests, CSS linting, build, and `git diff --check`.
- Confirm in the running desktop app that only the requested chrome is removed.
