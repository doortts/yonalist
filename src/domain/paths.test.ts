import { describe, expect, it } from "vitest";
import {
  attachmentDirectory,
  commentFilePath,
  draftIssuePath,
  itemMainPath,
  outboxOperationPath,
  repositoryRoot
} from "./paths";

const repo = {
  host: "ghe.example.com",
  owner: "Yona-projects",
  repo: "Home"
};

describe("vault paths", () => {
  it("uses host/owner/repository depth for repository files", () => {
    expect(repositoryRoot("/vault", repo)).toBe(
      "/vault/ghe.example.com/Yona-projects/Home"
    );
  });

  it("places issue and pull main documents in numbered folders", () => {
    expect(itemMainPath("/vault", { ...repo, kind: "issue", number: 7 })).toBe(
      "/vault/ghe.example.com/Yona-projects/Home/issues/7/issue.md"
    );
    expect(itemMainPath("/vault", { ...repo, kind: "pull", number: 8 })).toBe(
      "/vault/ghe.example.com/Yona-projects/Home/pulls/8/pull.md"
    );
  });

  it("stores one comment per markdown file in the item comments folder", () => {
    expect(
      commentFilePath("/vault", {
        ...repo,
        kind: "issue",
        number: 7,
        created_at: "2026-07-01T01:02:03Z",
        remote_id: 999
      })
    ).toBe(
      "/vault/ghe.example.com/Yona-projects/Home/issues/7/comments/20260701T010203Z-999.md"
    );
  });

  it("keeps drafts and outbox operations in stable local-only locations", () => {
    expect(draftIssuePath("/vault", { ...repo, local_id: "local-1" })).toBe(
      "/vault/ghe.example.com/Yona-projects/Home/issues/_drafts/local-1/issue.md"
    );
    expect(outboxOperationPath("/vault", "op-1")).toBe(
      "/vault/.yonalist/outbox/op-1.md"
    );
  });

  it("stores attachments beside the owning item", () => {
    expect(
      attachmentDirectory("/vault", { ...repo, kind: "pull", number: 12 })
    ).toBe("/vault/ghe.example.com/Yona-projects/Home/pulls/12/attachments");
  });
});
