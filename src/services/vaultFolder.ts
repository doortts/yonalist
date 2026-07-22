import { isTauri } from "./oauth";

/**
 * Opens the OS-native folder picker so the user can choose a vault directory.
 * Returns the selected absolute path, or null when the picker is cancelled or
 * when running outside the Tauri desktop runtime (e.g. the Vite web preview).
 */
export async function pickVaultFolder(current: string): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    defaultPath: current.trim() || undefined
  });
  return typeof selected === "string" ? selected : null;
}
