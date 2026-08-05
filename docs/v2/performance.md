# Yonalist v2 performance record

Latest renderer and SQLite measurements were refreshed on the active Windows
development machine on 2026-07-29.

## Renderer bundle

`npm run test:v2:bundle`

- Initial editable JavaScript: **293.9KB raw / 89.1KB gzip**.
- Budget: 300KB raw / 90KB gzip.
- Search, selection actions, drag visuals/planning, image ingest/editing, and
  close/external-link adapters are lazy chunks.
- Browser-only preview data is checked not to occur in production JavaScript.
- The unchanged current CSS is 104.1KB raw / 17.5KB gzip and is recorded separately from
  the editable JavaScript budget.
- An 800-node projection test proves one draft publishes only to its owning
  row, without invalidating the shell, outline, or adjacent rows.
- A 200-event draft-overlay test enforces p95 below 20ms and every measured
  event below the 50ms long-task boundary in the frontend test runtime.
- A 512-row mixed outline containing 256 image nodes keeps no more than eight
  verified Blob URLs alive while visibility moves through the list. Opening an
  image action menu 100 times performs zero asset reads.

## Bounded SQLite bootstrap

`npm run test:v2:performance`

| Fixture | Result |
|---|---:|
| 1 node | below 100ms guard |
| 5,000 nodes, single sample | 15.3ms |
| 5,000 nodes, 50 samples | p50 12.7ms / p95 15.4ms |
| 50,000 sibling append mutation | 19.6ms; one changed node |
| 50,000 nodes, single sample | 108.6ms |

These numbers cover the DB worker's bounded bootstrap query, not OS process creation.
Process-spawn-to-editable cold-start measurement still requires the fixed Windows and Apple
Silicon release reference machines. The 5,000-node renderer-side prerequisite is within the
20ms target on this machine.

## Fresh browser interaction path

A newly started `127.0.0.1:1421` preview was exercised again on 2026-07-29:

- 20 consecutive Enter events created exactly 20 blank bullets and left the
  caret in the final row;
- 20 consecutive Backspace events removed exactly those rows and restored the
  caret to the end of the original bullet;
- Shift-clicking Zoom opened a second Notes outline region without changing
  the current layout;
- pointer and keyboard range selection both selected the same two rows;
- batch indent/outdent and block up/down moves preserved order;
- the selected block moved into the secondary split pane, and each accepted
  structure change round-tripped through Undo/Redo; and
- the inspected browser console contained zero warnings or errors.

This is observable interaction evidence, not a process-spawn cold-start
measurement.

## Monaco whole-outline experiment

A branch-only, one-editor-per-pane Monaco experiment was sampled on
2026-07-30. Its 5,000-line projection took a five-run median of 1.79ms;
200 single-line projection/diff updates took 137.45ms total, and 100 middle
insertions took 58.06ms total. All changes stayed bounded to one minimal edit.

The tradeoff is substantial: opening the experiment loads 646.17KB gzip of
lazy Monaco JavaScript, 11.68KB gzip of Monaco CSS, and a 281.29KB raw editor
worker. The query-free main chunk also rises from 89.99KB to 90.15KB gzip;
the complete editable graph is 37 bytes over the current 90KiB budget. It is
therefore not recommended as the production replacement. See
[`monaco-outline-spike-report.md`](./monaco-outline-spike-report.md) for the
behavior matrix, browser evidence, and recommendation.

## Image asset lifecycle

Image bytes stay outside SQLite rows, generated IPC DTOs, mutation receipts, and
Undo/Redo patches. Content-addressed files are decoded and verified before
publication. Replace, Undo, and Redo retain one final live hash; startup performs
no directory scan, while close reconciliation removes unreferenced assets. A
restart then restores metadata and intentionally begins with empty session
history.

## Windows release artifact

Rebuilt on 2026-07-29 with `npm run v2:tauri:build`:

- Optimized, LTO, stripped executable: **7.41MiB**.
- Release build completed successfully with `panic=abort` and one codegen unit.
- MSI installer: **4.62MiB**.
- NSIS installer: **2.65MiB**.

A fresh packaged process using an isolated `YONALIST_V2_DATA_DIR` loaded the
current shell and initialized the SQLite and content-addressed image
directories. Through the live WebView debugging boundary,
`notes_close_session` completed in 3.6–4.1ms and the authorized window destroy
closed the process. A synthetic Windows close message sent to a hidden window
did not reach WebView `closeRequested`, so it is not recorded as a user Alt+F4
result.

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
