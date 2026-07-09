import { Toast } from "@base-ui/react/toast";
import "./ui/toast.css";

// Auto-dismiss timing matches the legacy fixed snackbar (6s).
export const APP_SNACKBAR_TIMEOUT_MS = 6000;

// A standalone manager lets feedback fire from effects, event handlers, and
// hooks anywhere in the app without needing the `useToastManager` hook (which
// must run under a Toast.Provider that App itself renders).
export const appToastManager = Toast.createToastManager();

export function showAppSnackbar(message: string) {
  appToastManager.add({ title: message, timeout: APP_SNACKBAR_TIMEOUT_MS });
}

// Renders the queued toasts inside the provider using the shared manager.
export function AppSnackbarToasts() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="app-snackbar">
      <Toast.Title />
    </Toast.Root>
  ));
}
