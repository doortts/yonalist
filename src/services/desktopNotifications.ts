import { isTauri } from "./oauth";

/**
 * Native OS notifications via the Tauri notification plugin. Outside the
 * desktop app it falls back to the Web Notifications API when available,
 * and is a no-op where neither exists.
 */

interface DesktopNotification {
  title: string;
  body: string;
}

let permissionGranted: boolean | null = null;

export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted !== null) {
    return permissionGranted;
  }

  if (isTauri()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    let granted = await plugin.isPermissionGranted();
    if (!granted) {
      granted = (await plugin.requestPermission()) === "granted";
    }
    permissionGranted = granted;
    return granted;
  }

  if (typeof Notification === "undefined") {
    permissionGranted = false;
    return false;
  }
  if (Notification.permission === "granted") {
    permissionGranted = true;
    return true;
  }
  if (Notification.permission === "denied") {
    permissionGranted = false;
    return false;
  }
  permissionGranted = (await Notification.requestPermission()) === "granted";
  return permissionGranted;
}

export async function sendDesktopNotification(
  notification: DesktopNotification
): Promise<void> {
  if (!(await ensureNotificationPermission())) {
    return;
  }

  if (isTauri()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    plugin.sendNotification({
      title: notification.title,
      body: notification.body
    });
    return;
  }

  if (typeof Notification !== "undefined") {
    new Notification(notification.title, { body: notification.body });
  }
}
