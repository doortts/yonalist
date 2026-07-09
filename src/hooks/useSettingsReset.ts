import { useState } from "react";
import { showAppSnackbar } from "../components/AppSnackbar";
import {
  idleResetProgress,
  type ResetProgressItem,
  type ResetProgressState,
  type ResetProgressStepStatus
} from "../resetProgress";
import {
  resetApplicationData,
  type ResetApplicationStepId
} from "../services/appReset";

const resetStepTemplates: Array<{
  id: ResetApplicationStepId | "restore-defaults";
  label: string;
}> = [
  { id: "session-tokens", label: "Sign out saved GitHub sessions" },
  { id: "runtime-caches", label: "Clear in-memory notification and thread caches" },
  { id: "local-storage", label: "Clear local settings and browser caches" },
  { id: "vault-cache", label: "Clear vault index, avatar, and search caches" },
  { id: "restore-defaults", label: "Restore app preferences to defaults" }
];

function createResetProgress(): ResetProgressState {
  return {
    status: "running",
    message: "Resetting settings and caches...",
    steps: resetStepTemplates.map((step) => ({
      ...step,
      status: "pending"
    }))
  };
}

export interface UseSettingsResetOptions {
  vaultRoot: string;
  serverUrls: string[];
  /** Restores caller-owned state (settings, theme, selections) to defaults. */
  onRestoreDefaults: () => void;
  /** Mirrors progress into the settings page status line. */
  onStatus: (status: string) => void;
}

/**
 * The "reset everything" flow behind Settings → Reset: drives
 * `resetApplicationData` step by step, tracks per-step progress for the
 * progress list, and finishes by asking the caller to restore its own state.
 */
export function useSettingsReset(options: UseSettingsResetOptions) {
  const { vaultRoot, serverUrls, onRestoreDefaults, onStatus } = options;
  const [resetProgress, setResetProgress] =
    useState<ResetProgressState>(idleResetProgress);

  function updateResetStep(
    id: ResetProgressItem["id"],
    status: ResetProgressStepStatus,
    detail?: string
  ) {
    setResetProgress((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === id
          ? {
              ...step,
              status,
              detail: detail ?? step.detail
            }
          : step
      )
    }));
  }

  function failCurrentResetStep(message: string) {
    setResetProgress((current) => ({
      status: "failed",
      message: `Reset failed: ${message}`,
      steps: current.steps.map((step) =>
        step.status === "running"
          ? {
              ...step,
              status: "failed",
              detail: message
            }
          : step
      )
    }));
  }

  async function resetAllSettingsAndCaches() {
    setResetProgress(createResetProgress());
    onStatus("Resetting...");
    try {
      await resetApplicationData({
        vaultRoot,
        serverUrls,
        onStep: ({ id, status }) => {
          updateResetStep(id, status === "complete" ? "done" : "running");
        }
      });
      updateResetStep("restore-defaults", "running");
      onRestoreDefaults();
      updateResetStep("restore-defaults", "done");
      onStatus("Settings and caches reset");
      setResetProgress((current) => ({
        ...current,
        status: "done",
        message: "Reset complete. Vault Markdown files and outbox documents were kept."
      }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      failCurrentResetStep(message);
      onStatus(`Reset failed: ${message}`);
      showAppSnackbar(`Reset failed: ${message}`);
    }
  }

  return { resetProgress, resetAllSettingsAndCaches };
}
