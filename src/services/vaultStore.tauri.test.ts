import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeMarkdownDocument } from "../domain/markdown";
import type { ItemDocument } from "../domain/types";
import {
  clearVaultDocumentHashMemoryCache,
  loadVaultState,
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

  it("uses the in-memory hash cache after reading native vault files", async () => {
    const contents = serializeMarkdownDocument(item.frontMatter, item.body);
    invokeMock.mockImplementation(async (command: string) => {
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
      throw new Error(`Unexpected command: ${command}`);
    });

    await loadVaultState(vaultRoot);
    invokeMock.mockClear();

    await persistItemDocument(vaultRoot, item);

    expect(invokeMock).not.toHaveBeenCalled();
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
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await persistItemDocuments(vaultRoot, [item, closedItem]);

    expect(result).toEqual({ checked: 2, written: 1, skipped: 1 });
    expect(invokeMock).toHaveBeenCalledTimes(1);
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
