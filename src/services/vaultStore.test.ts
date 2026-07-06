import { afterEach, describe, expect, it, vi } from "vitest";
import { createIssueOutboxOperation } from "../domain/outbox";
import type { ItemDocument } from "../domain/types";
import { serializeMarkdownDocument } from "../domain/markdown";
import {
  loadVaultState,
  persistItemDocument,
  persistItemDocuments,
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

  it("rewrites item documents when only the front matter state changes", async () => {
    await persistItemDocument(vaultRoot, draftIssue);
    const closedIssue: ItemDocument = {
      ...draftIssue,
      frontMatter: {
        ...draftIssue.frontMatter,
        state: "closed"
      }
    };

    await persistItemDocument(vaultRoot, closedIssue);

    const raw = window.localStorage.getItem("yonalist.vaultDocuments.v1");
    expect(raw).toContain("state: closed");
  });

  it("bulk persists item documents and skips unchanged repeats", async () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    const first = await persistItemDocuments(vaultRoot, [draftIssue]);
    const writesAfterFirst = setItemSpy.mock.calls.filter(
      ([key]) => key === "yonalist.vaultDocuments.v1"
    ).length;
    const second = await persistItemDocuments(vaultRoot, [draftIssue]);

    expect(first).toEqual({ checked: 1, written: 1, skipped: 0 });
    expect(second).toEqual({ checked: 1, written: 0, skipped: 1 });
    expect(
      setItemSpy.mock.calls.filter(
        ([key]) => key === "yonalist.vaultDocuments.v1"
      ).length
    ).toBe(writesAfterFirst);
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
