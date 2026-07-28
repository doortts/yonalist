# Yonalist v2 verification status

Verification date: 2026-07-29. Baseline: `main@502af65`.

## Passed on the active Windows machine

| Gate | Evidence |
|---|---|
| v2 Rust workspace | 80 tests passed |
| v2 React behavior | 168 tests passed, including repeated Enter/Backspace, first-bullet creation, Korean IME, split open/close/resize/focus, complete-forest selection, batch moves with single-step Undo/Redo, structural clipboard, keyboard/cross-pane drag, navigation history, repeated-close flush safety, page deletion, and stale viewport recovery |
| Generated IPC contracts | 23 `ts-rs` files match the Rust source |
| Architecture | dependency direction, cycles, frontend file budgets, exact eight-command Tauri surface, legacy-production-import guard, and minimum close capability passed; only the pre-existing 913-line Rust property-test advisory remains |
| Static checks | v2 and legacy ESLint passed; `cargo fmt --check` and `cargo check --workspace --all-targets` passed |
| Legacy behavior oracle | 4,314 frontend tests passed; 27 skipped; architecture budget and Windows Rust compilation passed |
| Renderer budget | 293.1KB raw / 89.5KB gzip initial editable JavaScript |
| SQLite | 5,000-node bootstrap p95 14.2ms across 50 samples; 50,000-node bootstrap 108.6ms; 50,000-sibling append 15.8ms |
| Interaction guard | 800-node draft projection notified only its owning row; 200 draft events remained below the 20ms p95 and 50ms long-task test thresholds |
| Fresh browser path | instructional preview bullet absent; repeated Enter/Backspace, split resize, pointer/keyboard range selection, batch indent/outdent/reorder, cross-pane drag, and structural Undo/Redo passed with zero console warnings/errors |
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
