import { describe, expect, it } from "vitest";
import { buildVaultIndex } from "./vaultIndex";
import { serializeMarkdownDocument } from "./markdown";

describe("vault index", () => {
  it("rebuilds listable items and favorites from markdown documents", () => {
    const documents = [
      {
        path: "/vault/github.com/openai/codex/issues/1/issue.md",
        contents: serializeMarkdownDocument(
          {
            kind: "issue",
            host: "github.com",
            owner: "openai",
            repo: "codex",
            number: 1,
            node_id: "I_1",
            html_url: "https://github.com/openai/codex/issues/1",
            title: "Read offline",
            state: "open",
            author: "mona",
            labels: ["offline"],
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
            synced_at: "2026-07-02T00:00:00Z",
            local: { favorite: true },
            sync: { status: "synced" }
          },
          "Body"
        )
      },
      {
        path: "/vault/.yonalist/outbox/op-1.md",
        contents: serializeMarkdownDocument(
          {
            kind: "outbox_operation",
            operation: "create_comment",
            id: "op-1",
            target: {
              host: "github.com",
              owner: "openai",
              repo: "codex",
              kind: "issue",
              number: 1
            },
            local_file_path: "/draft.md",
            created_at: "2026-07-02T00:00:00Z",
            status: "pending"
          },
          ""
        )
      }
    ];

    const index = buildVaultIndex(documents);

    expect(index.items).toHaveLength(1);
    expect(index.items[0].favorite).toBe(true);
    expect(index.repositories[0].key).toBe("github.com/openai/codex");
    expect(index.outbox).toHaveLength(1);
  });
});
