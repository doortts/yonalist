# Distributed Local-First Issue Tracker Design

**Date:** 2026-07-18

**Status:** Approved by the user

## Goal

Build a project issue tracker that remains fully writable while offline and
shares issues, comments, state, references, membership, and attachments between
project members without requiring one authoritative server.

Every Yonalist client owns a local project replica. Connected clients exchange
missing immutable changes directly. An optional always-on relay is another
replica that improves store-and-forward delivery and may build a read-only web
view. Removing that relay must not stop local work or peer-to-peer sync.

The target project has about 20 members normally and up to 100 members. Source
code is outside this design; the distributed project contains only issue-tracker
data and attachments.

## Confirmed Product Contract

- Local work never waits for the network.
- The application is the only supported writer. Users do not edit or merge the
  internal Git repository with ordinary Git clients.
- Git is an embedded storage and transfer engine, not a user-facing workflow.
- Issues, comments, issue state, project metadata, and membership are replicated
  to every active client.
- Attachments up to a project-configured size are automatically replicated.
  Larger attachments are fetched on demand or explicitly pinned for offline use.
- The default automatic-attachment threshold is 10 MiB. An admin can change it
  per project.
- An optional relay can be absent. Central-less synchronization remains possible
  over a directly reachable peer, a local network, or an exported bundle.
- An optional trusted relay can provide a read-only emergency web view.
- Concurrent work is never silently discarded. Safe cases merge automatically;
  unresolved cases show the common base and every version so a user can produce
  an explicit merged revision.
- Any owner or admin may invite, remove, and change the role of project members.
- A client that learns it has been removed locks the project, stops sharing, and
  directs the user to contact an administrator.
- Membership revocation is cooperative application policy, not DRM. The system
  does not claim to erase already copied data or resist a modified client.
- A project may optionally lock after a configured number of days without a
  successful membership check. This offline-access lease is disabled by default.

## Non-Goals

- Replicating a source-code repository.
- Providing sequential, centrally allocated issue numbers.
- Making a relay or database the source of truth.
- Supporting arbitrary manual edits inside the internal Git repository.
- Cryptographically revoking previously distributed project material.
- Rotating an epoch encryption key after membership changes.
- Guaranteeing direct connectivity between two unrelated NATed internet clients
  without a reachable endpoint or relay.
- Collaborative character-by-character rich-text editing in the first version.

## Selected Architecture

Each project is composed of four layers:

```text
Yonalist commands and UI
        |
        v
signed immutable domain atoms
        |
        v
internal bare Git repository       attachment sidecar
refs + commits + trees + blobs     content-addressed chunks
        |                                  |
        +----------------+-----------------+
                         v
                derived projections
        in-memory state + optional search cache
```

The Git repository and attachment sidecar are authoritative. Projections are
disposable and are never synchronized as primary data.

The Rust backend exposes a `GitEngine` boundary. The first implementation ships
a pinned Git plumbing implementation with the application and does not depend
on the user's installed Git. It invokes Git without a shell, with an explicit
Git directory and sanitized configuration; repository hooks and user-provided
remote commands are disabled. The implementation plan may wrap this plumbing in
a Rust library, but it must preserve the storage, pack, bundle, and three-way
merge behavior in this design.

## Workspace and Repository Layout

The application owns a workspace resembling:

```text
<workspace>/
  catalog.cbor
  projects/
    <project-id>.git/                 # bare internal repository
  attachments/
    <project-id>/
      chunks/<content-hash>
      temp/
  cache/
    <project-id>/
      projection.cbor                 # optional, disposable
      search.sqlite                   # optional FTS cache, disposable
```

`catalog.cbor` is local device state. It records repository locations and local
presentation settings; it is not a global synchronized project list. The
visible project list is derived from repositories present on the device and the
membership projection in each repository. Active projects appear normally;
locally retained revoked or lease-locked projects remain as locked catalog
entries without exposing their contents.

Each bare repository uses internal refs:

```text
refs/yonalist/control/<device-id>
refs/yonalist/data/<device-id>
refs/yonalist/checkpoints/<frontier-hash>   # optional disposable accelerator
```

Control refs contain project genesis, membership, roles, and device
certification. Data refs contain issues, comments, state, project settings,
references' source bodies, and attachment manifests. This split makes it
possible to fetch and apply revocation state before deciding whether ordinary
project data may be exchanged.

