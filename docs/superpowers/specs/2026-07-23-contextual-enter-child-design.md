# Contextual Enter Child Creation Design

## Goal

Restore the expected outline-row `Enter` behavior: when a text bullet already
has children and the caret is collapsed at the end of its title, plain `Enter`
creates and focuses a new empty first child.

## History and root cause

The repository does not contain a recent regression from child creation to
sibling creation for ordinary outline rows.

- Commit `f4fedae` introduced outline-row keyboard handling on 2026-07-10 and
  resolved plain text-row `Enter` to `split` without considering children.
- Commit `bda7d08c` introduced the persisted split operation on 2026-07-10 and
  placed the new node after the source under `source.parent_id`, making it a
  sibling.
- Commits `8764eae` and `8b561be` added first-child creation from the zoomed
  page title on 2026-07-20. That behavior remains present, but it does not apply
  to ordinary outline rows.

The remembered child-creation behavior therefore matches the zoomed page-title
path or a build outside the retained ordinary-row history. The current
ordinary-row resolver has never encoded the contextual Workflowy rule.

## Behavior contract

| Scenario | Result |
| --- | --- |
| Text row has children; caret is collapsed at title end; plain `Enter` | Create an empty first child and focus it. |
| Text row has no children; caret is collapsed at title end; plain `Enter` | Preserve the current split operation, producing the next sibling. |
| Text row has children; caret is in the middle or a title range is selected | Preserve the current split operation and its prefix/suffix semantics. |
| Image row receives plain `Enter` | Preserve next-text-sibling creation. |
| IME composition, key repeat, modified `Enter`, read-only state, or an in-flight structural command | Preserve current guards and behavior. |
| Undo/Redo after child creation | Use the existing child-creation history operation without adding a new history path. |

The new child uses the existing `createChild(nodeId, "first")` contract, so its
marker remains the ordinary default bullet. Changing marker inheritance is not
part of this change.

## Architecture

`resolveOutlineKey` will detect the narrow contextual case using the normalized
workspace it already receives. It will return a dedicated
`createFirstChild` resolution only when all of these are true:

1. the target is a text title;
2. the selection is collapsed;
3. the caret is at the logical end of the title; and
4. `workspace.childIdsByParent[nodeId]` contains at least one child.

`OutlineNodeRow` will route that resolution through the existing
`actions.createChild(nodeId, "first")` command. No IPC payload, Rust,
persistence schema, history representation, or synchronization code changes.

## Error handling

Child creation retains the current structural-command gate, command settlement,
focus handoff, and error feedback. If persistence fails, the existing command
path reports the failure and does not acknowledge a successful child.

## Testing

1. Add focused resolver tests proving the contextual child case and the
   unchanged no-child and middle-split cases.
2. Add an outline integration test proving Enter creates the first child,
   preserves existing child order, and focuses the new row.
3. Run the focused tests, the owning frontend suite, a fresh desktop smoke test
   in an isolated Vault, and the standard frontend gates.

## Non-goals

- Changing split persistence semantics.
- Changing page-title Enter behavior.
- Changing image Enter behavior.
- Changing marker inheritance.
- Changing supporting-note `Shift+Enter`.
- Adding optimistic split or Enter-latency work.
