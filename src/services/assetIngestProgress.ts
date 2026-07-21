import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const ASSET_INGEST_PROGRESS_EVENT = "notes://asset-ingest-progress";

export type AssetIngestPhase = "hashing" | "copying" | "done";

export interface AssetIngestProgress {
  requestId: string;
  phase: AssetIngestPhase;
  bytesDone: number;
  bytesTotal: number;
  contentHash?: string;
}

export interface AssetIngestProgressListenerOptions {
  requestId?: string;
  onProgress: (progress: AssetIngestProgress) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssetIngestProgress(value: unknown): value is AssetIngestProgress {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !keys.every((key) =>
      ["requestId", "phase", "bytesDone", "bytesTotal", "contentHash"].includes(key)
    ) ||
    keys.length < 4 ||
    keys.length > 5 ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    (value.phase !== "hashing" &&
      value.phase !== "copying" &&
      value.phase !== "done") ||
    typeof value.bytesDone !== "number" ||
    typeof value.bytesTotal !== "number" ||
    !Number.isSafeInteger(value.bytesDone) ||
    !Number.isSafeInteger(value.bytesTotal) ||
    value.bytesDone < 0 ||
    value.bytesTotal < 0 ||
    value.bytesDone > value.bytesTotal
  ) {
    return false;
  }
  const hasContentHash =
    typeof value.contentHash === "string" &&
    /^[0-9a-f]{64}$/u.test(value.contentHash);
  return value.phase === "done"
    ? hasContentHash
    : value.contentHash === undefined;
}

export function createAssetIngestRequestId(): string {
  if (
    typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.randomUUID !== "function"
  ) {
    throw new Error("Asset ingest requires crypto.randomUUID.");
  }
  return globalThis.crypto.randomUUID();
}

export async function startAssetIngestProgressListener(
  options: AssetIngestProgressListenerOptions
): Promise<UnlistenFn> {
  let active = true;
  const unlisten = await listen<unknown>(ASSET_INGEST_PROGRESS_EVENT, (event) => {
    if (
      active &&
      isAssetIngestProgress(event.payload) &&
      (options.requestId === undefined || event.payload.requestId === options.requestId)
    ) {
      options.onProgress(event.payload);
    }
  });
  return () => {
    if (!active) return;
    active = false;
    unlisten();
  };
}
