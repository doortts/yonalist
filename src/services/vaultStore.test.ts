import { afterEach, describe, expect, it, vi } from "vitest";
import { createIssueOutboxOperation } from "../domain/outbox";
import type { ItemDocument } from "../domain/types";
import { serializeMarkdownDocument } from "../domain/markdown";
import {
  loadVaultState,
  persistItemDocument,
  persistOutboxOperation
} from "./vaultStore";

const vaultRoot = "/Users/doortts/Yonalist";

const draftIssue: ItemDocument = {
  path: "/Users/doortts/Yonalist/github.com/acme/app/issues/_drafts/local-1/issue.md",
  body: "Draft body",
  frontMatter: {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 0,
    title: "Persisted draft",
    state: "open",
    author: "local",
    labels: [],
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    local: { favorite: false },
    sync: { status: "pending" }
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vaultStore", () => {
  it("persists Markdown item and outbox documents and rebuilds state", async () => {
    const operation = createIssueOutboxOperation({
      id: "local-1",
      host: "github.com",
      owner: "acme",
      repo: "app",
      localFilePath: draftIssue.path,
      createdAt: "2026-07-03T00:00:00Z",
      vaultRoot
    });

    await persistItemDocument(vaultRoot, draftIssue);
    await persistOutboxOperation(vaultRoot, operation);

    const raw = window.localStorage.getItem("yonalist.vaultDocuments.v1");
    expect(raw).toContain("Persisted draft");
    expect(raw).toContain(".yonalist/outbox/local-1.md");

    const state = await loadVaultState(vaultRoot);

    expect(state.items).toHaveLength(1);
    expect(state.items[0].frontMatter.title).toBe("Persisted draft");
    expect(state.items[0].path).toBe(draftIssue.path);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0].frontMatter.id).toBe("local-1");
  });

  it("skips writing unchanged item documents when the stored hash matches", async () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    await persistItemDocument(vaultRoot, draftIssue);
    const firstWriteCount = setItemSpy.mock.calls.length;
    await persistItemDocument(vaultRoot, draftIssue);

    expect(setItemSpy.mock.calls.length).toBe(firstWriteCount);
  });

  it("records hashes while loading local vault documents so identical refreshes do not rewrite", async () => {
    window.localStorage.setItem(
      "yonalist.vaultDocuments.v1",
      JSON.stringify({
        [vaultRoot]: {
          "github.com/acme/app/issues/_drafts/local-1/issue.md":
            serializeMarkdownDocument(draftIssue.frontMatter, draftIssue.body)
        }
      })
    );

    await loadVaultState(vaultRoot);
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    await persistItemDocument(vaultRoot, draftIssue);

    expect(setItemSpy).not.toHaveBeenCalledWith(
      "yonalist.vaultDocuments.v1",
      expect.any(String)
    );
  });
});
