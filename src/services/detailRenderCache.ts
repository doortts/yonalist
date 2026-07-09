import {
  estimateTextBytes,
  type CacheSizeStats
} from "./cacheStats";
import { LruCache } from "./lruCache";

export interface DetailRenderSnapshot {
  key: string;
  html: string;
  capturedAt: string;
}

export interface DetailRenderSnapshotInput {
  html: string;
  capturedAt: string;
}

const detailRenderSnapshots = new LruCache<DetailRenderSnapshot>(50);
const snapshotOverlaySelector = '[data-detail-render-snapshot-overlay="true"]';

export function clearDetailRenderSnapshots() {
  detailRenderSnapshots.clear();
}

export function getDetailRenderSnapshot(
  key: string
): DetailRenderSnapshot | null {
  return detailRenderSnapshots.get(key) ?? null;
}

export function setDetailRenderSnapshot(
  key: string,
  snapshot: DetailRenderSnapshotInput
): void {
  detailRenderSnapshots.set(key, { key, ...snapshot });
}

export function deleteDetailRenderSnapshot(key: string): boolean {
  return detailRenderSnapshots.delete(key);
}

export function getDetailRenderSnapshotStats(): CacheSizeStats {
  return detailRenderSnapshots.entries().reduce<CacheSizeStats>(
    (stats, [key, snapshot]) => ({
      entries: stats.entries + 1,
      bytes:
        stats.bytes +
        estimateTextBytes(key) +
        estimateTextBytes(snapshot.html) +
        estimateTextBytes(snapshot.capturedAt)
    }),
    { entries: 0, bytes: 0 }
  );
}

export function captureDetailRenderSnapshotHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(snapshotOverlaySelector).forEach((node) => {
    node.remove();
  });
  removeWhitespaceOnlyTextNodes(clone);
  return clone.innerHTML.trim();
}

function removeWhitespaceOnlyTextNodes(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!child.textContent?.trim()) {
        child.remove();
      }
      continue;
    }
    removeWhitespaceOnlyTextNodes(child);
  }
}
