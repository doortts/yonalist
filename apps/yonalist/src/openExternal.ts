import { invoke } from "@tauri-apps/api/core";

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function openExternalUrl(value: string): Promise<void> {
  if (!isSafeExternalUrl(value)) {
    throw new Error("Only http(s) links can be opened.");
  }
  if ("__TAURI_INTERNALS__" in window) {
    await invoke("open_external_url", { url: value });
    return;
  }
  const opened = window.open(value, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}
