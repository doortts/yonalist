# Task 5 report: control-first peer pulls

## RED

Added `two_allowed_peers_converge_and_second_pull_is_empty` before the production
types existed. The required feature-gated test command failed with unresolved
`FixturePair` and `InProcessPeer` imports, establishing the intended public
contract.

## GREEN

Added a synchronous `PeerEndpoint` protocol boundary and a generic `Replica`
that always executes hello, control pull, policy rebuild, local access, and
only then an allowed data pull. `pull_plane` deduplicates haves, rejects an
oversized advertisement, avoids pack creation for already-local heads, and
uses the existing sealed validate/promote boundary. Local appends rebuild and
validate policy state, require local identities/frontiers, and use the current
local ref as their CAS expected head.

The feature-gated fixture layer uses fixed keys, identifiers, and event times;
the owner key is its out-of-band trust anchor. Grants/revokes are canonical
CBOR and signature/role checked. The in-process endpoint only delegates to
public source advertise/create-pack methods and records phase counts.

## Tests

- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test two_peer_sync`
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml`
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features`
- `cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --check`
- `git diff --check`

The focused suite covers allowed convergence/idempotency, denied-ack
control-only phase behavior and counters, and offline two-direction convergence.

## Self-review

No refs are mutated by the transport fixture; all imported refs go through the
sealed store-bound pack validation and promotion path. The control phase is not
skipped for a denied ack. No network, relay, UI, SQLite, or revocation-flow
features were added.

## Amendment: review hardening

### RED

- Exact owner-genesis and device-bound grant tests first failed to compile
  because control grants and `ProjectPolicy` access checks lacked `DeviceId`.
- Duplicate/regrant/unknown-revoke and anchor-escalation cases failed under the
  permissive fixture transition logic.
- `stored_atoms_follow_causality_not_event_path_order` returned the lower
  `EventId` first even though its containing commit was causally later.
- The original allowed-pull test advanced zero control refs after strict
  genesis was enabled, proving pack validation did not advance policy state
  between first-parent commits.
- The oversized local append test returned `Ok(())`, proving configured
  `AtomLimits` were not applied before store append.
- The aliased-device-ref test advanced zero refs when the target object already
  existed under another device ref.
- Genuine offline divergence initially made `pack-objects` reject an unknown
  receiver-only have, then exposed colliding fixture event IDs across devices.
- The admin-revoke import test first rejected the member role, then exposed the
  fixture counter reset across preflight rebuilds.

### GREEN

`ProjectPolicy` now has the narrow generic
`advance_control(state, commit_atoms)` transition hook and device-aware access
checks. Pack validation validates all newly introduced atoms in a commit against
one pre-commit state, advances only after acceptance, and preserves sealed
promotion. `GitStore::stored_atoms` uses causal Kahn order with canonical OID
tie-breaking for concurrent commits. Fixture genesis is exact and one-shot;
grant IDs cannot be reused, revokes must target an active known grant, and
member/device/grant/key binding is exact.

Pull wants are deduplicated per advertised device ref that differs locally;
haves are limited to heads also advertised by the source, and combined limits
are checked locally. Reduced frontiers are ancestor-minimized, deduplicated,
and canonically sorted. Local atoms are bounded-encoded before validation and
append. Fixture event IDs use device-separated monotonic ranges and survive
pulls and reopen.

### Amended verification

- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test two_peer_sync` — 9 passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_store` — 18 passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine` — 17 passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml` — passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features` — passed
- `cargo check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features` — passed
- `cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --check` — passed
- `git diff --check` — passed
