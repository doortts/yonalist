import { FolderSync } from "lucide-react";
import { useEffect, useState } from "react";

import type { SyncVaultFolderState } from "../../../packages/contracts/generated/SyncVaultFolderState";
import { messageFrom } from "./store/storeSupport";
import { pickVaultFolder } from "./vaultPicker";

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

/**
 * Offered once, on a first run, and asked before anything is written: the guide
 * notes are this device's own claim on every line they occupy, and a device
 * joining a folder that already holds notes must not make that claim. So the
 * folder is settled first, and only a device that is starting its notes here is
 * given a guide.
 *
 * A first run is a database nobody has answered for, and `isFirstRun` is the
 * only thing this card asks. It used to read the recorded folder — which says
 * nothing about a user who answered "Later" — and a `localStorage` flag of its
 * own, which outlived every reset the app can do: one "Later" and the card could
 * never come back, on any database. Both are gone.
 *
 * It still never blocks the outliner. Answering "Later" is a decision too —
 * these notes start here — so it takes the guide, and the guide records the
 * answer.
 */
export function VaultSetupCard({
  isFirstRun,
  setVaultPath,
  writeGuide
}: {
  readonly isFirstRun: () => Promise<boolean>;
  readonly setVaultPath: (path: string) => Promise<SyncVaultFolderState>;
  readonly writeGuide: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void isFirstRun()
      .then((first) => {
        if (!cancelled && first) setOpen(true);
      })
      .catch(() => {
        // The database cannot answer, so a folder could not be recorded in it
        // either — asking for one here would only offer a button that fails.
      });
    return () => {
      cancelled = true;
    };
  }, [isFirstRun]);

  const dismiss = () => {
    setOpen(false);
    void writeGuide().catch(() => {
      // Nothing to say to the user: they asked to be left alone, and an
      // outline with no guide in it is the same outline they already have.
    });
  };

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = await pickVaultFolder();
      if (chosen === null) return;
      const state = await setVaultPath(chosen);
      // Only a folder that is not already somebody's notes. Writing a guide
      // into a shared folder would restate every line of it as this device's
      // own, newer than anything the other device has said about them.
      if (state !== "existingVault") await writeGuide();
      const sentence = folderNotice[state];
      if (sentence === null) {
        setOpen(false);
        return;
      }
      setNotice(sentence);
    } catch (cause) {
      // The backend distinguishes a folder it will not take from storage it
      // cannot reach; `instanceof` on a serialized error erases both.
      setError(messageFrom(cause));
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
