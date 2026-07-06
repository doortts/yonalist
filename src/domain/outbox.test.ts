import { describe, expect, it } from "vitest";
import {
  createCommentOutboxOperation,
  createIssueOutboxOperation,
  hasUnresolvedLocalAttachments
} from "./outbox";

describe("outbox operations", () => {
  it("creates a local operation for an offline issue draft", () => {
    const operation = createIssueOutboxOperation({
      id: "op-1",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      localFilePath:
        "/vault/github.com/openai/codex/issues/_drafts/local-1/issue.md",
      createdAt: "2026-07-02T00:00:00Z"
    });

    expect(operation.frontMatter.operation).toBe("create_issue");
    expect(operation.frontMatter.status).toBe("pending");
    expect(operation.frontMatter.target.repo).toBe("codex");
  });

  it("creates a local operation for an offline comment draft", () => {
    const operation = createCommentOutboxOperation({
      id: "op-2",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      itemKind: "pull",
      number: 10,
      localFilePath:
        "/vault/github.com/openai/codex/pulls/10/comments/_drafts/local-2.md",
      createdAt: "2026-07-02T00:00:00Z"
    });

    expect(operation.frontMatter.operation).toBe("create_comment");
    expect(operation.frontMatter.target.kind).toBe("pull");
    expect(operation.frontMatter.target.number).toBe(10);
  });

  it("marks issue comments that should close the issue after syncing", () => {
    const operation = createCommentOutboxOperation({
      id: "op-3",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      itemKind: "issue",
      number: 10,
      closeAfterComment: true,
      localFilePath:
        "/vault/github.com/openai/codex/issues/10/comments/_drafts/local-3.md",
      createdAt: "2026-07-02T00:00:00Z"
    });

    expect(operation.frontMatter.close_after_comment).toBe(true);
  });

  it("blocks operations that reference unresolved local attachments", () => {
    expect(
      hasUnresolvedLocalAttachments([
        {
          local_path: "attachments/screenshot.png",
          status: "pending_remote_url"
        }
      ])
    ).toBe(true);
  });
});
