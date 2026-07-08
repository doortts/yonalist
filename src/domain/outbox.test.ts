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

  it("stores the close reason for issue comments that close after syncing", () => {
    const operation = createCommentOutboxOperation({
      id: "op-3-reason",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      itemKind: "issue",
      number: 10,
      closeAfterComment: {
        kind: "issue",
        reason: "duplicate",
        duplicateIssueId: 99
      },
      localFilePath:
        "/vault/github.com/openai/codex/issues/10/comments/_drafts/local-3.md",
      createdAt: "2026-07-02T00:00:00Z"
    });

    expect(operation.frontMatter.close_after_comment).toEqual({
      kind: "issue",
      reason: "duplicate",
      duplicate_issue_id: 99
    });
  });

  it("stores discussion and pull request close actions for comments", () => {
    const discussion = createCommentOutboxOperation({
      id: "op-discussion-close",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      itemKind: "discussion",
      number: 10,
      closeAfterComment: { kind: "discussion", reason: "outdated" },
      localFilePath:
        "/vault/github.com/openai/codex/discussions/10/comments/_drafts/local-4.md",
      createdAt: "2026-07-02T00:00:00Z"
    });
    const pull = createCommentOutboxOperation({
      id: "op-pull-close",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      itemKind: "pull",
      number: 10,
      closeAfterComment: { kind: "pull" },
      localFilePath:
        "/vault/github.com/openai/codex/pulls/10/comments/_drafts/local-5.md",
      createdAt: "2026-07-02T00:00:00Z"
    });

    expect(discussion.frontMatter.close_after_comment).toEqual({
      kind: "discussion",
      reason: "outdated"
    });
    expect(pull.frontMatter.close_after_comment).toEqual({ kind: "pull" });
  });

  it("keeps the parent discussion comment node id for queued replies", () => {
    const operation = createCommentOutboxOperation({
      id: "op-4",
      host: "github.com",
      owner: "openai",
      repo: "codex",
      itemKind: "discussion",
      number: 10,
      parentCommentNodeId: "DC_parent",
      localFilePath:
        "/vault/github.com/openai/codex/discussions/10/comments/_drafts/local-4.md",
      createdAt: "2026-07-02T00:00:00Z"
    });

    expect(operation.frontMatter.target.parent_comment_node_id).toBe("DC_parent");
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
