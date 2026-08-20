# iCloud Drive as a first-class vault location

## What changed since the numbered-duplicate fix

The earlier fix (`83111e69`) absorbs iCloud's numbered copies instead of
fighting them, and the running app has since proved it: `folder_path` is back
on `README.md`, both copies are gone, and the conflict log stopped growing.
That was damage control. This slice goes at the causes, and research
overturned the first hypothesis.

**Apple's own name and mechanism.** TN2336 calls `README 2.md` a *bounced
file*, created on a **new-file conflict** — two writers independently create a
file at one path with **different** contents. Two facts follow directly:

- Identical bytes never bounce: "If they are the same, iCloud Drive will
  determine that there is no conflict, thus won't create a bounced file."
  `write_checked` already skips a write whose bytes match the disk, so that
  half is done.
- The attested single-machine trigger is **writing over a file that exists in
  iCloud but is not materialized locally** — iCloud takes the write as a new
  file, uploads it, brings the stored copy back down, and disambiguates the
  name with a number.

**The local-copy state is invisible to this app today.** On macOS 14 and up an
evicted iCloud file is not a `.icloud` stub and not zero bytes: it keeps its
name and its full apparent size and holds no data extents — an APFS *dataless*
file. So `intake.rs`'s "zero bytes means the bytes have not arrived" gate
cannot fire on any current macOS, and `export.rs` cannot tell a materialized
file from an evicted one. Both read it as an ordinary file. That is exactly
the state the bounce trigger describes.

**NSFileCoordinator is deliberately not in this slice.** Apple does say every
iCloud file operation should be coordinated, and it is the documented way to
avoid torn reads against the sync daemon — a real correctness item worth
doing later. But no Apple document, WWDC session, or credible report claims
coordination reduces bounced files, and TN2336's mechanism (a multi-device
new-file conflict) is not something a single machine's claims can prevent.
Building it first would be paying an objc2 + threading cost for an unverified
benefit. It gets its own contract when the dataless work is in.

Detection needs no new dependency: `SF_DATALESS` (`0x40000000`) in `st_flags`,
reachable from `std::os::macos::fs::MetadataExt::st_flags` (probed on this
machine). Reading a dataless file materializes it, which is how it comes back
— that is the whole reason the export can hand the job to the watcher instead
of calling a download API.

## Contract

| Field | Content |
| --- | --- |
| Goal | An iCloud vault whose files have been evicted converges without producing bounced copies: the export never writes over a file whose bytes are not local, and the watcher treats such a file as "not arrived yet" rather than reading it as content. Plus: this device keeps one identity across a database reset. |
| Acceptance | A1: `intake`'s not-yet-arrived verdict is reached for a dataless file, whatever its apparent size, and a zero-byte file keeps its current verdict. A2: `write_checked` does not write over an existing dataless file; it reports `needs_merge` so the pass retries, and the file's own bytes are never replaced. A3: on a healthy (materialized) vault every existing export and merge behavior is byte-for-byte unchanged. A4: `ensure_device_id` derives its four hex characters from this machine rather than from a random UUID, so two databases provisioned on one Mac agree; a database that already holds an id keeps it. |
| Non-goals | No `NSFileCoordinator`/`NSFilePresenter` (own contract, later). No `startDownloadingUbiquitousItem` — reading materializes, and the watcher already reads. No pinning files as downloaded (no third-party API exists). No `.nosync` (undocumented, and reported to get folders deleted). No write-frequency change. No schema change, no migration. No Finder-localized copy names. |
| Boundaries | Rust: `crates/notes-sync` (`intake.rs`, `export.rs`, `hlc.rs`, `file_io.rs` if the probe lands there), `crates/notes-sqlite` (`worker.rs::ensure_device_id`). macOS-only code is `cfg`-gated with a non-macOS fallback so the workspace still builds and tests elsewhere. No IPC, no frontend, no SQLite schema. |
| Manual proof | Cannot be forced on demand — eviction needs Optimize Mac Storage and iCloud's own timing, and this machine currently holds no dataless file (`ls -lO` shows no flags). Proof is therefore: unit coverage over the flag predicate, plus a live check that the healthy vault keeps exporting and merging normally after the change, plus the device id staying equal across two freshly provisioned databases. |