Each device may advance only its own control and data refs. Updates must be
descendants of the previously accepted corresponding head; force updates and
history rewrites are rejected. An accepted remote head is installed only after
its reachable objects and atoms pass validation.

When a device records a local data batch, the commit parents are its previous
data head and the minimal data frontier of trusted peer heads it has observed.
A control batch uses the equivalent control frontier. Heads already reachable
from another parent are removed from either frontier. The commit tree is the
union of immutable, globally unique atom paths known by that device, so joining
histories does not invoke user-file textual merge.

Repository trees contain small immutable data:

```text
genesis/project.cbor
control-atoms/<first-two-id-chars>/<event-id>.cbor
data-atoms/<first-two-id-chars>/<event-id>.cbor
texts/<first-two-hash-chars>/<sha256>.md
```

Bodies remain Markdown Git blobs so the embedded Git three-way merge machinery
can compare them. Git object IDs provide storage integrity and deduplication;
domain signatures independently provide authorship and authorization.

## Security Boundary

Version 1 stores project Git objects and attachment chunks in the application-
controlled workspace without project-level end-to-end encryption. It relies on
OS account protections for data at rest, and deployments should enable platform
full-disk encryption. Peer and relay connections must be authenticated and
transport-encrypted.

This choice keeps Git object transfer, deduplication, bundles, and Markdown
three-way merge straightforward and matches the explicitly cooperative
revocation model. A future opaque-relay encryption layer is a separate feature;
it cannot also render a web view unless the relay receives reader keys.

Identity and authorization still use signatures:

- a member ID is derived from a member public key;
- a member key certifies one or more device signing keys;
- a membership grant binds a member ID to a project role; and
- every domain atom is signed by the authoring device and names its membership
  grant.

## Common Atom Envelope

Every primary change is a canonical CBOR atom with the following envelope:

```text
schema                 "yonalist-event/1"
event_id               UUIDv7; uniqueness only, never conflict authority
project_id             globally unique project ID
entity_kind            project | member | issue | comment | attachment
entity_id              globally unique entity ID
operation              typed operation name
actor_member_id        signing member
actor_device_id        signing device
membership_grant_id    grant used to authorize the operation
control_frontier       reduced set of observed control-head commit IDs
data_frontier          reduced set of observed data-head commit IDs
display_time           author clock, used only for presentation
payload                typed CBOR value or a Markdown content reference
signature              signature over every preceding canonical field
```

Git commit ancestry and the two frontiers decide whether one operation observed
another and which membership state authorized it. Wall-clock values never
decide conflict winners. Control atoms omit `data_frontier` because membership
authorization never depends on ordinary issue data.

The event file path is derived from `event_id`. A second atom using the same ID
with different bytes is invalid. Unknown schema versions remain quarantined and
produce an application-update requirement rather than partial interpretation.

## Domain Units

### Project

The genesis object creates the project ID, initial owner, format version, and
initial settings. Later changes are atoms:

```text
project.field.revised
project.attachment-policy.changed
project.offline-lease-policy.changed
owner.transferred
```

Concurrent changes to the same semantic field remain separate heads and require
the same explicit resolution used by issue scalar fields. Settings on different
fields combine automatically.

### Project Membership

Membership is a priority control log:

```text
member.granted
member.role.changed
member.revoked
device.certified
device.revoked
```

Roles are:

- `owner`: all admin permissions plus ownership transfer;
- `admin`: invite, remove, and change roles, and ordinary project work;
- `member`: ordinary issue-tracker work; and
- `reader-service`: read-only projection for an optional web relay.

An admin may manage members and other admins but may not revoke the owner. The
owner changes through an `owner.transferred` atom signed by the current owner.
Role-change atoms cannot assign `owner`; ownership transfer is the only path.

For one membership grant, revocation wins over a concurrent role change.
Concurrent role changes choose the lower-privilege role until an admin who has
observed both writes a new role change. Re-inviting a removed person creates a
new grant ID; it does not undo the old revocation.

### Issue

An issue has one immutable identity and independently revised fields:

```text
issue.created
issue.title.revised
issue.body.revised
issue.state.changed
issue.relationship.added
issue.relationship.removed
issue.tombstoned
```

The canonical ID is the full project ID and issue UUID. The UI displays a short
Crockford Base32 alias derived from the UUID and extends it if a local collision
occurs. References always contain the full IDs, so offline issue creation never
requires a shared sequence allocator.

Labels and assignees use observed-remove sets. A remove atom names the add atoms
it observed; a truly concurrent unseen add remains. Different issue fields
combine automatically.

