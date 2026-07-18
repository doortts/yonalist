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

## Security review amendments

The public-field `ValidatedPack` sketch contradicted the promotion security
boundary: callers could forge or mutate the authorization consumed by
`promote_pack`. The safer minimal API is now intentional: all authorization
fields are private, the type is neither `Clone` nor mutable by callers, and
only immutable `accepted()` and `rejected()` inspection is exposed. Compile-fail
doctests prove direct construction and cloning remain unavailable.

### RED

Before implementation, the expanded integration suite failed to compile with
`no method named accepted/rejected found for struct ValidatedPack`, proving the
old public-field API did not provide the sealed inspection contract:

```text
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine --no-run
# FAILED: 15 E0599 errors for the missing immutable accessors
```

The focused signature test also failed against the permissive fixture policy,
proving a corrupt signature could be accepted unless the policy performed the
required verification:

```text
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine invalid_atom_signature_is_rejected_by_validation_policy -- --nocapture
# FAILED: validated.accepted().is_empty() assertion
```

The final review-driven RED cycle reproduced three additional boundary defects:
an invalid first commit after an existing head emitted a no-op candidate; a
validated token could be transplanted to another store; and recursive blob-only
tree inspection hid an empty subtree. Each focused command failed its intended
assertion before the corresponding implementation change.

### GREEN

The amended implementation and tests now cover sealed promotion authorization;
strict oldest-first first-parent prefixes (including side-parent exclusion and
first-parent rewind); complete-tree removal/replacement immutability; shared
Task 3 atom/text path validation; cross-device complete trees; first-invalid
rejection without a candidate; corrupt packs; schema, plane, signature, atom,
ref, and pack limits; atomic multi-ref CAS; exclusive PID/counter session
allocation with collision retry; deterministic cleanup success/failure; and
lossless Unix alternates encoding with newline rejection.

Fresh final verification:

```text
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine
# 17 passed
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml
# 48 unit/integration tests passed; 2 compile-fail doctests passed
cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
# 48 unit/integration tests passed; 2 compile-fail doctests passed
cargo check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features
# passed
cargo fmt --check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml
# passed
git diff --check
# passed
```