## Items

One commit each, test first, red evidence recorded verbatim.

### Item 1 — a dataless file is a file whose bytes have not arrived

`crates/notes-sync/src/intake.rs` grows one predicate — whether a
`std::fs::Metadata` says dataless — and `watcher.rs::consider` asks it right
where it asks about zero length today:

```
if facts.len() == 0 { return Ok(Verdict::NotYetArrived); }
```

becomes zero-length **or** dataless. Keep the existing zero-byte arm: it is
what older macOS and other transports produce, and it costs nothing.

macOS: `use std::os::macos::fs::MetadataExt; metadata.st_flags() & 0x4000_0000 != 0`.
Name the constant `SF_DATALESS` with a comment saying it is `sys/stat.h`'s
value and that no crate exposes it. Non-macOS: `false`.

The predicate takes `&Metadata` rather than a path, so it is testable without
an evicted file and so it cannot trigger the extra `stat` that TN3150 warns
materializes intermediate folders. `consider` already holds the metadata.

Test: the predicate answers false for an ordinary file's metadata and the
Verdict for a zero-byte file is unchanged (`NotYetArrived`); a normal file
still reaches `Merge`/`Echo` as before. The true case cannot be produced in a
test — say so in a comment on the test rather than faking a flag.

### Item 2 — an export never writes over bytes that are not local

`crates/notes-sync/src/export.rs::write_checked`. Today the existing file is
read to compare hashes, and an unreadable read falls through to the write.
Add, before that read: if the path exists and its metadata says dataless,
return `ExportOutcome { written: false, needs_merge: true, path }`.

`needs_merge` is the right existing signal — it already means "there is
something at that path this app must not replace, and the merge sees it
first". The watcher's read materializes the file, the merge lands it, and the
pass after that writes normally. Nothing new has to be scheduled.

Test: a fixture that stands in for the flag check. Since a dataless file
cannot be made in a test, take the smallest seam that still tests the
decision — extract the "may this path be replaced" question into a function
taking the metadata, and test that function plus one test proving a
materialized file's export still writes. Do not add a trait or a mock; a plain
function over `&Metadata` is the whole seam.

### Item 3 — one device keeps one identity across a database reset

`crates/notes-sync/src/hlc.rs` gains the derivation, because the four-hex rule
already lives there; `crates/notes-sqlite/src/worker.rs::ensure_device_id`
calls it instead of slicing a random UUID.

macOS: `libc::gethostuuid` (already a dependency of `notes-sync`; no
subprocess, microseconds, and verified on this machine to return exactly what
`ioreg`'s `IOPlatformUUID` does). Hash the sixteen bytes with `sha2` — also
already a dependency — and take four lowercase hex characters from the digest.
Never expose the raw hardware UUID anywhere: it goes in the vault's files by
way of stamps, and a hash is what keeps a machine identifier out of a
synced document. Non-macOS, or a failing call: fall back to today's random
UUID slice.

The database row stays authoritative — `ensure_device_id` still returns an
existing id untouched. Derivation happens only when provisioning, which is
what keeps a repaired logic board from retroactively renaming a device that
has already stamped rows. `man 2 gethostuuid` warns the inputs it hashes can
themselves change, and TN1103 says a serial number can vanish after a repair,
so the derived value is a better seed, never a guarantee.

Collision math is unchanged: four hex is 65,536 values either way, so this is
no worse than the random slice it replaces.

Test: the derivation answers the same four characters twice in one process and
the answer is four lowercase hex characters that `Hlc::new` accepts. Do not
assert a literal value — it differs per machine.

## Gates

Rust-only: `cargo test --workspace --no-fail-fast`, `cargo fmt --check`.
Frontend gates skipped; no frontend file changes.

## Risks

- The dataless predicate is untestable in its true state. Mitigated by keeping
  it to one flag comparison over metadata the caller already holds, so the
  part that cannot be tested is as small as a line can be.
- Item 2 makes a document wait a pass when its file is evicted. That is the
  intended trade: a delayed write against a bounced duplicate.
- A device that reinstalls macOS keeps its id where it used to get a new one.
  That is the goal, but it means an id now outlives a full data reset — worth
  saying in the settings screen eventually, not in this slice.
