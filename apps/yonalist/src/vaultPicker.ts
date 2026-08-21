/**
 * Asks the user for the folder the markdown vault lives in. Outside the Tauri
 * runtime there is no folder picker at all, so a browser preview reports the
 * same thing a dismissed dialog does: no choice was made.
 */
export async function pickVaultFolder(): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}
