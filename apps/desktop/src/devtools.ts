import { invoke } from "@tauri-apps/api/core";
import { outlinePlatform } from "./outlineSupport";

// The platform standard: Cmd+Alt+I on macOS, Ctrl+Shift+I everywhere else.
// Keyed off `event.code` rather than `event.key` because Option+I on macOS is a
// dead key that reports a diacritic instead of "i".
export function isDevtoolsShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "KeyI") return false;
  return outlinePlatform() === "mac"
    ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
}

// A no-op in the browser preview, which has the browser's own devtools anyway.
export async function toggleDevtools(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  await invoke("notes_toggle_devtools");
}
