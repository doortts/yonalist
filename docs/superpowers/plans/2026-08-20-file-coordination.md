# Vault reads and writes go through file coordination on macOS

## Why

Apple's current guidance ("Shared data" technology overview) is unambiguous:
"File coordination is **essential** if you read and write files in iCloud …
or in any shared space." Coordination is the claim protocol fileproviderd
itself participates in — it is what prevents a torn read while the daemon is
replacing a file, and it is the channel through which the system learns a
write happened (TextEdit gets iCloud's conflict handling for free this way;
we, like Obsidian, currently get none of it, and unlike Obsidian we can fix
that — we are native).

Known limits, stated so nobody oversells this slice: coordination does NOT
prevent bounced files (two offline devices creating one path can never
coordinate — Apple's own TN2336 mechanism), and no measurement exists that it
reduces them. What it buys is torn-read/-write safety against the daemon and
correct participation in the platform's file arbitration. The bounced-file
problem is already handled by the pattern/identity work shipped this week.

The second half of the slice is a probe, not a feature: TN2336 says the
*data* scope resolves conflicts as same-URL `NSFileVersion`s while the
document scope bounces file names. Which one a user-visible CloudDocs folder
produces for us is unverified. A one-line detector tells us from real vaults
whether an NSFileVersion-consuming merge is ever worth building.

Dependency note: `objc2 0.6.4`, `objc2-foundation 0.3.2`, `block2 0.6.2` are
already in `Cargo.lock` via tauri — this adds dependency *edges* (macOS-only,
in `notes-sync`), no new crates to the graph. The `objc2-foundation` bindings
were inspected: `coordinateReadingItemAtURL_options_error_byAccessor` /
`coordinateWritingItemAtURL_options_error_byAccessor` are safe (non-`unsafe`)
signatures taking `&block2::DynBlock<dyn Fn(NonNull<NSURL>) + '_>`, and
`NSFileVersion::unresolvedConflictVersionsOfItemAtURL` exists. Needed
features include `NSFileCoordinator`, `NSFileVersion`, `NSURL`, `NSError`,
`NSArray`, `NSString`, `block2`.

## Contract

| Field | Content |
| --- | --- |
| Goal | On macOS, every vault document read and write this crate performs holds a file-coordination claim while it runs, and the app can tell whether iCloud ever attaches unresolved NSFileVersions to a vault file. |
| Acceptance | A1: `coordinated_read`/`coordinated_write` run the given closure under a real `NSFileCoordinator` claim on macOS (proved by a test that reads/writes a temp file through them and round-trips bytes and errors), and are plain passthroughs elsewhere. A2: `write_atomic` and `read_regular_bounded` route through them; every existing `file_io`, export, and watcher test passes unchanged. A3: the accessor uses the URL the coordinator hands back, not the URL asked about — the two can differ. A4: `unresolved_version_count(path)` answers 0 for an ordinary local file, and the watcher logs one line naming the file when the count is ever nonzero. |
| Non-goals | No `NSFilePresenter` (we have our own watcher; a presenter also weakens coordination — claims sharing a presenter stop excluding each other). No coordination of `move_no_replace`, directory removals, or attachment copies (follow-up if this slice proves itself). No NSFileVersion *resolution* — detection only. No async `coordinate(with:queue:)` form. No sandbox/entitlement work (the app is not sandboxed; filecoordinationd needs none). |
| Boundaries | Rust: `crates/notes-sync` (new `coordination.rs`, `file_io.rs`, `Cargo.toml` target-gated deps), `apps/desktop/src-tauri/src/vault_watch.rs` (the probe's one call site). No IPC shape change, no schema, no frontend. |
| Manual proof | Real-app smoke on this machine after merge: vault still exports and merges (the running `tauri dev` picks it up); no probe line for a healthy vault. A true NSFileVersion positive cannot be staged — that is exactly what the probe exists to observe in the wild. |

## Items

### Item 1 — `coordination.rs`: the claim, behind a passthrough seam

New module in `notes-sync`:

```rust
pub fn coordinated_read<T>(path: &Path, read: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String>
pub fn coordinated_write<T>(path: &Path, write: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String>
```

Non-macOS: call the closure with `path`, nothing else — the seam exists so
every other platform costs zero.

macOS: one `NSFileCoordinator::new()` per call (Apple: per-operation, default
initializer, no presenter — a shared presenter or reused instance stops
claims excluding each other). Reads use options `0`; writes use
`ForReplacing`, because `write_atomic` genuinely replaces the file with a
different one — Apple: use it "regardless of whether an item is actually in
the way". The closure receives the path from the URL the accessor block is
handed (A3). Plumbing an `FnOnce` and a `Result` through a `Fn` block takes a
`RefCell<Option<…>>` for each; if the coordinator reports an error the
accessor never ran — surface the `NSError`'s description. Keep the `unsafe`
surface to the minimum the bindings force, each with a SAFETY comment in the
crate's existing voice.

Cargo: `[target.'cfg(target_os = "macos")'.dependencies]` on `objc2`,
`objc2-foundation` (the features listed above), `block2` — versions matching
the lock.

Tests (in the module or `tests/`): a write through `coordinated_write` lands
bytes and returns the closure's value; a read through `coordinated_read`
returns them; a closure error comes back as the function's error. On macOS
these run under a live coordinator — that is the point; they are also the red
evidence (the functions do not exist yet). Do not mock the coordinator.

### Item 2 — `file_io` routes through the seam

`write_atomic`: resolve as today, then `coordinated_write(&resolved, |at| …existing temp+rename+dir-sync body against `at`…)`.
The temp file goes in `at`'s parent. `read_regular_bounded`: resolve as
today, then `coordinated_read(&resolved, |at| …existing open/guard/read body…)`.

This item is behavior-invariant by design and has no new red test — the whole
existing suite running through live coordination on macOS *is* the test
(precedent: the `b628b8b9` plumbing commit). One real cost to name in the
commit message: each read/write now pays a filecoordinationd round trip; the
boot scan reads serially, so a large vault's first pass gets slower. Accepted
— correctness first, and the sweep's stat gate keeps steady-state reads rare.

Never nest a claim: nothing in the crate currently calls a coordinated
function from inside another's closure, and a comment on the seam says the
rule out loud (same-thread nested claims deadlock).

### Item 3 — the NSFileVersion probe

`coordination.rs` grows `pub fn unresolved_version_count(path: &Path) -> usize`
(`NSFileVersion::unresolvedConflictVersionsOfItemAtURL`, `None`/empty → 0;
non-macOS → 0). `vault_watch::take` calls it for a file it is about to merge
and, when nonzero, logs one `eprintln!` line naming the relative path and the
count — the crate has no logging framework, the dev console is where this
evidence is read, and a healthy vault prints nothing. Test: 0 for a fresh
temp file (red: function missing). The positive case is un-stageable by
design; the probe exists to observe it on real vaults.

## Gates

`cargo test --workspace --no-fail-fast`, `cargo fmt --check`. Frontend
untouched. Watch the workspace suite's wall time before/after item 2; report
the delta rather than hiding it.

## Risks

- Coordination can block indefinitely while iCloud fetches. Both call sites
  already sit on background threads (export thread, watcher thread) that
  block on those same files today via read-is-fetch — no new hang surface,
  but the flush-on-quit path now waits on any claim in flight. Accepted.
- The macOS test environment talks to the real filecoordinationd; if a CI
  sandbox someday denies it, the tests fail loudly there — preferable to a
  mocked coordinator that proves nothing.
