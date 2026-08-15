import { FolderSync } from "lucide-react";
import { useEffect, useState } from "react";

import type { SyncVaultFolderState } from "../../../packages/contracts/generated/SyncVaultFolderState";
import { pickVaultFolder } from "./vaultPicker";

const dismissedStorageKey = "yonalist.vaultPromptDismissed.v1";

/**
 * What a chosen folder gets told about itself. An empty folder needs no
 * sentence, so choosing one closes the card outright.
 */
const folderNotice: Record<SyncVaultFolderState, string | null> = {
  empty: null,
  existingVault:
    "That folder already holds Yonalist notes. They will be merged with what "
    + "is on this device once syncing starts.",
  nonEmpty:
    "That folder already holds other files. Yonalist works best in a folder "
    + "of its own, so its own files stay easy to tell apart."
};

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(dismissedStorageKey) !== null;
  } catch {
    return false;
  }
}

function rememberDismissal() {
  try {
    window.localStorage.setItem(dismissedStorageKey, "1");
  } catch {
    // The card stays gone for this session even without persistence.
  }
}

/**
 * Offered once, on the first launch that has no vault yet. It never blocks the
 * outliner: a single-device user loses nothing by skipping it, and the settings
 * screen keeps the choice open afterwards.
 */
export function VaultSetupCard({
  readVaultPath,
  setVaultPath
}: {
  readonly readVaultPath: () => Promise<string | null>;
  readonly setVaultPath: (path: string) => Promise<SyncVaultFolderState>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (wasDismissed()) return;
    let cancelled = false;
    void readVaultPath()
      .then((stored) => {
        if (!cancelled && stored === null) setOpen(true);
      })
      .catch(() => {
        // A folder cannot be recorded while the path cannot even be read, so
        // asking for one here would only offer a button that fails.
      });
    return () => {
      cancelled = true;
    };
  }, [readVaultPath]);

  const dismiss = () => {
    rememberDismissal();
    setOpen(false);
  };

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = await pickVaultFolder();
      if (chosen === null) return;
      const state = await setVaultPath(chosen);
      const sentence = folderNotice[state];
      if (sentence === null) {
        setOpen(false);
        return;
      }
      setNotice(sentence);
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "Notes could not use that folder.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <aside className="vault-setup-card" aria-label="Choose a sync folder">
      <div className="settings-section-title">
        <FolderSync size={18} aria-hidden="true" />
        <h3>Keep a markdown copy?</h3>
      </div>
      <p className="settings-copy">
        Pick a folder and Yonalist writes your notes there as markdown files,
        so another device can pick them up through iCloud, Dropbox, or any
        folder that syncs. You can decide later in Settings.
      </p>
      {error && <p className="notes-inline-error" role="alert">{error}</p>}
      {notice ? (
        <>
          <p className="settings-copy" role="status">{notice}</p>
          <button type="button" onClick={() => setOpen(false)}>Got it</button>
        </>
      ) : (
        <div className="vault-setup-actions">
          <button type="button" disabled={busy} onClick={() => void choose()}>
            Choose folder
          </button>
          <button type="button" disabled={busy} onClick={dismiss}>
            Later
          </button>
        </div>
      )}
    </aside>
  );
}
