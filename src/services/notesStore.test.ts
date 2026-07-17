import { afterEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import {
  notesImportAttachmentBytes,
  notesImportAttachmentPaths,
  notesInitialize,
  notesLoadWorkspace
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
});
