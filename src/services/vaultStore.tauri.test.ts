import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeMarkdownDocument } from "../domain/markdown";
import type { ItemDocument } from "../domain/types";
import {
  clearVaultDocumentHashMemoryCache,
  loadItemDocumentBody,
  loadVaultItems,
  persistItemDocument,
  persistItemDocuments
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
      throw new Error(`Unexpected command: ${command}`);
    });

    const items = await loadVaultItems(vaultRoot);

    expect(items).toHaveLength(1);
    expect(items[0].body).toBe("");
    expect(items[0].frontMatter.title).toBe("Indexed issue");
    expect(items[0].frontMatter.labels).toEqual(["bug"]);
    expect(items[0].frontMatter.comments_count).toBe(2);
    expect(invokeMock).toHaveBeenCalledWith("list_vault_item_index", {
      vaultPath: vaultRoot
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
