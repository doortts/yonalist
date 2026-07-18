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

## Amendment: complete DAG validation and local control preflight

### RED

- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine invalid_atom_hidden_in_omitted_secondary_parent_rejects_merge -- --nocapture` failed because the malicious merge was accepted even though its omitted secondary parent introduced a policy-rejected atom.
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine side_parent_control_commits_keep_causal_boundaries_without_becoming_candidates -- --nocapture` failed because validation made two control transitions instead of the three actual commit transitions.
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test two_peer_sync duplicate_local_control_transition_writes_no_objects_or_ref -- --nocapture` failed because the duplicate revoke batch returned `Ok(())`.
- The first full pack GREEN run exposed a causal-order mismatch: incremental first-parent validation replayed the main commit before a concurrent lower-OID side commit. The test observed `[main, side, merge]` instead of `GitStore::stored_atoms` order `[side, main, merge]`.

### GREEN

Incoming validation now uses every current local advertised head as the trusted DAG exclusion boundary. Advertised-device candidates are still selected only from first-parent prefixes, but each candidate validates its complete newly reachable parent DAG. Commits use Kahn ancestry order with commit-OID ties; every actual commit validates its complete tree and introduced atoms against one pre-commit state and advances control exactly once. The all-valid multi-ref path validates the union DAG once, matching stored-atom replay and avoiding duplicate validation across advertised devices; rejected heads transactionally fall back to shorter first-parent prefixes.

`ProjectPolicy::preflight_control` provides a generic signed-atom batch transition. `Replica::append_local` invokes it after every control atom validates against the shared pre-state and before Store append, so duplicate transitions cannot write objects or move refs.

Focused GREEN evidence:

- malicious omitted-side-parent regression — 1 passed, 0 failed
- causal commit-boundary regression — 1 passed, 0 failed
- local duplicate-transition/no-write regression — 1 passed, 0 failed; reopen/rebuild remained healthy

Final verification:

- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --features test-support --test two_peer_sync` — 10 passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test pack_quarantine` — 19 passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --test git_store` — 18 passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml` — passed
- `cargo test --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features` — passed
- `cargo check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml` — passed
- `cargo check --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --all-features` — passed
- `cargo fmt --manifest-path src-tauri/crates/yonalist-sync/Cargo.toml --check` — passed
- `git diff --check` — passed

## Amendment: canonical partial-prefix union

### RED

`partial_control_prefixes_replay_as_a_canonical_union` arranged device IDs so
the old fallback visited an enabling control ref before two dependent refs,
while commit OIDs put the shared dependent side-parent before the enable in
canonical DAG order. The focused test failed because validation accepted both
dependent merge heads; that sealed union would make stored control replay
reject the dependency after promotion.

### GREEN

Partial-prefix selection now starts from the full eligible union and replays it
from the original trusted boundary and policy state on every attempt. A failed
replay reports the actual commit; every candidate whose new closure reaches
that commit rolls back to its largest earlier first-parent prefix that excludes
it. The revised union is replayed canonically until valid, so device iteration
cannot leak policy state into the sealed result. The regression retains the
unrelated enabling head, rolls both shared-side-parent candidates back to safe
prefixes, promotes successfully, rebuilds stored policy state, and reopens a
`Replica`.

Verification:

- focused regression — passed
- `pack_quarantine` — 20 passed
- `two_peer_sync` — 10 passed
- `git_store` — 18 passed
- default and all-features tests — passed
- default and all-features checks — passed
- formatting and diff checks — passed

## Amendment: complete canonical replay across the trusted boundary

### RED

`trusted_control_boundary_is_replayed_in_global_canonical_order` installed a
trusted enabling root, then advertised a lower-OID concurrent dependent root
and an unrelated safe root. The focused test failed because validation started
from the already-enabled trusted state and accepted both incoming candidates,
even though post-promotion stored-atom replay would visit the dependent first
and reject the union.

### GREEN

Every control fixed-point attempt now replays the complete trusted-plus-incoming
head union from the generic `ProjectPolicy::rebuild_control(&[])` genesis state.
It uses the same actual-DAG Kahn/OID order as stored replay while retaining the
trusted closure solely as the candidate rollback boundary. Incoming failures
rollback every candidate that newly reaches them; failures at trusted commits
conservatively rollback candidates that introduced earlier incoming commits.
Data validation remains based on the current trusted control state.

The regression rejects only the dependent candidate, preserves the trusted
enable, advances the unrelated safe ref, compares the validator's final replay
order with `stored_atoms`, rebuilds the same enabled state, and reopens a
`Replica` successfully. Focused GREEN evidence: `pack_quarantine` 21 passed,
`two_peer_sync` 10 passed, and `git_store` 18 passed.
