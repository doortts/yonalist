# Task 4 report: quarantined Git packs

## RED

Added `pack_quarantine` integration tests before the pack API existed. The initial
run failed at compile time with unresolved `PackLimits`, `PackRequest`,
`CandidateRef`, `create_pack`, `validate_pack`, and `promote_pack`, as expected.

## GREEN

Implemented `pack.rs` with:

- `pack-objects --stdout --revs --thin` creation using exact wants and haves.
- Size/ref limits, empty/duplicate request rejection, and post-output byte checks.
- A deterministic PID/counter named SHA-256 bare quarantine repository with a
  canonical trusted-object alternate; all validation reads happen there.
- Per-device ancestry, complete-tree, immutable-path, atom codec/signature,
  plane/device/path, count, and policy validation. Validation returns the
  largest valid prefix and records the first rejection code.
- Promotion that imports only after validation, then uses one `update-ref
  --stdin` transaction with old-OID compare-and-swap values for every ref.
- Quarantine session cleanup after both success and failure paths.

`update-ref` rejects a separate `verify` and `update` command for the same ref
as a duplicate transaction update. The `update <ref> <new> <old>` form is Git's
atomic CAS verification and update operation, so the single transaction still
has no partial ref movement on any failed compare-and-swap.

## Evidence

Initial RED command:

```text
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine -- --nocapture
```

Final checks passed:

```text
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine
# 3 passed
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml
# 28 tests passed plus doc tests
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
# 28 tests passed plus doc tests
cargo fmt --check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml
git diff --check
```

The focused tests cover corrupt-pack isolation, successful promotion, and a
policy-rejected second commit retaining and promoting only its valid ancestor.
