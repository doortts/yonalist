# Yonalist v2 performance record

Latest renderer and SQLite measurements were refreshed on the active Windows
development machine on 2026-07-29.

## Renderer bundle

`npm run test:v2:bundle`

- Initial editable JavaScript: **293.1KB raw / 89.5KB gzip**.
- Budget: 300KB raw / 90KB gzip.
- Search is a lazy chunk.
- Browser-only preview data is checked not to occur in production JavaScript.
- The unchanged current CSS is 104.1KB raw / 17.5KB gzip and is recorded separately from
  the editable JavaScript budget.
- An 800-node projection test proves one draft publishes only to its owning
  row, without invalidating the shell, outline, or adjacent rows.
- A 200-event draft-overlay test enforces p95 below 20ms and every measured
  event below the 50ms long-task boundary in the frontend test runtime.

## Bounded SQLite bootstrap

`npm run test:v2:performance`

| Fixture | Result |
|---|---:|
| 1 node | below 100ms guard |
| 5,000 nodes, single sample | 16.4ms |
| 5,000 nodes, 50 samples | p50 12.0ms / p95 14.2ms |
| 50,000 sibling append mutation | 15.8ms; one changed node |
| 50,000 nodes, single sample | 108.6ms |

These numbers cover the DB worker's bounded bootstrap query, not OS process creation.
Process-spawn-to-editable cold-start measurement still requires the fixed Windows and Apple
Silicon release reference machines. The 5,000-node renderer-side prerequisite is within the
20ms target on this machine.

## Fresh browser interaction path

A newly started `127.0.0.1:1421` preview was exercised on 2026-07-29:

- six consecutive Enter events left the caret in the final blank row with the
  pre-existing next bullet immediately after it;
- six consecutive Backspace events removed all six blank rows and restored
  the caret to offset 4 at the end of `Beta`;
- pointer and keyboard range selection both selected the same two rows;
- batch indent/outdent and block up/down moves preserved order;
- the selected block moved into the secondary split pane, and each accepted
  structure change round-tripped through Undo/Redo; and
- the inspected browser console contained zero warnings or errors.

This is observable interaction evidence, not a process-spawn cold-start
measurement.

## Windows release artifact

Previously measured on 2026-07-27 with
`cargo build --release -p yonalist-v2-desktop`:

- Optimized, LTO, stripped executable: **6.06MiB**.
- Release build completed successfully with `panic=abort` and one codegen unit.
- MSI installer: **3.99MiB**.
- NSIS installer: **2.20MiB**.

## Windows cold-launch proxy

Previously measured on 2026-07-27: fifty release launches from process spawn
to an existing, responding native window:

| Samples | min | p50 | p95 | max |
|---:|---:|---:|---:|---:|
| 50 | 77.5ms | 92.3ms | 110.5ms | 221.6ms |

This is a native-window-ready proxy and therefore a lower bound, not the final
process-spawn-to-editor-ready acceptance number. Each benchmark process was terminated after
the window-ready sample so shutdown time could not contaminate the next launch. Shutdown was
validated separately through a real focused Windows `Alt+F4`: the close handler flushed
`notes_close_session`, ran `PRAGMA optimize`, used the minimum Tauri destroy capability, and
the process exited.
