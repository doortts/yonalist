import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_INGEST_PROGRESS_EVENT,
  createAssetIngestRequestId,
  startAssetIngestProgressListener
} from "./assetIngestProgress";

const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

describe("asset ingest progress", () => {
  beforeEach(() => listenMock.mockReset());

  it("creates a UUID request ID", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID });

    expect(createAssetIngestRequestId()).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("filters the fixed payload by request and cleans up idempotently", async () => {
    const unlisten = vi.fn();
    let handler: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (_event, nextHandler) => {
      handler = nextHandler;
      return unlisten;
    });
    const onProgress = vi.fn();

    const cleanup = await startAssetIngestProgressListener({
      requestId: "request-a",
      onProgress
    });

    expect(listenMock).toHaveBeenCalledWith(
      ASSET_INGEST_PROGRESS_EVENT,
      expect.any(Function)
    );
    handler?.({
      payload: {
        requestId: "request-b",
        phase: "hashing",
        bytesDone: 1,
        bytesTotal: 2
      }
    });
    handler?.({ payload: { requestId: "request-a", phase: "hashing" } });
    handler?.({
      payload: {
        requestId: "request-a",
        phase: "done",
        bytesDone: 2,
        bytesTotal: 2
      }
    });
    handler?.({
      payload: {
        requestId: "request-a",
        phase: "copying",
        bytesDone: 2,
        bytesTotal: 2,
        contentHash: "a".repeat(64)
      }
    });
    handler?.({
      payload: {
        requestId: "request-a",
        phase: "done",
        bytesDone: 2,
        bytesTotal: 2,
        contentHash: "a".repeat(64)
      }
    });

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({
      requestId: "request-a",
      phase: "done",
      bytesDone: 2,
      bytesTotal: 2,
      contentHash: "a".repeat(64)
    });
    cleanup();
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
