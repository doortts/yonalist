# Image Task 5 Review Fix Report

## Status

DONE

## Review Findings

1. Added required `importAttachmentPaths` and `importAttachmentBytes` mocks to the two owned, complete `NotesStore` fixture factories.
2. Aligned `notesStore` attachment history `commandKind` validation with the raw encoder and Rust by trimming first and enforcing 1..128 UTF-8 bytes.
3. Changed source-path batch preparation to collect every invalid file as `filename: reason`, while returning before any attachment publication when at least one source is invalid.

## TDD Evidence

- The initial TypeScript build failed on the two incomplete owned `NotesStore` fixtures.
- The new Korean 129-byte regression test failed because the path request reached native IPC and the raw request failed later as a retryable encoder error.
- The new Rust command test failed because only the first invalid source reason was returned.
- Each focused regression passed after its corresponding minimal implementation change.

## Verification

- Focused TypeScript: 5 files, 135 tests passed.
- Focused Rust attachment tests: 39 tests passed, including no-follow symlink/FIFO and remaining-byte budget coverage.
- `cargo check`: passed.
- `cargo fmt --check`: passed after formatting the new test.
- `npm run build`: passed. Vite emitted its existing large-chunk advisory only.

## Commit Scope

Included only Task 5-owned implementation/tests and this report. The Task 6-owned `useNotesWorkspace.ts` and `useNotesWorkspace.test.tsx`, the protected spec change, and the Vault migration plan were not staged.

## Concerns

No blocking Task 5 concerns. Unrelated concurrent work remains present in the shared worktree and is intentionally outside this commit.