### Issue State

State changes are semantic revisions, not overwrites. A causally later state
supersedes an earlier state. Concurrent incompatible transitions remain multiple
heads and put the issue in a visible conflicted state. The issue appears in the
conflict view and in every relevant state filter until a member writes an
`issue.state.resolved` atom naming all state heads and the selected state.

The activity timeline retains every transition and resolution.

### Comment

A comment is an independent entity attached to an issue:

```text
comment.created
comment.body.revised
comment.tombstoned
comment.body.merged
```

Independent comment creation is a set union and never conflicts. Concurrent
edits of one comment body follow the text merge policy. A tombstone hides the
current comment even when concurrent with an edit, but all revisions remain in
history. Replies name the parent comment ID.

### References

Issue and comment Markdown use stable URIs:

```text
yonalist://<project-id>/issue/<issue-id>
yonalist://<project-id>/comment/<comment-id>
```

Reference edges are derived, not primary atoms. Each client parses every active
body revision deterministically and builds forward links and backlinks. A
missing target renders as an unresolved placeholder and becomes live when the
target atom arrives. While a body conflict is unresolved, edges from all active
heads are indexed with a conflict marker; after resolution, only the resolved
body supplies active edges.

Cross-project references reveal only their stored display snapshot until the
viewer has that target project and an active membership.

### Attachments

An attachment atom contains:

```text
attachment_id
owning entity and body revision
original filename
media type
byte length
whole-file SHA-256
ordered chunk hashes and lengths
```

The manifest is a Git atom. File bytes live in the content-addressed sidecar so
large files do not ride every Git fetch. Chunks are written to a temporary path,
hashed, made durable, and atomically renamed before the manifest atom may commit.
An interrupted add can leave only unreferenced chunks, never a durable manifest
that lacks its creator's local bytes.

On manifest receipt:

- files at or below the project threshold are requested automatically;
- larger files remain metadata-only until opened or pinned;
- transfers resume by missing chunk and verify every chunk hash; and
- locally observed holder counts are ephemeral availability information, not
  synchronized truth.

Attachment removal is a tombstone. Version 1 performs no automatic destructive
historical-blob garbage collection. A future explicit storage optimizer must
show its retention consequences before deleting chunks.

## Text Merge and Conflict UX

Text revisions name their base revision and Markdown blob. For current revision
heads:

1. If one head causally descends from all others, it is current.
2. If heads are concurrent, find their common base and run the protocol-pinned
   Git-compatible three-way line merge.
3. Non-overlapping changes produce a deterministic virtual clean merge.
4. Overlapping hunks create a visible unresolved conflict.

The protocol names the merge algorithm and fixtures as
`git-merge-file/myers/v1`. Every supported client version must pass the same
golden merge fixtures. A subsequent edit of a virtual clean merge names every
input head and stores the complete edited result, turning it into an explicit
revision.

An unresolved editor shows:

- the common base;
- each complete authored version, author, and causal context;
- per-hunk choices for either version, both versions, or direct editing; and
- an editable result preview.

Completing the merge writes a new atom:

```text
issue.body.merged {
  base: <revision-id>,
  parents: [<revision-a>, <revision-b>, ...],
  content: <markdown-blob-hash>,
  resolution: "user"
}
```

All parents remain reachable. If a previously unseen third head arrives later,
the merged revision and that third head enter the same process again. Concurrent
scalar changes such as title edits use a simpler side-by-side selector rather
than a line merge.

## Local Write Path

Saving locally is independent of connectivity:

1. Validate the command against the current local projection and membership.
2. Create and sign one or more domain atoms.
3. Write referenced Markdown blobs and event blobs.
4. Create a commit with the prior local data head and reduced observed data
   frontier as parents, and record the current control frontier in each atom.
5. Atomically advance the local device data ref using compare-and-swap.
6. Report the command saved and update the projection.

The data-ref update is the commit point. A projection failure after that point
does not roll back the user command; the projection is rebuilt. A crash before
the ref update may leave unreachable objects that later maintenance can remove.
Membership commands use the same steps against the local control ref.

No Git outbox is needed. The difference between local device heads and observed
peer heads is the pending synchronization state.

## Discovery and Transport

All transports carry the same project handshake and Git/object protocol behind
one adapter boundary:

- local-network discovery and direct authenticated connections;
- an explicit peer address learned from an invite;
- an optional WebSocket/HTTP relay peer for rendezvous and store-and-forward;
  and
