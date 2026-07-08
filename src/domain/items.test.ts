import { describe, expect, it } from "vitest";
import {
  DEFAULT_ITEM_SORT,
  mergeItemDocuments,
  reconcileItems,
  sortItemDocuments
} from "./items";
import type { ItemDocument } from "./types";

function item(overrides: Partial<ItemDocument["frontMatter"]> = {}): ItemDocument {
  const number = overrides.number ?? 88;
  return {
    path: `/vault/github.com/acme/app/discussions/${number}/discussion.md`,
    body: "Body",
    frontMatter: {
      kind: "discussion",
      host: "github.com",
      owner: "acme",
      repo: "app",
      number: 88,
      title: "Planning",
      state: "open",
      author: "mona",
      labels: [],
      comments_count: 4,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      local: { favorite: false },
      sync: { status: "synced" },
      ...overrides
    }
  };
}

describe("mergeItemDocuments", () => {
  it("keeps the local comment count when a refresh response omits it", () => {
    const [merged] = mergeItemDocuments(
      [item({ comments_count: 4 })],
      [item({ comments_count: undefined, updated_at: "2026-07-03T00:00:00Z" })],
      "/vault"
    );

    expect(merged.frontMatter.comments_count).toBe(4);
  });

  it("sorts merged items by created date descending by default", () => {
    const olderCreatedNewerUpdated = item({
      number: 1,
      title: "Older created",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z"
    });
    const newerCreatedOlderUpdated = item({
      number: 2,
      title: "Newer created",
      created_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z"
    });

    const merged = mergeItemDocuments(
      [olderCreatedNewerUpdated, newerCreatedOlderUpdated],
      [],
      "/vault"
    );

    expect(DEFAULT_ITEM_SORT).toEqual({ field: "created", direction: "desc" });
    expect(merged.map((mergedItem) => mergedItem.frontMatter.title)).toEqual([
      "Newer created",
      "Older created"
    ]);
  });

  it("preserves the local object reference for an unchanged item", () => {
    const local = item();
    const remote = item();

    const [merged] = mergeItemDocuments([local], [remote], "/vault");

    expect(merged).toBe(local);
  });

  it("returns a new object reference for a changed item", () => {
    const local = item({ title: "Planning", updated_at: "2026-07-02T00:00:00Z" });
    const remote = item({ title: "Renamed", updated_at: "2026-07-03T00:00:00Z" });

    const [merged] = mergeItemDocuments([local], [remote], "/vault");

    expect(merged).not.toBe(local);
    expect(merged.frontMatter.title).toBe("Renamed");
  });

  it("preserves the previous array reference for a fully unchanged list", () => {
    const first = item({ number: 1, title: "First", updated_at: "2026-07-05T00:00:00Z" });
    const second = item({ number: 2, title: "Second", updated_at: "2026-07-04T00:00:00Z" });
    const localItems = [first, second];
    const remoteItems = [
      item({ number: 1, title: "First", updated_at: "2026-07-05T00:00:00Z" }),
      item({ number: 2, title: "Second", updated_at: "2026-07-04T00:00:00Z" })
    ];

    const merged = mergeItemDocuments(localItems, remoteItems, "/vault");

    expect(merged).toBe(localItems);
  });

  it("returns a new array when at least one item changed", () => {
    const first = item({ number: 1, title: "First", updated_at: "2026-07-05T00:00:00Z" });
    const second = item({ number: 2, title: "Second", updated_at: "2026-07-04T00:00:00Z" });
    const localItems = [first, second];

    const merged = mergeItemDocuments(
      localItems,
      [
        item({ number: 1, title: "First", updated_at: "2026-07-05T00:00:00Z" }),
        item({ number: 2, title: "Renamed", updated_at: "2026-07-04T00:00:00Z" })
      ],
      "/vault"
    );

    expect(merged).not.toBe(localItems);
    expect(merged[0]).toBe(first);
    expect(merged[1]).not.toBe(second);
    expect(merged[1].frontMatter.title).toBe("Renamed");
  });
});

describe("sortItemDocuments", () => {
  it("sorts by the requested field and direction", () => {
    const olderCreatedNewerUpdated = item({
      number: 1,
      title: "Older created, newer updated",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z"
    });
    const newerCreatedOlderUpdated = item({
      number: 2,
      title: "Newer created, older updated",
      created_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z"
    });
    const items = [olderCreatedNewerUpdated, newerCreatedOlderUpdated];

    expect(
      sortItemDocuments(items, { field: "created", direction: "asc" }).map(
        (sorted) => sorted.frontMatter.title
      )
    ).toEqual(["Older created, newer updated", "Newer created, older updated"]);
    expect(
      sortItemDocuments(items, { field: "updated", direction: "desc" }).map(
        (sorted) => sorted.frontMatter.title
      )
    ).toEqual(["Older created, newer updated", "Newer created, older updated"]);
  });

  it("does not mutate the input list", () => {
    const first = item({ number: 1, title: "First" });
    const second = item({
      number: 2,
      title: "Second",
      created_at: "2026-07-03T00:00:00Z"
    });
    const items = [first, second];

    const sorted = sortItemDocuments(items, {
      field: "created",
      direction: "desc"
    });

    expect(sorted).not.toBe(items);
    expect(items).toEqual([first, second]);
    expect(sorted).toEqual([second, first]);
  });
});

describe("reconcileItems", () => {
  it("keeps the previous object reference for an unchanged item", () => {
    const previous = [item({ number: 1, title: "One" })];
    const next = [item({ number: 1, title: "One" })];

    const reconciled = reconcileItems(previous, next);

    expect(reconciled).toBe(previous);
    expect(reconciled[0]).toBe(previous[0]);
  });

  it("returns a new object reference for a changed item", () => {
    const previous = [item({ number: 1, title: "One" })];
    const next = [item({ number: 1, title: "Renamed" })];

    const reconciled = reconcileItems(previous, next);

    expect(reconciled).not.toBe(previous);
    expect(reconciled[0]).toBe(next[0]);
  });

  it("returns the next array when there is no previous state", () => {
    const next = [item()];

    expect(reconcileItems(null, next)).toBe(next);
  });
});
