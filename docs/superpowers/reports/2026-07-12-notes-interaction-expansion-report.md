# Notes Interaction Expansion Final Report

**Date:** 2026-07-12  
**Branch:** `codex/notes-workflowy`  
**Final implementation commit:** `2486a19`

## Delivered Scope

- Added Notes as an isolated Yonalist feature host with local-only SQLite storage.
- Added Workflowy-style outline editing, zoom navigation, left action rails, page child creation, supporting notes, collapsed-parent emphasis, Move To, subtree expansion/collapse, stable Unicode sorting, and timestamps.
- Added root Archive, Trash, restore, duplicate, star, and navigation fallback behavior.
- Added `#` and `@` tag indexing, tag navigation, structured tag search, date tokens, date picker/ranges, and date search.
- Added unified session Undo/Redo for text, structure, lifecycle, dates, and attachments.
- Added offline PNG, JPEG, GIF, and WebP attachments, including animated GIF/WebP validation and display, aspect-ratio-preserving resize, and persisted initial width based on the Notes content area.
- Added frontmatter Markdown and PDF subtree export with attachment handling, conflict protection, snapshot consistency, atomic publication, and rollback safeguards.
- Kept collaboration, Turn Into, Board/Table, mirrors, templates, backlinks, general files, PDF attachments, and calendar pages out of the production scope.

## Architecture Result

Notes code remains owned by `src/features/notes`, `src/domain/notes.ts`, `src/services/notesStore.ts`, and `src-tauri/src/notes`. Host changes are limited to Notes registration and required Tauri capabilities. Notes uses `<vault>/.yonalist/notes.sqlite` and `<vault>/.yonalist/notes-assets`; existing Inbox, Notifications, network, and Markdown-vault behavior do not depend on Notes modules.

SQLite schema version 3 includes Archive ownership, derived tag/date indexes, attachments, and bounded session history. Migrations from versions 1 and 2 are transactional and covered by repository tests.

## Review And Rework

Each implementation phase received focused implementation review and correction before dependent work continued. The final whole-branch adversarial review found four Important issues:

1. An already-open export menu could accept an unrelated loading transition.
2. Native export could accept an archived root.
3. Animated GIF/WebP was rejected despite the approved format scope.
4. Initial image width stored intrinsic width instead of the measured Notes width.

A second reviewer independently validated all four findings. They were corrected in `73720cb`, `4d39aae`, `c4fc25d`, and `5fe313d`. The corrected diff was re-reviewed with no remaining findings and an `APPROVE` verdict.

## Functional Verification

| Check | Result |
| --- | --- |
| Frontend test suite | 117 files passed, 1 skipped; 2,060 tests passed, 21 skipped |
| Rust test suite | 283 passed, 1 opt-in performance test ignored |
| Production frontend build | Passed; 2,297 modules transformed |
| Rust formatting | Passed |
| Rust Clippy | Passed with five pre-existing advisory warnings; no MSRV warning remains |
| Corrected-finding focused re-review | Approved; 331 frontend, 28 attachment, 85 export, and 82 contract tests passed |
| Worktree integrity | Clean; `git diff --check` passed |

The build retains the existing warning that the main minified application chunk is above 500 kB.

## Performance Verification

The Rust release benchmark passed all 14 gates at 1,000 and 10,000 nodes. The highest normalized p95 ratio was `1.02`, below the `1.20` regression limit.

| 10,000-node workload | p95 |
| --- | ---: |
| Active load | 19.918 ms |
| Tag AND/OR/NOT | 14.110 ms |
| Date range | 9.103 ms |
| Archive | 295.673 ms |
| Unarchive | 136.973 ms |
| Mutation + Undo | 54.853 ms |
| History eviction | 20.450 ms |

The frontend pure-function benchmark produced medians generally within about 0-10% of its recorded baselines, but its wall-clock p95 gate was not stable on the final host. Repeated runs failed different labels while WindowServer and unrelated processes preempted the benchmark; a controlled idle interval confirmed that wall time increased without corresponding process CPU use. A proposed CPU-time replacement was rejected because it was not directly comparable to the existing wall-clock baselines. No threshold or baseline was weakened. This is a benchmark-methodology residual risk, not evidence of a repeatable product regression.

## Visual Verification

- The native Tauri app rendered the Workflowy-style dark outline with left library navigation, hierarchy guides, tags, compact bullets, and the collapsed-parent emphasis without visible overlap at 1280 x 820.
- The responsive shell was checked at 390 x 844 without incoherent overlap.
- Browser-only Vite preview cannot exercise Notes persistence because Notes intentionally requires the Tauri storage commands; native desktop is the functional Notes surface.

## Residual Risks

- Failed or interrupted overwrite export may retain identity-protected rollback or staging directories for later manual/future cleanup.
- Windows no-replace export code is covered by conditional tests but was not executed on a Windows host in this run.
- The frontend wall-clock performance p95 harness is sensitive to host scheduling noise as described above.
- PDF export uses the first composited frame of animated GIF/WebP; Markdown and the app preserve original animation bytes.

## Deferred Follow-up

- Turn Into and node types: headings, paragraph, to-do, numbering, quote, code block, and divider.
- Board and Table layouts.
- Collaboration, comments, sharing, permissions, and synchronization.
- Mirrors, templates, internal links, and backlinks.
- General file and PDF attachments.
- Calendar pages, Move to Today/Tomorrow/Next week, and native mobile gestures.
