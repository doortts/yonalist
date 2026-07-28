# Yonalist v2 verification status

Verification date: 2026-07-28. Baseline: `main@502af65`.

## Passed on the active Windows machine

| Gate | Evidence |
|---|---|
| v2 Rust workspace | 77 tests passed |
| v2 React behavior | 132 tests passed, including first-bullet creation, Korean IME, split resize, complete-forest selection, structural clipboard, keyboard/cross-pane drag, navigation history, repeated-close flush safety, page deletion, and stale viewport recovery |
| Generated IPC contracts | 23 `ts-rs` files match the Rust source |
| Architecture | dependency direction, cycles, file budgets, exact eight-command Tauri surface, legacy-production-import guard, and minimum close capability passed |
| Static checks | v2 and legacy ESLint passed; `cargo fmt --check` and `cargo check --workspace --all-targets` passed |
| Legacy behavior oracle | 4,314 frontend tests passed; 27 skipped; architecture budget and Windows Rust compilation passed |
| Renderer budget | 276.1KB raw / 85.1KB gzip initial editable JavaScript |
| SQLite | 5,000-node bootstrap p95 13.7ms across 50 samples; 50,000-node bootstrap 104.1ms; 50,000-sibling append 13.9ms |
| Interaction guard | 200 draft events remained below the 20ms p95 and 50ms long-task test thresholds |
| Native release | optimized executable, MSI, and NSIS bundles built successfully |
| Cold launch proxy | 50 launches: p50 92.3ms / p95 110.5ms to a native window |
| Windows close path | real `Alt+F4` flushed the session and exited; close re-entry, failed-maintenance retry, and IPC wire shape have dedicated tests |
| Packaged vertical slice | release process with isolated `YONALIST_V2_DATA_DIR` created a page and first bullet through Tauri IPC, persisted edits, performed Undo/Redo, flushed, restarted, restored both texts, and began with empty session history |
| Dependency audit | `npm audit` reports 0 known vulnerabilities after patch-level transitive updates |
| Windows visual inspection | shell, navigation, page list, outline, resizable split, typography, spacing, and status bar render through the existing CSS and DOM classes |

## Gates intentionally not claimed

- macOS golden screenshots and Apple Silicon 50-launch measurements require the designated
  macOS reference machine.
- The Windows cold-launch result ends at a responding native window. It is a lower-bound proxy,
  not the required process-spawn-to-editor-ready measurement.
- Clippy was not available because the active Rust 1.97 toolchain does not have the component
  installed. `cargo check --workspace --all-targets` passed instead.
- Historical-plan reconciliation cannot complete because its recorded audited head
  `ec8a9ff3d016449255992adf70e128ea5e222e9a` is absent locally and the origin rejects a fetch
  for that object. The validator was not weakened and the audit metadata was not rewritten.
- Recent and Archive are disabled because schema v1 intentionally has no timestamp/archive
  command contract yet.
- Attachments, images, export, Markdown synchronization, external sources, compatibility, and
  migration are deliberately outside the v2 text-core production graph.

## Cutover decision

The legacy tag, default-target switch, and legacy deletion remain blocked until the macOS
visual/performance gates and the true editor-ready startup measurement pass. Keeping those
operations pending preserves the current application and follows the approved cutover order.