- full or incremental bundle files for disconnected transfer.

An invite package contains the project ID, genesis identity, signed membership
grant, public member/device certificates needed for authentication, and optional
peer or relay hints. It never contains a private identity key and does not have
to contain project history. An air-gapped bootstrap packages the invite with a
full Git bundle and selected attachment chunks.

Without a relay, two clients must become directly reachable, meet on a local
network, or exchange a bundle. The design does not hide this physical
connectivity requirement.

## Synchronization Flow

When two replicas connect:

1. Negotiate protocol and schema versions.
2. Authenticate project, member, grant, and device identities.
3. Exchange and validate `refs/yonalist/control/*` first.
4. Apply any valid revocation notice before sharing ordinary project data.
5. If both grants remain active, exchange `refs/yonalist/data/*` and object IDs.
6. Negotiate and transfer only missing Git objects as a pack.
7. Store the pack in a peer-specific quarantine object directory.
8. Verify Git reachability, append-only control/data refs, atom schemas and
   limits, signatures, causal authorization, payload hashes, and entity
   invariants.
9. Promote valid objects and atomically update accepted control/data refs.
10. Fold new atoms into projections and detect conflicts.
11. Exchange attachment availability and request chunks required by local
    automatic-replication and pin policies.

The receiver advances a candidate ref only through its largest fully valid
ancestor. It blocks the invalid commit and its descendants without damaging
current trusted refs or other projects. Duplicate objects and events are
harmless. Interrupted Git transfers may restart negotiation. Attachment
transfers resume at chunk boundaries. An unknown control schema blocks ordinary
data exchange because current membership cannot be established safely.

## Membership Revocation and Offline Lease

An admin removes a member by appending a signed `member.revoked` atom. Control
log sync has priority over project data.

A peer that knows the remote grant is revoked:

1. refuses Git ref, object, and attachment sharing;
2. still sends the minimum signed revocation notice;
3. records the denied connection; and
4. closes the project session.

A normal removed client verifies the notice, closes editors, stops background
sync, marks the project `access-revoked`, and replaces its project UI with an
explanation and administrator contact guidance. It preserves local files but no
longer exposes them through the application. Unsynchronized work from that
client is not automatically uploaded after the revocation is learned.

Events already replicated before revocation remain project history. A stale peer
that has not yet learned the revocation may briefly share data; this is an
accepted consequence of cooperative, eventually consistent enforcement.

If enabled, an offline-access lease stores the last successful membership sync
time. When its project-configured duration expires, the app locks the project
without deleting data or unsynchronized work. A successful control-log sync
either restores access for an active member or transitions to the revocation
screen. The lease is application policy and does not claim tamper resistance.

## Optional Relay and Read-Only Web

A relay is the same protocol peer with persistent storage. It is not an
authority and cannot make an otherwise invalid atom valid. Removing it affects
availability and freshness, not local correctness.

In storage-only mode the relay holds project objects but does not build an
application projection. A trusted deployment may additionally receive a
`reader-service` membership, build the same projection, and expose a read-only
web UI. The web layer must authenticate a user and map that identity to current
project membership before serving data. It never exposes write endpoints.

Every web page shows the frontier or last synchronization time from which it was
built. If the relay stops syncing, the web view is explicitly stale rather than
appearing current.

## Projection and Search

The reducer first folds atoms reachable from trusted control refs, then validates
and folds atoms reachable from trusted data refs into:

- current project and membership state;
- issue, state, comment, and attachment views;
- unresolved conflict sets;
- reference edges and backlinks; and
- activity timelines.

The reducer is deterministic for a given valid atom set. It may build an
in-memory projection directly. A large project may use a local SQLite database
only for full-text search and cached rows. That database stores the frontier
hash it represents, is never synchronized, and may be deleted and rebuilt at
any time. SQLite failure cannot lose project data.

Periodic projection checkpoints may accelerate startup, but they are derived,
frontier-addressed, optional, and not required for recovery.

## Observable Synchronization Health

There is no meaningful global boolean named `fully synchronized`. The UI shows
observable facts:

- locally committed;
- relay has acknowledged a specific frontier;
- number and recency of peers that have acknowledged the frontier;
- whether every automatically replicated attachment is local; and
- last observed holder count for each large attachment.

Projects with only one observed replica or attachments with one observed holder
receive a backup-risk warning.

## Failure Handling and Recovery

