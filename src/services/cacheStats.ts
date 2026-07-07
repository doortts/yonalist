export interface CacheSizeStats {
  entries: number;
  bytes: number;
}

const encoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

export function estimateTextBytes(value: string): number {
  return encoder ? encoder.encode(value).byteLength : value.length;
}

export function estimateJsonBytes(value: unknown): number {
  try {
    return estimateTextBytes(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export function estimateRecordBytes(record: Record<string, string>): CacheSizeStats {
  return Object.entries(record).reduce<CacheSizeStats>(
    (stats, [key, value]) => ({
      entries: stats.entries + 1,
      bytes: stats.bytes + estimateTextBytes(key) + estimateTextBytes(value)
    }),
    { entries: 0, bytes: 0 }
  );
}
