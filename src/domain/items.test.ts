import { describe, expect, it } from "vitest";
import { mergeItemDocuments } from "./items";
import type { ItemDocument } from "./types";

function item(overrides: Partial<ItemDocument["frontMatter"]> = {}): ItemDocument {
  return {
    path: "/vault/github.com/acme/app/discussions/88/discussion.md",
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
});