| Failure | Isolation | Recovery |
| --- | --- | --- |
| Disk full or crash before ref update | New unreachable objects | Keep prior ref; retry and later clean orphans |
| Projection or search corruption | Disposable cache | Delete and fold all trusted refs again |
| Malformed or malicious pack | Peer quarantine | Reject pack and use another peer |
| Unsupported atom schema | Quarantined peer head | Preserve bytes and require app update |
| Attachment chunk corruption | Individual content hash | Request only missing or damaged chunks |
| Relay outage | One optional replica | Continue direct work; rebuild relay from a peer or bundle |
| Read-only web lag | Web projection | Display stale time; resync relay |
| Every replica and backup lost | No surviving authority | Unrecoverable by design |

Git maintenance may repack reachable objects. Version 1 keeps every valid atom
reachable and does not use history rewriting as compaction.

## Backup and Disconnected Transfer

The application exports a project backup containing:

- a Git bundle of every trusted Yonalist ref and reachable object;
- a signed bundle manifest with project ID and frontier;
- all attachment chunks for a full backup, or an explicit selected subset; and
- no projection or search cache.

An incremental bundle declares the receiver frontier prerequisites. Imports use
the same quarantine, signature, authorization, and hash validation as network
sync. A bundle is not trusted merely because it is a local file.

Users should use application export rather than copying a live repository
directory. Full bundles provide bootstrap and disaster recovery; incremental
bundles support air-gapped exchange.

## Required Invariants

1. Applying the same valid atom set in any arrival order, with any duplicates,
   produces the same projection and conflict set.
2. A locally acknowledged command remains reachable from the corresponding
   control or data ref after a crash.
3. An invalid remote pack cannot move a trusted ref.
4. Deleting every projection and search file cannot remove user data.
5. A peer that knows a grant is revoked sends that grant no new project data.
6. A manual conflict resolution references every revision head it resolves.
7. An attachment manifest cannot commit before its creator's local chunks are
   durable.
8. Removing the relay does not prevent local writes, direct sync, or bundle
   exchange.

## Testing Strategy

### Reducer and merge property tests

- permute and duplicate atom delivery and assert identical projections;
- partition atom sets, merge them in every order, and assert convergence;
- test observed-remove labels and assignees;
- test two-way and three-way text heads, clean virtual merges, manual
  resolutions, and a late third revision; and
- run golden `git-merge-file/myers/v1` fixtures across every supported client.

### Authorization tests

- invite, role change, removal, and re-invite generations;
- concurrent role change and removal;
- stale peers that have and have not observed a revocation;
- rejection of a removed grant at handshake;
- device certification and device revocation; and
- offline lease expiry followed by restore or revocation.

### Storage and crash tests

Inject process termination, I/O failure, and disk-full errors before and after
every object, chunk, commit, and ref step. Assert the commit-point and attachment
durability invariants. Corrupt caches and rebuild them from the Git repository.

### Network simulation

Simulate up to 100 peers with duplication, reordering, dropped connections,
long partitions, relay loss, relay restart, and direct reconnection. Assert
eventual ref/object convergence for connected active members and bounded
quarantine behavior for invalid peers.

### Attachment tests

- automatic threshold boundaries;
- interrupted and resumed chunk transfers;
- chunk corruption and alternate-holder recovery;
- missing-holder warnings; and
- full and partial backup bundles.

### End-to-end tests

- create and edit issues entirely offline, then synchronize;
- resolve body and state conflicts through the UI;
- render unresolved and later-resolved references;
- remove a member and verify both peer denial and the client lock screen;
- lose and rebuild the optional relay; and
- open a read-only web projection and verify visible staleness metadata.

## Delivery Boundaries

This design is too large for one undifferentiated implementation change. The
implementation plan should preserve the architecture while sequencing at least:

1. Git engine, atom format, local command commit point, and projection reducer;
2. core issue, comment, state, and reference atoms;
3. text merge and conflict-resolution UI;
4. membership control log and revocation lock;
5. peer and relay synchronization with quarantine;
6. attachment sidecar and replication policy;
7. bundle backup/import; and
8. optional relay web projection and offline-access lease.

Each boundary must ship with its relevant invariants and failure tests rather
than postponing convergence or crash behavior to the end.

## References

- [Git repository layout](https://git-scm.com/docs/gitrepository-layout.html)
- [Git pack protocol](https://git-scm.com/docs/gitprotocol-pack.html)
- [Git bundle](https://git-scm.com/docs/git-bundle.html)
- [Git merge-file](https://git-scm.com/docs/git-merge-file)
