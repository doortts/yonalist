import type { NotesWorkspaceScope, NoteTagFilter } from "../../domain/notes";

/**
 * Single source of truth for comparing {@link NotesWorkspaceScope} values.
 *
 * Scope equality used to be spelled two different ways — the coordinator did a
 * `JSON.stringify` compare and the hook had its own `sameScope`. Both were
 * key-order dependent, so two structurally identical `tags` scopes whose tag
 * arrays (or the objects inside them) were built in a different order would
 * compare unequal and silently drop a synchronization. The {@link Scope} value
 * object below normalizes ordering exactly once in its constructor and exposes
 * a canonical {@link Scope.key} string; every comparison goes through key
 * equality so ordering can never matter again.
 */

// Control-character separators that cannot occur in a normalized tag, so
// distinct scopes always produce distinct keys: U+0000 splits a filter's prefix
// from its tag, U+0001 joins filters, U+0002 splits a scope's discriminant from
// its payload.
const FIELD_SEP = String.fromCharCode(0);
const FILTER_SEP = String.fromCharCode(1);
const KIND_SEP = String.fromCharCode(2);

export function tagFilterKey(filter: NoteTagFilter): string {
  return `${filter.prefix}${FIELD_SEP}${filter.normalizedTag}`;
}

/**
 * Deduplicate and canonically order a list of tag filters. `#` tags sort before
 * `@` tags and each group sorts by normalized tag, so the result is independent
 * of the order the caller assembled the filters in.
 */
export function canonicalizeTagFilters(
  filters: readonly NoteTagFilter[]
): NoteTagFilter[] {
  const uniqueFilters = new Map(
    filters.map((filter) => [
      tagFilterKey(filter),
      {
        prefix: filter.prefix,
        normalizedTag: filter.normalizedTag
      }
    ])
  );
  return [...uniqueFilters.values()].sort(
    (left, right) =>
      (left.prefix === right.prefix ? 0 : left.prefix === "#" ? -1 : 1) ||
      left.normalizedTag.localeCompare(right.normalizedTag)
  );
}

/**
 * Canonical, key-order-independent string for a scope. Two scopes are the same
 * scope if and only if their keys are equal.
 */
export function scopeKey(scope: NotesWorkspaceScope): string {
  switch (scope.kind) {
    case "active":
    case "starred":
    case "recent":
    case "archive":
    case "trash":
      return scope.kind;
    case "tag":
      return `tag${KIND_SEP}${scope.tag}`;
    case "tags":
      return `tags${KIND_SEP}${canonicalizeTagFilters(scope.tags)
        .map(tagFilterKey)
        .join(FILTER_SEP)}`;
  }
}

/**
 * Immutable value object wrapping a {@link NotesWorkspaceScope}. Constructing it
 * normalizes ordering (via {@link scopeKey}) once; {@link Scope.equals} then
 * reduces to a cheap string compare.
 */
export class Scope {
  readonly value: NotesWorkspaceScope;
  readonly key: string;

  private constructor(value: NotesWorkspaceScope, key: string) {
    this.value = value;
    this.key = key;
  }

  static from(value: NotesWorkspaceScope): Scope {
    return new Scope(value, scopeKey(value));
  }

  equals(other: Scope | NotesWorkspaceScope): boolean {
    return this.key === (other instanceof Scope ? other.key : scopeKey(other));
  }
}

/**
 * Key-equality scope comparison. This is the only scope equality predicate in
 * the workspace; the coordinator and the hook both route through it.
 */
export function sameScope(
  left: NotesWorkspaceScope,
  right: NotesWorkspaceScope
): boolean {
  return scopeKey(left) === scopeKey(right);
}
