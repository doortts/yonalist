# Image Task 9 Attachment Boundary Report

## Scope

Owned files only:

- `src-tauri/src/notes/attachment_ingest.rs`
- `src-tauri/src/notes/attachments.rs`
- `.superpowers/sdd/image-task-9-boundary-report.md`

The pre-existing protected design document, Vault migration plan, and concurrent changes in `src-tauri/src/notes/commands.rs` were not staged or modified intentionally for this task.

## Implemented Proof

- `notes::attachment_ingest::tests::raw_envelope_accepts_exact_64_mib_batch_and_preserves_source_slice_boundaries`
  - Ignored in normal runs because it allocates an exact 64 MiB raw body.
  - Exercises the production envelope decoder with declared item lengths of 20 MiB, 20 MiB, 20 MiB, and 4 MiB.
  - Verifies acceptance at exactly 67,108,864 bytes, source order, exact slice lengths, first/last source markers, contiguous boundaries, and pointers borrowed from the original envelope.
- `notes::attachment_ingest::tests::raw_envelope_rejects_exact_64_mib_plus_one_before_publication`
  - Exercises the production decoder with declared item lengths of 20 MiB, 20 MiB, 20 MiB, and 4 MiB + 1.
  - Supplies no image body, proving rejection occurs from declared aggregate metadata before source slicing or any later preparation/publication stage.
  - Requires the exact batch error: `Notes attachment batches must contain at most 67108864 image bytes.`
- `notes::attachments::tests::notes_attachment_default_pixel_ceiling_accepts_40m_and_rejects_40m_plus_one`
  - Exercises `ValidationLimits::DEFAULT` through the production `validate_decoded_dimensions` predicate.
  - Accepts 8,000 x 5,000 = 40,000,000 pixels and rejects 40,000,001 x 1 without allocating an image bitmap.
  - Requires the exact pixel error: `Notes attachment images must contain between 1 and 40000000 decoded pixels.`
- `notes::attachments::tests::notes_attachment_dimension_limit_rejects_zero_and_overflow`
  - Rejects zero width, zero height, and checked multiplication overflow.
  - Requires the exact overflow reason: `The Notes attachment decoded pixel count is too large.`

The production helper replaces the duplicated full dimension-limit predicate in GIF container inspection and final decoded-image validation. Existing limits and error text are unchanged. Animated WebP's earlier work-accounting path remains unchanged, preserving its existing error precedence.

## TDD Evidence

The aggregate tests characterized the existing decoder first. The exact 64 MiB + 1 test passed immediately against production behavior, so no decoder change was needed.

The pixel helper extraction began red with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment_default_pixel_ceiling_accepts_40m_and_rejects_40m_plus_one -- --exact --nocapture
```

Result: exit 101 with Rust error `E0432`, unresolved import `super::validate_decoded_dimensions`. After adding the minimal helper and routing the existing predicates through it, both focused pixel tests passed.

## Verification

Formatting:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Result: both exited 0; the check produced no output.

Focused debug rejection:

```sh
cargo test --manifest-path src-tauri/Cargo.toml notes::attachment_ingest::tests::raw_envelope_rejects_exact_64_mib_plus_one_before_publication -- --exact --nocapture
```

Result: exit 0; 1 passed, 0 failed, 337 filtered out; test execution finished in 0.00s.

Focused debug pixel boundary:

```sh
cargo test --manifest-path src-tauri/Cargo.toml notes::attachments::tests::notes_attachment_default_pixel_ceiling_accepts_40m_and_rejects_40m_plus_one -- --exact --nocapture
```

Result: exit 0; 1 passed, 0 failed, 337 filtered out; test execution finished in 0.00s.

Focused debug zero/overflow:

```sh
cargo test --manifest-path src-tauri/Cargo.toml notes::attachments::tests::notes_attachment_dimension_limit_rejects_zero_and_overflow -- --exact --nocapture
```

Result: exit 0; 1 passed, 0 failed, 337 filtered out; test execution finished in 0.00s.

Exact memory-heavy release acceptance:

```sh
cargo test --release --manifest-path src-tauri/Cargo.toml notes::attachment_ingest::tests::raw_envelope_accepts_exact_64_mib_batch_and_preserves_source_slice_boundaries -- --ignored --exact --nocapture --test-threads=1
```

Result: exit 0; 1 passed, 0 failed, 337 filtered out; test execution finished in 0.01s. The recompiling release run elapsed 23.68s; a final post-staging cached rerun also exited 0 and completed the release profile in 0.29s.

Full attachment-ingest module:

```sh
cargo test --manifest-path src-tauri/Cargo.toml notes::attachment_ingest::tests -- --nocapture
```

Result: exit 0; 14 passed, 0 failed, 1 ignored, 323 filtered out; finished in 0.11s. The only ignored test was the exact 64 MiB release case above.

Full attachments module:

```sh
cargo test --manifest-path src-tauri/Cargo.toml notes::attachments::tests -- --nocapture
```

Result: exit 0; 33 passed, 0 failed, 0 ignored, 305 filtered out; finished in 1.81s. Expected injected cleanup warnings were printed by existing failure-path tests.
