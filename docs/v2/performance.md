# Yonalist v2 performance record

Measured on the active Windows development machine on 2026-07-27.

## Renderer bundle

`npm run test:v2:bundle`

- Initial editable JavaScript: **218.9KB raw / 68.3KB gzip**.
- Budget: 300KB raw / 90KB gzip.
- Search is a lazy chunk.
- Browser-only preview data is checked not to occur in production JavaScript.
- The unchanged current CSS is 104.1KB raw / 17.5KB gzip and is recorded separately from
  the editable JavaScript budget.
- A 200-event draft-overlay test enforces p95 below 20ms and every measured event below
  the 50ms long-task boundary in the frontend test runtime.

## Bounded SQLite bootstrap

`npm run test:v2:performance`

| Fixture | Result |
|---|---:|
| 1 node | below 100ms guard |
| 5,000 nodes, single sample | 13.5ms |
| 5,000 nodes, 50 samples | p50 11.8ms / p95 13.7ms |
| 50,000 sibling append mutation | 13.9ms; one changed node |
| 50,000 nodes, single sample | 104.1ms |

These numbers cover the DB worker's bounded bootstrap query, not OS process creation.
Process-spawn-to-editable cold-start measurement still requires the fixed Windows and Apple
Silicon release reference machines. The 5,000-node renderer-side prerequisite is within the
20ms target on this machine.

## Windows release artifact

`cargo build --release -p yonalist-v2-desktop`

- Optimized, LTO, stripped executable: **6.06MiB**.
- Release build completed successfully with `panic=abort` and one codegen unit.
- MSI installer: **3.99MiB**.
- NSIS installer: **2.20MiB**.

## Windows cold-launch proxy

Fifty release launches measured process spawn to an existing, responding native window:

| Samples | min | p50 | p95 | max |
|---:|---:|---:|---:|---:|
| 50 | 77.5ms | 92.3ms | 110.5ms | 221.6ms |

This is a native-window-ready proxy and therefore a lower bound, not the final
process-spawn-to-editor-ready acceptance number. Each benchmark process was terminated after
the window-ready sample so shutdown time could not contaminate the next launch. Shutdown was
validated separately through a real focused Windows `Alt+F4`: the close handler flushed
`notes_close_session`, ran `PRAGMA optimize`, used the minimum Tauri destroy capability, and
the process exited.
