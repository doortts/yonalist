import { isTauri } from "./oauth";

export function normalizeAppBadgeCount(count: number): number | undefined {
  if (!Number.isFinite(count) || count <= 0) {
    return undefined;
  }
  return Math.trunc(count);
}

export async function setAppBadgeCount(count: number): Promise<void> {
  if (!isTauri()) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setBadgeCount(normalizeAppBadgeCount(count));
}
