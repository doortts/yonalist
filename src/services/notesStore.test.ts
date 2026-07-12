import { afterEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import {
  notesImportAttachmentBytes,
  notesImportAttachmentPaths,
  notesLoadWorkspace
} from "./notesStore";

const tauriCoreFactoryEvaluated = vi.hoisted(() => ({ current: false }));
const invokeMock = vi.hoisted(() => vi.fn());

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
      notesImportAttachmentPaths("/vault", {
        nodeId,
        attachments: [{ id: attachmentId, sourcePath: "/tmp/image.png" }],
        initialMaxDisplayWidth: 480
      })
    ).rejects.toMatchObject({
      message: "Notes requires Tauri desktop storage.",
      operation: "write",
      retryable: true
    });
    await expect(
      notesImportAttachmentBytes("/vault", {
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
      })
    ).rejects.toMatchObject({
      message: "Notes requires Tauri desktop storage.",
      operation: "write",
      retryable: true
    });

    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
