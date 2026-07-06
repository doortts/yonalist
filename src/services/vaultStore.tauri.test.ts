import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeMarkdownDocument } from "../domain/markdown";
import type { ItemDocument } from "../domain/types";
import {
  clearVaultDocumentHashMemoryCache,
  loadItemDocumentBody,
  loadVaultState,
  persistItemDocument,
  persistItemDocuments,
  rebuildVaultStateFromMarkdown
} from "./vaultStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock
}));

const vaultRoot = "/Users/doortts/Yonalist";

const item: ItemDocument = {
  path: "/Users/doortts/Yonalist/github.com/acme/app/issues/42/issue.md",
  body: "Issue body",
  frontMatter: {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 42,
    title: "SQLite hash",
    state: "open",
    author: "mona",
    labels: [],
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  }
};

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

describe("vaultStore in Tauri", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearVaultDocumentHashMemoryCache();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
  });

  it("skips native file writes when the SQLite document hash already matches", async () => {
    const contents = serializeMarkdownDocument(item.frontMatter, item.body);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_vault_document_hash") {
        return hashString(contents);
      }
      if (command === "upsert_vault_item_index") {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await persistItemDocument(vaultRoot, item);

    expect(invokeMock).toHaveBeenCalledWith("get_vault_document_hash", {
      vaultPath: vaultRoot,
      relativePath: "github.com/acme/app/issues/42/issue.md"
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "write_text_file",
      expect.anything()
    );
  });

  it("writes native files when only the front matter state changes", async () => {
    const openContents = serializeMarkdownDocument(item.frontMatter, item.body);
    const closedItem: ItemDocument = {
      ...item,
      frontMatter: {
        ...item.frontMatter,
        state: "closed"
      }
    };
    const closedContents = serializeMarkdownDocument(
      closedItem.frontMatter,
      closedItem.body
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_vault_document_hash") {
        return hashString(openContents);
      }
      if (command === "write_text_file" || command === "upsert_vault_document_hash") {
        return undefined;
      }
      if (command === "upsert_vault_item_index") {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await persistItemDocument(vaultRoot, closedItem);

    expect(invokeMock).toHaveBeenCalledWith("write_text_file", {
      vaultPath: vaultRoot,
      relativePath: "github.com/acme/app/issues/42/issue.md",
      contents: closedContents
    });
    expect(invokeMock).toHaveBeenCalledWith("upsert_vault_document_hash", {
      vaultPath: vaultRoot,
      relativePath: "github.com/acme/app/issues/42/issue.md",
      contentHash: hashString(closedContents),
      size: closedContents.length
    });
  });

  it("rebuilds SQLite document hashes after reading native vault files", async () => {
    const contents = serializeMarkdownDocument(item.frontMatter, item.body);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_vault_item_index") {
        return [];
      }
      if (command === "list_markdown_files") {
        return [
          {
            relative_path: "github.com/acme/app/issues/42/issue.md",
            contents
          }
        ];
      }
      if (command === "replace_vault_document_hashes") {
        return undefined;
      }
      if (command === "replace_vault_item_index") {
        return undefined;
      }
      if (command === "upsert_vault_item_index") {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const state = await loadVaultState(vaultRoot);

    expect(state.items).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("replace_vault_document_hashes", {
      vaultPath: vaultRoot,
      documents: [
        {
          relative_path: "github.com/acme/app/issues/42/issue.md",
          content_hash: hashString(contents),
          size: contents.length
        }
      ]
    });
  });

  it("loads item metadata from the native index without scanning markdown files", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_vault_item_index") {
        return [
          {
            relative_path: "github.com/acme/app/issues/42/issue.md",
            host: "github.com",
            owner: "acme",
            repo: "app",
            kind: "issue",
            number: 42,
            title: "Indexed issue",
            state: "open",
            author: "mona",
            labels_json: JSON.stringify(["bug"]),
            label_colors_json: JSON.stringify({ bug: "d73a4a" }),
            comment_count: 2,
            created_at: "2026-07-03T00:00:00Z",
            updated_at: "2026-07-04T00:00:00Z",
            html_url: "https://github.com/acme/app/issues/42",
            favorite: true,
            sync_status: "synced"
          }
        ];
      }
      if (command === "list_outbox_markdown_files") {
        return [];
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const state = await loadVaultState(vaultRoot);

    expect(state.items).toHaveLength(1);
    expect(state.items[0].body).toBe("");
    expect(state.items[0].frontMatter.title).toBe("Indexed issue");
    expect(state.items[0].frontMatter.labels).toEqual(["bug"]);
    expect(state.items[0].frontMatter.comments_count).toBe(2);
    expect(invokeMock).not.toHaveBeenCalledWith("list_markdown_files", expect.anything());
  });

  it("can rebuild the native item index from markdown and dedupe duplicated vault items", async () => {
    const olderDuplicate: ItemDocument = {
      ...item,
      path: "/Users/doortts/Yonalist/vault/github.com/acme/app/issues/42/issue.md",
      body: "Old body",
      frontMatter: {
        ...item.frontMatter,
        title: "Older duplicate",
        updated_at: "2026-07-02T00:00:00Z"
      }
    };
    const newerDuplicate: ItemDocument = {
      ...item,
      body: "New body",
      frontMatter: {
        ...item.frontMatter,
        title: "Newer canonical issue",
        updated_at: "2026-07-04T00:00:00Z"
      }
    };
    const discussion: ItemDocument = {
      path: "/Users/doortts/Yonalist/github.com/acme/app/discussions/7/discussion.md",
      body: "Discussion body",
      frontMatter: {
        ...item.frontMatter,
        kind: "discussion",
        number: 7,
        title: "Separate discussion",
        updated_at: "2026-07-03T00:00:00Z"
      }
    };
    const documents = [olderDuplicate, newerDuplicate, discussion].map(
      (document) => ({
        relative_path: document.path.slice(`${vaultRoot}/`.length),
        contents: serializeMarkdownDocument(document.frontMatter, document.body)
      })
    );

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_markdown_files") {
        return documents;
      }
      if (
        command === "replace_vault_document_hashes" ||
        command === "replace_vault_item_index"
      ) {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const state = await rebuildVaultStateFromMarkdown(vaultRoot);

    expect(state.items.map((loaded) => loaded.frontMatter.title)).toEqual([
      "Newer canonical issue",
      "Separate discussion"
    ]);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "list_vault_item_index",
      expect.anything()
    );
    expect(invokeMock).toHaveBeenCalledWith("replace_vault_item_index", {
      vaultPath: vaultRoot,
      records: expect.arrayContaining([
        expect.objectContaining({
          relative_path: "github.com/acme/app/issues/42/issue.md",
          title: "Newer canonical issue"
        }),
        expect.objectContaining({
          relative_path: "github.com/acme/app/discussions/7/discussion.md",
          title: "Separate discussion"
        })
      ])
    });
  });

  it("loads an indexed item's markdown body only when requested", async () => {
    const contents = serializeMarkdownDocument(item.frontMatter, "Lazy body");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "read_text_file") {
        return contents;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const body = await loadItemDocumentBody(vaultRoot, { ...item, body: "" });

    expect(body).toBe("Lazy body");
    expect(invokeMock).toHaveBeenCalledWith("read_text_file", {
      vaultPath: vaultRoot,
      relativePath: "github.com/acme/app/issues/42/issue.md"
    });
  });

  it("uses the in-memory hash cache after reading native vault files", async () => {
    const contents = serializeMarkdownDocument(item.frontMatter, item.body);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_vault_item_index") {
        return [];
      }
      if (command === "list_markdown_files") {
        return [
          {
            relative_path: "github.com/acme/app/issues/42/issue.md",
            contents
          }
        ];
      }
      if (command === "replace_vault_document_hashes") {
        return undefined;
      }
      if (command === "replace_vault_item_index") {
        return undefined;
      }
      if (command === "upsert_vault_item_index") {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await loadVaultState(vaultRoot);
    invokeMock.mockClear();

    await persistItemDocument(vaultRoot, item);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("upsert_vault_item_index", {
      vaultPath: vaultRoot,
      records: expect.any(Array)
    });
  });

  it("persists native item documents with one bulk command", async () => {
    const closedItem: ItemDocument = {
      ...item,
      frontMatter: {
        ...item.frontMatter,
        state: "closed"
      }
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "persist_vault_documents") {
        return { checked: 2, written: 1, skipped: 1 };
      }
      if (command === "upsert_vault_item_index") {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await persistItemDocuments(vaultRoot, [item, closedItem]);

    expect(result).toEqual({ checked: 2, written: 1, skipped: 1 });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith("persist_vault_documents", {
      vaultPath: vaultRoot,
      documents: [
        {
          relative_path: "github.com/acme/app/issues/42/issue.md",
          contents: serializeMarkdownDocument(item.frontMatter, item.body)
        },
        {
          relative_path: "github.com/acme/app/issues/42/issue.md",
          contents: serializeMarkdownDocument(closedItem.frontMatter, closedItem.body)
        }
      ]
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "get_vault_document_hash",
      expect.anything()
    );
  });
});
