export interface SyncStatus {
  running: boolean;
  dirtyTopics: number;
  quarantined: string[];
  lastExportAt: string | null;
  lastMergeAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

export function isSyncStatus(value: unknown): value is SyncStatus {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
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
    (value.lastMergeAt === null || typeof value.lastMergeAt === "string")
  );
}
