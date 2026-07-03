import { isTauri } from "./oauth";

/** Opens a URL in the user's default browser (native in Tauri). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
