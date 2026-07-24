# Notes Data Repair

## Contract

### Goal

A user whose Notes workspace cannot load because persisted ordering data is
outside JavaScript's safe-integer range can repair the Vault from inside the
app without deleting notes or attachments.

### Acceptance

| Scenario | Expected result |
| --- | --- |
| Notes write authority is unknown | The error banner offers `Repair Notes data` alongside the existing retry action. |
| The user opens **Settings → Notes data** | The same repair action is available in release and development builds. |
| Unsafe recovery sort keys exist | The app backs up every Notes Markdown file it will overwrite, preserves ordering, writes safe sort keys, and reports the number of repaired nodes and backup files. |
| No unsafe sort keys exist | The command makes no backup or data change and reports that it found nothing to repair. |
| Repair succeeds | Notes reloads from the repaired data and editing becomes available again. |
| Repair fails at any stage | Editing stays paused, the error is shown, source files are not deleted, and completed backups are retained. |
| A later merge creates recovery nodes | Every generated recovery sort key is within JavaScript's safe-integer range. |

### Non-goals

- Do not delete Notes, attachments, Trash history, or unrelated Vault files.
- Do not accept imprecise integers in the frontend.
- Do not renumber unaffected nodes.
- Do not turn this action into a general-purpose Markdown repair tool.
- Do not guess how to rewrite unsafe sort keys that were not produced by the
  known recovery-key bug.
- Do not add a new Notes file-format or SQLite schema version.

### Boundaries

- React: error-banner and Notes data settings entry points, confirmation,
  progress, success, and failure states.
- TypeScript service layer: typed IPC result validation.
- Tauri IPC: one repair command shared by both entry points.
- Rust/SQLite: detection and targeted legacy recovery-key repair.
- Filesystem: verified backups and atomic publication of affected Notes
  Markdown files.
- Sync runtime: stop before maintenance and restart or reload only after the
  repaired workspace passes validation.

### Manual proof

1. Start the desktop app with a test Vault containing a Notes topic whose
   `sort_key` is greater than `9_007_199_254_740_991`.
2. Confirm that Notes pauses editing and shows the repair action.
3. Run the repair from the error banner.
4. Confirm that Notes reloads, keeps the same visible order and content, and
   allows editing.
5. Confirm that the affected source file has a backup and now contains a safe
   sort key.
6. Reset the local Notes database and confirm that the repaired Vault still
   loads.

## Chosen approach

Use a targeted native repair. The command scans merged Notes rows for sort keys
outside JavaScript's safe-integer range. It repairs a value only when the value
matches the legacy 60-bit recovery key derived from that node's UUID. The
replacement uses the first 52 UUID bits. Truncating the same UUID prefix keeps
the deterministic ordering of recovered nodes, while the node ID remains the
tie-breaker. Unaffected nodes are not changed.

If the scan finds an unsafe value that does not match the known legacy
recovery-key calculation, it stops before making a backup or data change and
reports that the problem needs a different repair.

Before publishing any changed topic or Trash document, the command copies the
exact affected source files into a timestamped directory under
`.yonalist/notes-repair-backups/`. It then commits the SQLite changes and uses
the existing Notes export path to publish canonical Markdown atomically. A
repair report contains:

- `repairedNodeCount`
- `backedUpFileCount`
- `backupPath`, or `null` for a no-op

The command is idempotent: after a successful repair, running it again returns
a no-op report.

This approach is preferred to accepting unsafe numbers in the frontend, which
would silently lose ordering precision, and to reindexing the entire Vault,
which would create unnecessary synchronization churn.

## User experience

### Error banner

When write authority is unknown, the banner keeps `Retry recovery` and adds
`Repair Notes data`. The repair action opens a confirmation dialog explaining
that the app will back up and repair Notes ordering data without deleting
notes or attachments.

While repair runs, both actions are disabled and the repair button reads
`Repairing...`. On success, the workspace is reloaded and an inline status
reports the repaired node count and backup location. On failure, the existing
error area shows the failure and editing remains paused.

### Notes data settings

Add a release-visible `Repair Notes data` section above the development-only
database reset. It uses the same confirmation, command, pending state, and
result wording as the error banner. The destructive database reset and full
deletion actions remain separate.

## Repair flow

1. Quiesce Notes writes. Flush pending drafts when a valid workspace had
   already loaded; if no workspace loaded, proceed because there is no editable
   draft state. A genuine unsaved-edit failure stops before maintenance and
   shows the existing error.
2. Stop the folder-sync runtime for the selected Vault.
3. Acquire and revalidate the Vault application lock.
4. Inspect persisted node sort keys. Abort without changes if an unsafe value
   was not produced by the legacy 60-bit recovery-key calculation.
5. Identify the legacy recovery values. If none exist, restart sync and return
   a no-op report.
6. Determine every topic or Trash file that the repair will overwrite.
7. Copy and verify those exact files in the timestamped backup directory.
8. Replace only the affected values in one SQLite transaction, mark their
   owning documents dirty, and publish them through the existing atomic export
   path.
9. Validate that the resulting workspace contains only safe integers.
10. Restart sync, reload Notes, and return the report.

If the operation fails before the SQLite transaction commits, no database
change is retained. If an export fails after the commit, the command restores
the old database values and any already-published files from the verified
backups before returning an error. If restoration itself fails, sync remains
stopped and the error names the backup location. A retry is safe because the
repair is deterministic and idempotent.

## Preventing recurrence

`deterministic_recovery_sort_key` currently derives a 60-bit value from a UUID.
Rust can store it in `i64`, but JavaScript cannot represent every such value
exactly. Derive no more than 52 bits and keep the deterministic UUID-based
ordering. Add a unit test using UUIDs whose current 60-bit prefixes exceed
JavaScript's maximum safe integer.

## Testing

### Rust

- The deterministic recovery key is stable and never exceeds
  `9_007_199_254_740_991`.
- A Vault with legacy unsafe root and child recovery keys repairs only affected
  nodes while preserving order and content.
- An unrelated unsafe value aborts without creating a backup or changing data.
- Affected source files are backed up byte-for-byte before publication.
- A second repair is a no-op.
- Backup, transaction, export, and validation failures do not report success.
- The IPC command stops sync and is registered exactly once.

### TypeScript and React

- The service rejects malformed repair reports.
- The unknown-authority banner exposes the repair action, disables actions
  while pending, and reports success or failure.
- Notes data settings exposes the same action in release builds.
- Changing Vaults during an in-flight request cannot apply the old result to
  the new Vault.
- Existing retry, database-reset, deletion, and attachment-cleanup behavior
  remains unchanged.

### Final verification

Run focused Rust and React tests first. After the diff is frozen, run the full
frontend tests, lint, build, Rust tests, Rust formatting check, and
`git diff --check`. Finish with the manual desktop scenario above using a
freshly built app and an isolated test Vault.
