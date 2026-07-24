import { afterEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import {
  notesImportAttachmentBytes,
  notesImportAttachmentPaths,
  notesImportMarkdown,
  notesInitialize,
  notesLoadWorkspace,
  notesDeleteNodes,
  notesRepairData,
  notesStore
} from "./notesStore";

const tauriCoreFactoryEvaluated = vi.hoisted(() => ({ current: false }));
const invokeMock = vi.hoisted(() => vi.fn());
const historyContext = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  historyEpoch: "epoch-a",
  entryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  commandKind: "attachment"
};

vi.mock("@tauri-apps/api/core", () => {
  tauriCoreFactoryEvaluated.current = true;
  return {
    invoke: invokeMock
  };
});

describe("notesStore outside Tauri", () => {
  it("exposes image-atom receipt lookup and acknowledgement adapters", () => {
    expect("lookupImageAtomOperation" in notesStore).toBe(true);
    expect("ackImageAtomOperation" in notesStore).toBe(true);
    expect("applyImageAtomEdit" in notesStore).toBe(true);
    expect("applyImageAtomPaste" in notesStore).toBe(true);
  });

  it("exposes all v3 mutation adapters on the production store", () => {
    expect(notesStore.setReadonly).toEqual(expect.any(Function));
    expect(notesStore.deleteNodes).toEqual(expect.any(Function));
    expect(
      notesStore.materializeGithubNotificationAndCreateSibling
    ).toEqual(expect.any(Function));
    expect(
      notesStore.materializeGithubNotificationAndReparent
    ).toEqual(expect.any(Function));
    expect(notesStore.refreshMaterializedGithubNotifications).toEqual(
      expect.any(Function)
    );
    expect(notesStore.setGithubGroupCollapsed).toEqual(expect.any(Function));
    expect(notesStore.markMaterializedGithubNotificationRead).toEqual(
      expect.any(Function)
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.localStorage.clear();
    tauriCoreFactoryEvaluated.current = false;
    invokeMock.mockReset();
  });

  it("rejects Notes access outside Tauri instead of writing localStorage", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    tauriCoreFactoryEvaluated.current = false;

    const error = await notesLoadWorkspace("/vault", {
      kind: "active"
    }).catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Notes requires Tauri desktop storage."
    );
    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("yonalist.notes.v1")).toBeNull();
  });

  it("rejects path and raw attachment batches before loading Tauri IPC", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    const nodeId = "11111111-1111-4111-8111-111111111111";
    const attachmentId = "22222222-2222-4222-8222-222222222222";

    await expect(
      notesImportAttachmentPaths(
        "/vault",
        {
          nodeId,
          attachments: [{ id: attachmentId, sourcePath: "/tmp/image.png" }],
          initialMaxDisplayWidth: 480
        },
        historyContext
      )
    ).rejects.toMatchObject({
      message: "Notes requires Tauri desktop storage.",
      operation: "write",
      retryable: true
    });
    await expect(
      notesImportAttachmentBytes(
        "/vault",
        {
          nodeId,
          attachments: [
            {
              id: attachmentId,
              originalName: "image.png",
              mimeType: "image/png",
              blob: new NodeBlob([Uint8Array.of(1)], {
                type: "image/png"
              }) as Blob
            }
          ],
          initialMaxDisplayWidth: 480
        },
        historyContext
      )
    ).rejects.toMatchObject({
      message: "Notes requires Tauri desktop storage.",
      operation: "write",
      retryable: true
    });

    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects Markdown imports outside Tauri and rejects invalid input before IPC", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    const markdownHistoryContext = {
      ...historyContext,
      commandKind: "importMarkdown"
    };
    const validInput = {
      sourcePath: "/imports/notes-export.md",
      parentId: null,
      afterId: null
    };

    await expect(
      notesImportMarkdown(
        "/vault",
        { sourcePath: "", parentId: null, afterId: null } as typeof validInput,
        markdownHistoryContext
      )
    ).rejects.toMatchObject({
      message: "Notes Markdown import input is invalid.",
      operation: "write",
      retryable: false
    });
    await expect(
      notesImportMarkdown("/vault", validInput, markdownHistoryContext)
    ).rejects.toMatchObject({
      message: "Notes requires Tauri desktop storage.",
      operation: "write",
      retryable: true
    });

    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("yonalist.notes.v1")).toBeNull();
  });
});

