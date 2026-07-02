import { describe, expect, it } from "vitest";
import {
  parseMarkdownDocument,
  serializeMarkdownDocument
} from "./markdown";
import type { ItemFrontMatter } from "./types";

describe("markdown front matter", () => {
  it("round-trips an item document with local favorite metadata", () => {
    const frontMatter: ItemFrontMatter = {
      kind: "issue",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      number: 42,
      node_id: "I_kwDO",
      html_url: "https://github.com/openai/codex/issues/42",
      title: "Offline issue reading",
      state: "open",
      author: "mona",
      labels: ["offline", "sync"],
      created_at: "2026-07-01T01:02:03Z",
      updated_at: "2026-07-01T04:05:06Z",
      synced_at: "2026-07-02T00:00:00Z",
      local: { favorite: true },
      sync: { status: "synced" }
    };

    const markdown = serializeMarkdownDocument(frontMatter, "Body **text**");
    const parsed = parseMarkdownDocument<ItemFrontMatter>(markdown);

    expect(parsed.frontMatter.local.favorite).toBe(true);
    expect(parsed.frontMatter.labels).toEqual(["offline", "sync"]);
    expect(parsed.body).toBe("Body **text**");
  });

  it("keeps empty bodies stable", () => {
    const markdown = serializeMarkdownDocument(
      {
        kind: "comment",
        remote_id: 10,
        node_id: "IC_kwDO",
        author: "octocat",
        created_at: "2026-07-01T01:02:03Z",
        updated_at: "2026-07-01T01:02:03Z",
        sync: { status: "synced" }
      },
      ""
    );

    expect(parseMarkdownDocument(markdown).body).toBe("");
  });
});
