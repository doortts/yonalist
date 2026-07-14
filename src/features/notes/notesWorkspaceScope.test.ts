import { describe, expect, it } from "vitest";
import type { NotesWorkspaceScope, NoteTagFilter } from "../../domain/notes";
import {
  canonicalizeTagFilters,
  noteTagFilterFromLegacyScope,
  sameScope,
  Scope,
  scopeKey
} from "./notesWorkspaceScope";

const hash = (tag: string): NoteTagFilter => ({
  prefix: "#",
  normalizedTag: tag
});
const at = (tag: string): NoteTagFilter => ({ prefix: "@", normalizedTag: tag });

describe("scopeKey / sameScope", () => {
  it("distinguishes the simple scope kinds", () => {
    const kinds: NotesWorkspaceScope["kind"][] = [
      "active",
      "starred",
      "recent",
      "archive",
      "trash"
    ];
    const keys = kinds.map((kind) => scopeKey({ kind } as NotesWorkspaceScope));
    expect(new Set(keys).size).toBe(kinds.length);
    expect(sameScope({ kind: "active" }, { kind: "active" })).toBe(true);
    expect(sameScope({ kind: "active" }, { kind: "archive" })).toBe(false);
  });

  it("is independent of the order tags were assembled in", () => {
    const left: NotesWorkspaceScope = {
      kind: "tags",
      tags: [hash("alpha"), at("beta"), hash("gamma")]
    };
    const right: NotesWorkspaceScope = {
      kind: "tags",
      tags: [hash("gamma"), hash("alpha"), at("beta")]
    };
    // JSON.stringify would have reported these as different scopes and dropped
    // the cross-hook synchronization; key equality treats them as one scope.
    expect(scopeKey(left)).toBe(scopeKey(right));
    expect(sameScope(left, right)).toBe(true);
  });

  it("deduplicates repeated tag filters in the key", () => {
    const withDupes: NotesWorkspaceScope = {
      kind: "tags",
      tags: [hash("alpha"), hash("alpha"), at("beta")]
    };
    const deduped: NotesWorkspaceScope = {
      kind: "tags",
      tags: [at("beta"), hash("alpha")]
    };
    expect(sameScope(withDupes, deduped)).toBe(true);
  });

  it("treats full-fold-equivalent tag filters as the same scope", () => {
    expect(
      sameScope(
        { kind: "tags", tags: [hash("Straße"), at("ﬀ")] },
        { kind: "tags", tags: [at("ff"), hash("STRASSE")] }
      )
    ).toBe(true);
  });

  it("normalizes legacy tag scope identities with full Unicode folding", () => {
    expect(
      sameScope(
        { kind: "tag", tag: "#Straße" },
        { kind: "tag", tag: "  STRASSE  " }
      )
    ).toBe(true);
    expect(
      sameScope(
        { kind: "tag", tag: "ﬀ" },
        { kind: "tag", tag: " #ff " }
      )
    ).toBe(true);
  });

  it("keeps distinct tag sets distinct", () => {
    expect(
      sameScope(
        { kind: "tags", tags: [hash("alpha")] },
        { kind: "tags", tags: [hash("alpha"), at("beta")] }
      )
    ).toBe(false);
  });

  it("does not collide a `tag` scope with a `tags` scope", () => {
    // A single-quantity `tag` string must never key-collide with a `tags`
    // filter list, even for adversarial payloads.
    expect(scopeKey({ kind: "tag", tag: "#alpha" })).not.toBe(
      scopeKey({ kind: "tags", tags: [hash("alpha")] })
    );
  });
});

describe("Scope value object", () => {
  it("normalizes ordering once and compares via its cached key", () => {
    const left = Scope.from({
      kind: "tags",
      tags: [hash("alpha"), at("beta")]
    });
    const right = Scope.from({
      kind: "tags",
      tags: [at("beta"), hash("alpha")]
    });
    expect(left.key).toBe(right.key);
    expect(left.equals(right)).toBe(true);
    // equals also accepts a raw scope value.
    expect(left.equals({ kind: "tags", tags: [at("beta"), hash("alpha")] })).toBe(
      true
    );
    expect(left.equals({ kind: "active" })).toBe(false);
  });
});

describe("canonicalizeTagFilters", () => {
  it("sorts # before @ and dedupes, order-independently", () => {
    expect(
      canonicalizeTagFilters([at("beta"), hash("gamma"), hash("alpha"), at("beta")])
    ).toEqual([hash("alpha"), hash("gamma"), at("beta")]);
  });

  it("full-folds identities before deduping and sorting", () => {
    expect(
      canonicalizeTagFilters([
        at("ﬀ"),
        hash("Straße"),
        at("ff"),
        hash("STRASSE")
      ])
    ).toEqual([hash("strasse"), at("ff")]);
  });
});

describe("noteTagFilterFromLegacyScope", () => {
  it.each([
    ["roadmap", hash("roadmap")],
    [" #Straße ", hash("strasse")],
    ["##ﬀ", hash("ff")],
    ["  ", null],
    ["###", null]
  ])("translates the legacy hash-tag value %j", (tag, expected) => {
    expect(noteTagFilterFromLegacyScope(tag)).toEqual(expected);
  });
});