describe("notesStore structured errors", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    tauriCoreFactoryEvaluated.current = false;
    invokeMock.mockReset();
  });

  it("parses the backend code and marks unsupportedSchemaVersion non-retryable", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockRejectedValue({
      code: "unsupportedSchemaVersion",
      message: "This Notes database uses unsupported schema version 99."
    });

    const error = await notesLoadWorkspace("/vault", { kind: "active" }).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toMatchObject({
      operation: "load",
      code: "unsupportedSchemaVersion",
      retryable: false,
      message: "This Notes database uses unsupported schema version 99."
    });
  });

  it("normalizes structured initialization failures", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockRejectedValue({
      code: "vaultBusy",
      message: "Notes vault is already open in another window."
    });

    await expect(
      notesInitialize("/vault", {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      operation: "load",
      code: "vaultBusy",
      retryable: true,
      message: "Notes vault is already open in another window."
    });
  });

  it("never stringifies malformed initialization objects", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockRejectedValue({ detail: "opaque" });

    await expect(
      notesInitialize("/vault", {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      operation: "load",
      code: "internal",
      message: "Notes request failed."
    });
  });

  it("derives a retryable error from the vaultBusy code", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockRejectedValue({
      code: "vaultBusy",
      message: "Notes vault is already open in another window."
    });

    const error = await notesLoadWorkspace("/vault", { kind: "active" }).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toMatchObject({
      operation: "load",
      code: "vaultBusy",
      retryable: true
    });
  });

  it("classifies an unstructured transport failure as retryable internal", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockRejectedValue(new Error("IPC channel closed"));

    const error = await notesLoadWorkspace("/vault", { kind: "active" }).catch(
      (rejection: unknown) => rejection
    );

    expect(error).toMatchObject({
      operation: "load",
      code: "internal",
      retryable: true,
      message: "IPC channel closed"
    });
  });

  it("preserves readonly delete preflight responses without mutation normalization", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    const readonlyId = "11111111-1111-4111-8111-111111111111";
    invokeMock.mockResolvedValue({ readonlyDescendantIds: [readonlyId] });

    const result = await notesDeleteNodes(
      "/vault",
      { nodeIds: ["22222222-2222-4222-8222-222222222222"] },
      historyContext
    );

    expect(result).toEqual({ readonlyDescendantIds: [readonlyId] });
    expect(invokeMock).toHaveBeenCalledWith("notes_delete_nodes", {
      vaultPath: "/vault",
      input: { nodeIds: ["22222222-2222-4222-8222-222222222222"] },
      historyContext
    });
  });

  it("normalizes a successful readonly delete mutation wire payload", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockResolvedValue({
      workspace: { nodes: [], attachmentsByNodeId: {} },
      historyEntryId: historyContext.entryId,
      canUndo: true,
      canRedo: false,
      historyEpoch: historyContext.historyEpoch,
      nextUndoEntryId: historyContext.entryId,
      nextRedoEntryId: null,
      prunedEntryIds: []
    });

    await expect(
      notesDeleteNodes(
        "/vault",
        { nodeIds: ["22222222-2222-4222-8222-222222222222"] },
        historyContext
      )
    ).resolves.toMatchObject({
      historyEntryId: historyContext.entryId,
      workspace: { nodes: [], attachmentsByNodeId: {} }
    });
  });

  it("rejects an ambiguous readonly preflight wire payload", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockResolvedValue({
      readonlyDescendantIds: ["11111111-1111-4111-8111-111111111111"],
      kind: "NeedsReadonlyConfirmation"
    });

    await expect(
      notesDeleteNodes(
        "/vault",
        { nodeIds: ["22222222-2222-4222-8222-222222222222"] },
        historyContext
      )
    ).rejects.toMatchObject({
      operation: "write",
      retryable: false,
      message: "Notes mutation returned an invalid result."
    });
  });
});

describe("notesStore data repair", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    invokeMock.mockReset();
  });

  it("validates the Notes data repair report", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockResolvedValue({
      repairedNodeCount: 3,
      backedUpFileCount: 3,
      backupPath: "/vault/.yonalist/notes-repair-backups/repair-1"
    });

    await expect(notesRepairData("/vault")).resolves.toEqual({
      repairedNodeCount: 3,
      backedUpFileCount: 3,
      backupPath: "/vault/.yonalist/notes-repair-backups/repair-1"
    });
    expect(invokeMock).toHaveBeenCalledWith("notes_repair_data", {
      vaultPath: "/vault"
    });
  });

  it("normalizes backend repair failures for the shared UI action", async () => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockRejectedValue({
      code: "internal",
      message: "Could not open the Notes repair backup."
    });

    await expect(notesRepairData("/vault")).rejects.toMatchObject({
      operation: "write",
      code: "internal",
      retryable: true,
      message: "Could not open the Notes repair backup."
    });
  });

  it.each([
    {},
    { repairedNodeCount: -1, backedUpFileCount: 0, backupPath: null },
    { repairedNodeCount: 1.5, backedUpFileCount: 1, backupPath: "/backup" },
    { repairedNodeCount: 1, backedUpFileCount: 1, backupPath: 42 },
    {
      repairedNodeCount: 0,
      backedUpFileCount: 0,
      backupPath: null,
      extra: true
    },
    { repairedNodeCount: 0, backedUpFileCount: 1, backupPath: "/backup" }
  ])("rejects malformed Notes repair report %#", async (result) => {
    Reflect.set(window, "__TAURI_INTERNALS__", {});
    invokeMock.mockResolvedValue(result);

    await expect(notesRepairData("/vault")).rejects.toThrow(
      "Notes data repair returned an invalid report."
    );
  });
});
