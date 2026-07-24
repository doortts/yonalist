import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemFrontMatter } from "../domain/types";
import {
  itemIndexRecord,
  type VaultIndexScanChange,
  type VaultParsedIndexChange
} from "./vaultIndex";
import { reconcileVaultItemIndex } from "./vaultIndexReconcile";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

let workerReply: unknown;
let workerError: string | null;
let workerCreated = 0;
const terminateMock = vi.fn();

class WorkerMock {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    workerCreated += 1;
  }

  postMessage() {
    queueMicrotask(() => {
      if (workerError) {
        this.onerror?.({ message: workerError } as ErrorEvent);
        return;
      }
      this.onmessage?.({ data: { id: 1, result: workerReply } } as MessageEvent);
    });
  }

  terminate() {
    terminateMock();
  }
}

function installWorkerReply(reply: unknown) {
  workerReply = reply;
  workerError = null;
  vi.stubGlobal("Worker", WorkerMock);
}

function itemFrontMatter(): ItemFrontMatter {
  return {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 42,
    title: "Indexed issue",
    state: "open",
    author: "mona",
    labels: [],
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-04T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  };
}

function scanChange(): VaultIndexScanChange {
  return {
    relative_path: "github.com/acme/app/issues/42/issue.md",
    size: 100,
    modified_ns: "1721790000000000000",
    content_hash: "abc12345",
    frontmatter: "kind: issue",
    frontmatter_error: false,
    expected: null
  };
}

function parsedChange(): VaultParsedIndexChange {
  const change = scanChange();
  return {
    relative_path: change.relative_path,
    size: change.size,
    modified_ns: change.modified_ns,
    content_hash: change.content_hash,
    expected: change.expected,
    candidate: itemIndexRecord("/vault", {
      path: "/vault/github.com/acme/app/issues/42/issue.md",
      body: "",
      frontMatter: itemFrontMatter()
    })
  };
}

describe("reconcileVaultItemIndex", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    terminateMock.mockReset();
    workerCreated = 0;
    workerError = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scans, parses in a worker, commits once, and combines counts", async () => {
    invokeMock
      .mockResolvedValueOnce({
        changes: [scanChange()],
        removed_paths: [],
        scanned: 3,
        read: 1,
        unchanged: 2,
        deferred: 0
      })
      .mockResolvedValueOnce({
        upserted: 1,
        removed: 0,
        projection_changed: true,
        deferred: 0
      });
    installWorkerReply({ changes: [parsedChange()], invalidCount: 0 });

    await expect(reconcileVaultItemIndex("/vault")).resolves.toEqual({
      scanned: 3,
      read: 1,
      unchanged: 2,
      upserted: 1,
      removed: 0,
      projectionChanged: true,
      deferred: 0
    });
    expect(invokeMock).toHaveBeenCalledWith("scan_vault_item_index_changes", {
      vaultPath: "/vault",
      force: false
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "commit_vault_item_index_changes",
      expect.any(Object)
    );
    expect(terminateMock).toHaveBeenCalledOnce();
  });

  it("skips the worker and commit when the scan has no changes", async () => {
    invokeMock.mockResolvedValueOnce({
      changes: [],
      removed_paths: [],
      scanned: 3,
      read: 0,
      unchanged: 3,
      deferred: 1
    });

    await expect(reconcileVaultItemIndex("/vault", true)).resolves.toEqual({
      scanned: 3,
      read: 0,
      unchanged: 3,
      upserted: 0,
      removed: 0,
      projectionChanged: false,
      deferred: 1
    });
    expect(workerCreated).toBe(0);
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("scan_vault_item_index_changes", {
      vaultPath: "/vault",
      force: true
    });
  });

  it("commits deletion-only scans without creating a worker", async () => {
    invokeMock
      .mockResolvedValueOnce({
        changes: [],
        removed_paths: [
          {
            relative_path: "github.com/acme/app/issues/42/issue.md",
            expected: {
              content_hash: "abc12345",
              size: 100,
              modified_ns: "1721790000000000000"
            }
          }
        ],
        scanned: 2,
        read: 0,
        unchanged: 2,
        deferred: 0
      })
      .mockResolvedValueOnce({
        upserted: 0,
        removed: 1,
        projection_changed: true,
        deferred: 0
      });

    await expect(reconcileVaultItemIndex("/vault")).resolves.toMatchObject({
      removed: 1
    });
    expect(workerCreated).toBe(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "commit_vault_item_index_changes",
      expect.objectContaining({
        vaultPath: "/vault",
        changes: [],
        forceProjection: false,
        removedPaths: expect.any(Array)
      })
    );
  });

  it("terminates a failed worker without committing", async () => {
    invokeMock.mockResolvedValueOnce({
      changes: [scanChange()],
      removed_paths: [],
      scanned: 1,
      read: 1,
      unchanged: 0,
      deferred: 0
    });
    installWorkerReply(null);
    workerError = "YAML worker failed";

    await expect(reconcileVaultItemIndex("/vault")).rejects.toThrow(
      "YAML worker failed"
    );
    expect(terminateMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("adds invalid parser results to the deferred report count", async () => {
    invokeMock
      .mockResolvedValueOnce({
        changes: [scanChange()],
        removed_paths: [],
        scanned: 1,
        read: 1,
        unchanged: 0,
        deferred: 2
      })
      .mockResolvedValueOnce({
        upserted: 0,
        removed: 0,
        projection_changed: false,
        deferred: 3
      });
    installWorkerReply({ changes: [], invalidCount: 4 });

    await expect(reconcileVaultItemIndex("/vault")).resolves.toMatchObject({
      deferred: 9
    });
  });
});
