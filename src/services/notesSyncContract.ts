export interface SyncStatus {
  running: boolean;
  dirtyTopics: number;
  quarantined: string[];
  lastExportAt: string | null;
  lastMergeAt: string | null;
  // C5: optional so the gate passes before Track B adds the Rust `lastError`
  // field. Field name is fixed across the Rust/TS boundary.
  lastError?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// C5: forward compatible — require the known keys with correct types but allow
// extra keys so a newer backend can add fields without failing validation.
function hasRequiredKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return keys.every((key) => key in value);
}

export function isSyncStatus(value: unknown): value is SyncStatus {
  return (
    isRecord(value) &&
    hasRequiredKeys(value, [
      "running",
      "dirtyTopics",
      "quarantined",
      "lastExportAt",
      "lastMergeAt"
    ]) &&
    typeof value.running === "boolean" &&
    Number.isSafeInteger(value.dirtyTopics) &&
    (value.dirtyTopics as number) >= 0 &&
    Array.isArray(value.quarantined) &&
    value.quarantined.every((fileName) => typeof fileName === "string") &&
    (value.lastExportAt === null || typeof value.lastExportAt === "string") &&
    (value.lastMergeAt === null || typeof value.lastMergeAt === "string") &&
    (value.lastError === undefined ||
      value.lastError === null ||
      typeof value.lastError === "string")
  );
}
