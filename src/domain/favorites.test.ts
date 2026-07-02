import { describe, expect, it } from "vitest";
import {
  mergeRemoteItemPreservingLocal,
  toggleFavorite
} from "./favorites";
import type { ItemDocument } from "./types";

const item: ItemDocument = {
  path: "/vault/github.com/openai/codex/issues/1/issue.md",
  body: "Issue body",
  frontMatter: {
    kind: "issue",
    host: "github.com",
    owner: "openai",
    repo: "codex",
    number: 1,
    node_id: "I_1",
    html_url: "https://github.com/openai/codex/issues/1",
    title: "Favorite me",
    state: "open",
    author: "mona",
    labels: [],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    synced_at: "2026-07-02T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  }
};

describe("favorites", () => {
  it("toggles local-only favorite metadata", () => {
    const updated = toggleFavorite(item);

    expect(updated.frontMatter.local.favorite).toBe(true);
    expect(item.frontMatter.local.favorite).toBe(false);
  });

  it("preserves favorite metadata when a remote item is merged", () => {
    const remote = {
      ...item,
      frontMatter: {
        ...item.frontMatter,
        title: "Remote changed",
        local: { favorite: false }
      }
    };
    const local = toggleFavorite(item);

    expect(
      mergeRemoteItemPreservingLocal(remote, local).frontMatter.local.favorite
    ).toBe(true);
  });
});
