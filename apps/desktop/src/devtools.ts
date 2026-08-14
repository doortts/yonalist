import { invoke } from "@tauri-apps/api/core";
import { outlinePlatform } from "./outline/outlineSupport";

// The platform standard: Cmd+Alt+I on macOS, Ctrl+Shift+I everywhere else.
// Keyed off `event.code` rather than `event.key` because Option+I on macOS is a
// dead key that reports a diacritic instead of "i".
export function isDevtoolsShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "KeyI") return false;
  return outlinePlatform() === "mac"
    ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
}

// Cmd+Alt+Shift+D on macOS, Ctrl+Alt+Shift+D elsewhere: paints every window
// drag region, so a window that will not move can be told apart from one whose
// drag regions are simply not where you thought they were. Shift is in the
// chord because macOS takes plain Cmd+Alt+D for hiding the Dock, and the OS
// eats it before the webview ever sees the key.
export function isDragDebugShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "KeyD" || !event.altKey || !event.shiftKey) return false;
  return outlinePlatform() === "mac"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

// A no-op in the browser preview, which has the browser's own devtools anyway.
export async function toggleDevtools(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  await invoke("notes_toggle_devtools");
}
