import { Radio, RadioGroup } from "@base-ui/react";
import { Database, FolderSync, History, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { SyncAttachment } from "../../../packages/contracts/generated/SyncAttachment";
import type { SyncConflict } from "../../../packages/contracts/generated/SyncConflict";
import type { SyncConflictSide } from "../../../packages/contracts/generated/SyncConflictSide";
import { AttachmentsSection } from "./AttachmentsSection";
import type { UnusedAssetsReport } from "../../../packages/contracts/generated/UnusedAssetsReport";
import type { VaultRebuildReport } from "../../../packages/contracts/generated/VaultRebuildReport";
import {
  MAX_OUTLINE_MARKER_LEVELS,
  normalizeMarkerChar,
  type OutlineMarkerShape,
  type OutlineMarkerStyle
} from "./outlineMarkers";
import { messageFrom } from "./store/storeSupport";
import { pickVaultFolder } from "./vaultPicker";
import type {
  CaretColor,
  DarkTheme,
  HandwritingFace,
  LightTheme,
  TextFont,
  ThemeMode
} from "./useTheme";

const themeModeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

const lightThemeOptions: Array<{ value: LightTheme; label: string }> = [
  { value: "soft-paper", label: "Soft Paper" },
  { value: "default", label: "Default" },
  { value: "yona", label: "Yona" },
  { value: "yonal-light", label: "Yonal Light" },
  { value: "base-light", label: "Base Light" }
];

const darkThemeOptions: Array<{ value: DarkTheme; label: string }> = [
  { value: "dark", label: "Default" },
  { value: "yona-dark", label: "Yonal Dark" },
  { value: "base-dark", label: "Base Dark" }
];

const textFontOptions: Array<{ value: TextFont; label: string }> = [
  { value: "sans", label: "Sans" },
  { value: "mono", label: "Monospace" },
  { value: "hand", label: "Handwriting" }
];

/*
 * Excalidraw writes in two faces at once -- Excalifont for Latin, Xiaolai for
 * Hangul, which is what excalidraw.com shows. The rest each draw both scripts.
 */
const handwritingFaceOptions: Array<{ value: HandwritingFace; label: string }> = [
  { value: "excalidraw", label: "Excalidraw" },
  { value: "nanum", label: "Nanum Pen" },
  { value: "gaegu", label: "Gaegu" },
  { value: "gamja-flower", label: "Gamja Flower" },
  { value: "poor-story", label: "Poor Story" },
  { value: "single-day", label: "Single Day" }
];

const markerShapeOptions: Array<{ value: OutlineMarkerShape; label: string }> = [
  { value: "dot", label: "Dot" },
  { value: "square", label: "Square" },
  { value: "hyphen", label: "Hyphen" },
  { value: "dash", label: "Dash" },
  { value: "custom", label: "Custom" }
];

/** What the picker offers first once a level turns custom. */
const defaultCustomMarker = "▸";
/** What the colour input opens on while a level is still on the theme colour. */
const defaultMarkerColor = "#a8afb8";

const caretColorOptions: Array<{ value: string; label: string }> = [
  { value: "#0a84ff", label: "System Blue" },
  { value: "#bf5af2", label: "Purple" },
  { value: "#ff375f", label: "Pink" },
  { value: "#30d158", label: "Green" },
  { value: "#ff9f0a", label: "Orange" },
  { value: "#ffd60a", label: "Yellow" }
];

export function SettingsView({
  themeMode,
  lightTheme,
  darkTheme,
  caretColor,
  textFont,
  handwritingFace,
  markerStyles,
  onThemeModeChange,
  onLightThemeChange,
  onDarkThemeChange,
  onCaretColorChange,
  onTextFontChange,
  onHandwritingFaceChange,
  onMarkerStylesChange,
  onClose,
  unusedAssets,
  deleteAllData,
  rebuildFromVault,
  readVaultPath,
  setVaultPath,
  readConflicts,
  restoreConflict,
  forgetConflict,
  readAttachments,
  deleteAttachment,
  openNode
}: {
  readonly themeMode: ThemeMode;
  readonly lightTheme: LightTheme;
  readonly darkTheme: DarkTheme;
  readonly caretColor: CaretColor;
  readonly textFont: TextFont;
  readonly handwritingFace: HandwritingFace;
  readonly markerStyles: readonly OutlineMarkerStyle[];
  readonly onThemeModeChange: (mode: ThemeMode) => void;
  readonly onLightThemeChange: (theme: LightTheme) => void;
  readonly onDarkThemeChange: (theme: DarkTheme) => void;
  readonly onCaretColorChange: (color: CaretColor) => void;
  readonly onTextFontChange: (font: TextFont) => void;
  readonly onHandwritingFaceChange: (face: HandwritingFace) => void;
  readonly onMarkerStylesChange: (styles: OutlineMarkerStyle[]) => void;
  readonly onClose: () => void;
  readonly unusedAssets: (purge: boolean) => Promise<UnusedAssetsReport>;
  readonly deleteAllData: () => Promise<void>;
  readonly rebuildFromVault: () => Promise<VaultRebuildReport>;
  readonly readVaultPath: () => Promise<string | null>;
  readonly setVaultPath: (path: string) => Promise<void>;
  readonly readConflicts: () => Promise<readonly SyncConflict[]>;
  readonly restoreConflict: (seq: number) => Promise<void>;
  readonly forgetConflict: (seq: number) => Promise<boolean>;
  readonly readAttachments: (limit: number) => Promise<readonly SyncAttachment[]>;
  readonly deleteAttachment: (contentHash: string) => Promise<boolean>;
  readonly openNode: (pageId: string, nodeId: string) => void;
}) {
  const [conflicts, setConflicts] = useState<readonly SyncConflict[]>([]);
  const [conflictError, setConflictError] = useState<string | null>(null);
  // Read here rather than inside the section that shows them: whether that
  // section is worth listing at all is a question about the count, and the list
  // is drawn before any section is.
  const reloadConflicts = useCallback(async () => {
    try {
      setConflicts(await readConflicts());
    } catch (cause) {
      setConflictError(messageFrom(cause));
    }
  }, [readConflicts]);
  useEffect(() => {
    void reloadConflicts();
  }, [reloadConflicts]);

  const sections: readonly SettingsSectionName[] = [
    "Appearance",
    ...(conflicts.length > 0 || conflictError !== null
      ? (["Overwritten notes"] as const)
      : []),
    "Attachments",
    "Sync folder",
    "Yonalist data"
  ];
  const [chosen, setChosen] = useState<SettingsSectionName>("Appearance");
  // A section can stop being worth listing while it is the one being read — the
  // last record dropped, say. Falling back rather than correcting the choice
  // keeps the list the only answer to what there is.
  const shown = sections.includes(chosen) ? chosen : "Appearance";

  return (
    <section className="settings-page" aria-label="Settings page">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>{shown}</h2>
        </div>
        <button
          type="button"
          className="pane-toggle"
          aria-label="Close settings"
          data-tooltip="Close settings"
          data-tooltip-align="right"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="settings-layout">
        <nav className="settings-section-list" aria-label="Settings sections">
          {sections.map((name) => (
            <button
              key={name}
              type="button"
              aria-current={name === shown ? "page" : undefined}
              onClick={() => setChosen(name)}
            >
              {name}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {shown === "Appearance" && (
            <section className="settings-section">
              <ThemeRadioGroup
                title="Theme mode"
                options={themeModeOptions}
                value={themeMode}
                optionSuffix="mode"
                onChange={onThemeModeChange}
              />
              <ThemeRadioGroup
                title="Light theme"
                options={lightThemeOptions}
                value={lightTheme}
                optionSuffix="light theme"
                onChange={onLightThemeChange}
              />
              <ThemeRadioGroup
                title="Dark theme"
                options={darkThemeOptions}
                value={darkTheme}
                optionSuffix="dark theme"
                onChange={onDarkThemeChange}
              />
              <ThemeRadioGroup
                title="Outline text"
                options={textFontOptions}
                value={textFont}
                optionSuffix="outline text"
                onChange={onTextFontChange}
              />
              {textFont === "hand" && (
                <ThemeRadioGroup
                  title="Handwriting face"
                  options={handwritingFaceOptions}
                  value={handwritingFace}
                  optionSuffix="handwriting face"
                  onChange={onHandwritingFaceChange}
                />
              )}
              <CaretColorGroup value={caretColor} onChange={onCaretColorChange} />
              <OutlineMarkerGroup
                styles={markerStyles}
                onChange={onMarkerStylesChange}
              />
            </section>
          )}

          {shown === "Overwritten notes" && (
            <OverwrittenNotesSection
              conflicts={conflicts}
              error={conflictError}
              reload={reloadConflicts}
              restoreConflict={restoreConflict}
              forgetConflict={forgetConflict}
            />
          )}

          {shown === "Attachments" && (
            <AttachmentsSection
              readAttachments={readAttachments}
              deleteAttachment={deleteAttachment}
              openNode={openNode}
            />
          )}

          {shown === "Sync folder" && (
            <SyncFolderSection
              readVaultPath={readVaultPath}
              setVaultPath={setVaultPath}
            />
          )}

          {shown === "Yonalist data" && (
            <NotesDataSection
              unusedAssets={unusedAssets}
              deleteAllData={deleteAllData}
              rebuildFromVault={rebuildFromVault}
              readVaultPath={readVaultPath}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/** The sections, in the order the list offers them. */
type SettingsSectionName =
  | "Appearance"
  | "Overwritten notes"
  | "Attachments"
  | "Sync folder"
  | "Yonalist data";

/**
 * What another device's copy replaced. Nothing is lost — the note that lost is
 * kept here — but it only shows up when there is something to show: a heading
 * about overwritten notes on a vault where nothing was overwritten reads as a
 * warning rather than as a record.
 */
function OverwrittenNotesSection({
  conflicts,
  error,
  reload,
  restoreConflict,
  forgetConflict
}: {
  readonly conflicts: readonly SyncConflict[];
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly restoreConflict: (seq: number) => Promise<void>;
  readonly forgetConflict: (seq: number) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  /// Both buttons do the same three things around a different write, and the
  /// difference between them — one leaves the row, one takes it away — is what
  /// each one's own handler says.
  const act = async (write: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await write();
      await reload();
    } catch (cause) {
      setFailure(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Overwritten notes">
      <div className="settings-section-title">
        <History size={18} aria-hidden="true" />
        <h3>Overwritten notes</h3>
      </div>
      {(failure ?? error) && (
        <p className="notes-inline-error" role="alert">{failure ?? error}</p>
      )}
      <p className="settings-copy">
        When two devices changed the same note, one version had to win. Both are
        here, with when each was written and on which device — putting the
        dropped text back writes it again as a new edit, and it travels to your
        other devices from there. Dropping a record says you are done with it,
        and the old text goes.
      </p>
      <ul className="settings-conflict-list">
        {conflicts.map((conflict) => (
          <li key={conflict.seq}>
            <div className="settings-conflict-sides">
              <ConflictSide label="Kept" side={conflict.kept} />
              <ConflictSide label="Dropped" side={conflict.dropped} />
            </div>
            <div className="settings-conflict-actions">
              <span className="settings-conflict-note">
                {reasonInWords(conflict.reason)} · noticed{" "}
                {new Date(conflict.recordedAt * 1000).toLocaleString()}
                {/* Which file the dropped version arrived in. The generation of
                    that file is gone by the time anybody reads this, so without
                    the name the record says two versions disagreed and nothing
                    about where either came from. Older records have no name and
                    say nothing rather than an empty separator. */}
                {conflict.filePath !== "" && (
                  <> · in <code>{conflict.filePath}</code></>
                )}
              </span>
              {restored === conflict.seq && (
                <span role="status" className="settings-copy">Put back</span>
              )}
              {/* One pair rather than two loose controls: they are the two
                  answers to the same question, and the shared edge says so. */}
              <div role="group" aria-label="What to do with this record">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(async () => {
                    await restoreConflict(conflict.seq);
                    // The row stays: putting the text back is an edit, not a
                    // reading of the record. So the write has to announce itself.
                    setRestored(conflict.seq);
                  })}
                >
                  Put this text back
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(async () => {
                    await forgetConflict(conflict.seq);
                  })}
                >
                  Drop this record
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One of the two versions, described the way the other one is: what it said,
 * when it was written, and where. The two columns are the whole point of this
 * screen — a version on its own says what was lost but not what it lost to.
 */
function ConflictSide({
  label,
  side
}: {
  readonly label: string;
  readonly side: SyncConflictSide;
}) {
  return (
    <div className="settings-conflict-side">
      <div className="settings-conflict-side-head">
        <span className={`settings-conflict-badge settings-conflict-badge-${label.toLowerCase()}`}>
          {label}
        </span>
        <span className="settings-conflict-when">{whenLabel(side)}</span>
      </div>
      <p className="settings-conflict-text">{side.text}</p>
      <p className="settings-conflict-device">{deviceLabel(side)}</p>
    </div>
  );
}

/**
 * What to call the device this version came from. A name when a file it wrote
 * has said what it is called, then the four characters the stamp carries — a
 * poorer label but a true one — and only past both of those, nothing to go on.
 * A stamp this build could not read leaves the id empty, and saying so beats an
 * empty line the reader has to guess at.
 */
function deviceLabel(side: SyncConflictSide): string {
  const name = side.deviceName ?? (side.deviceId || "Unknown device");
  return side.isThisDevice ? `${name} (this device)` : name;
}

/**
 * When this version was written. An unreadable stamp carries no time, and the
 * epoch is not a time anybody edited anything — it would read as a real date
 * and be wrong, which is worse than admitting the stamp was unreadable.
 */
function whenLabel(side: SyncConflictSide): string {
  return side.editedAtMillis > 0
    ? new Date(side.editedAtMillis).toLocaleString()
    : "Time unknown";
}

/**
 * The merge's own vocabulary for why one version lost, in words the reader can
 * act on. An unknown reason is shown as itself rather than swallowed: a newer
 * build's record is still a record.
 */
function reasonInWords(reason: string): string {
  switch (reason) {
    case "lww":
      return "Later edit won";
    case "same_t":
      return "Same timestamp";
    case "clock_drift":
      return "The other device's clock disagreed";
    case "dirty_overwrite":
      return "An edit here had not been written out yet";
    default:
      return reason;
  }
}

/**
 * Where the markdown files live. The folder is the user's to keep, so this
 * section only ever records the choice — nothing is written into it here.
 */
function SyncFolderSection({
  readVaultPath,
  setVaultPath
}: {
  readonly readVaultPath: () => Promise<string | null>;
  readonly setVaultPath: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readVaultPath()
      .then((stored) => {
        if (!cancelled) setPath(stored);
      })
      .catch(() => {
        if (!cancelled) setError("Notes could not read the sync folder.");
      });
    return () => {
      cancelled = true;
    };
  }, [readVaultPath]);

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = await pickVaultFolder();
      if (chosen === null) return;
      await setVaultPath(chosen);
      setPath(chosen);
    } catch (cause) {
      // Tauri rejects with the serialized NotesError, a plain object rather
      // than an Error, so `instanceof` would throw away the one sentence that
      // tells the user which folder to pick instead.
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Sync folder">
      <div className="settings-section-title">
        <FolderSync size={18} aria-hidden="true" />
        <h3>Sync folder</h3>
      </div>
      {error && (
        <p className="notes-inline-error" role="alert">{error}</p>
      )}

      <div className="settings-field-grid">
        <div>
          <strong>Markdown folder</strong>
          <p className="settings-copy">
            Yonalist keeps a markdown copy of your notes here so another device
            can pick them up through iCloud, Dropbox, or any folder that syncs.
            Leaving it unset keeps everything on this device.
          </p>
          {path ? (
            <p className="settings-path">{path}</p>
          ) : (
            <p className="settings-copy">No folder chosen yet.</p>
          )}
          {/* No API pins a third-party app's files as downloaded, so the only
              thing to do about Optimize Mac Storage is to say it here. Every
              iCloud container is mounted under Mobile Documents, and no local
              folder is. */}
          {path?.includes("Mobile Documents") && (
            <p className="settings-copy">
              This folder is in iCloud Drive. To keep sync reliable, right-click
              it in Finder and choose "Keep Downloaded". On macOS 14 or earlier,
              turn off "Optimize Mac Storage" in iCloud settings instead —
              otherwise macOS may remove the local copies of your notes and they
              will have to be re-downloaded before they can sync.
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => void choose()}>
            {path ? "Change folder" : "Choose folder"}
          </button>
        </div>
      </div>
    </section>
  );
}

function NotesDataSection({
  unusedAssets,
  deleteAllData,
  rebuildFromVault,
  readVaultPath
}: {
  readonly unusedAssets: (purge: boolean) => Promise<UnusedAssetsReport>;
  readonly deleteAllData: () => Promise<void>;
  readonly rebuildFromVault: () => Promise<VaultRebuildReport>;
  readonly readVaultPath: () => Promise<string | null>;
}) {
  const [report, setReport] = useState<UnusedAssetsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebuilt, setRebuilt] = useState<VaultRebuildReport | null>(null);
  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  // Read here as well as in the sync section: whether a rebuild is possible at
  // all is a question about the folder, and this section is where it is asked.
  const [vaultPath, setVaultPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readVaultPath()
      .then((stored) => {
        if (!cancelled) setVaultPath(stored);
      })
      .catch(() => {
        // The folder cannot be read, so a rebuild that reads it would fail
        // too — the button stays out of reach and the sync section is where
        // that trouble is reported.
      });
    return () => {
      cancelled = true;
    };
  }, [readVaultPath]);

  const runAssets = async (purge: boolean) => {
    setBusy(true);
    setError(null);
    setConfirmingPurge(false);
    try {
      const next = await unusedAssets(purge);
      setReport(purge ? { ...next, count: 0, totalBytes: 0 } : next);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    setConfirmingDelete(false);
    setDeleting(true);
    setError(null);
    try {
      await deleteAllData();
    } catch (cause) {
      setDeleting(false);
      setError(messageFrom(cause));
    }
  };

  /// Unlike the delete, this one comes back: the app stays up and the outline
  /// is already rebuilt by the time the counts appear.
  const runRebuild = async () => {
    setConfirmingRebuild(false);
    setRebuilding(true);
    setError(null);
    try {
      setRebuilt(await rebuildFromVault());
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Yonalist data">
      <div className="settings-section-title">
        <Database size={18} aria-hidden="true" />
        <h3>Yonalist data</h3>
      </div>
      {error && (
        <p className="notes-inline-error" role="alert">{error}</p>
      )}

      <div className="settings-field-grid">
        <div>
          <strong>Unused attachment assets</strong>
          <p className="settings-copy">
            Check files that are no longer referenced by any Yonalist
            attachment.
          </p>
          {report && !confirmingPurge && (
            <p role="status">
              {report.count.toLocaleString()} unused assets
              {" "}({report.totalBytes.toLocaleString()} bytes)
            </p>
          )}
          {report && report.count > 0 ? (
            confirmingPurge ? (
              <>
                <button
                  className="danger-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void runAssets(true)}
                >
                  Delete {report.count.toLocaleString()} unused assets
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingPurge(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingPurge(true)}
              >
                Delete unused assets...
              </button>
            )
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAssets(false)}
            >
              {busy ? "Checking..." : "Check unused assets"}
            </button>
          )}
        </div>

        <div>
          <strong>Delete local Yonalist data</strong>
          <p className="settings-copy">
            Removes the local Yonalist database and attachments, then restarts
            the app with a fresh workspace. The sync folder and the markdown
            files in it stay where they are.
          </p>
          {confirmingDelete ? (
            <>
              <button
                className="danger-button"
                type="button"
                disabled={deleting}
                onClick={() => void runDelete()}
              >
                <Trash2 size={16} aria-hidden="true" />
                Delete everything and restart
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="danger-button"
              type="button"
              disabled={deleting}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 size={16} aria-hidden="true" />
              {deleting ? "Deleting..." : "Delete all Yonalist data..."}
            </button>
          )}
        </div>

        <div>
          <strong>Rebuild from the sync folder</strong>
          <p className="settings-copy">
            Throws away this device&apos;s Yonalist database and reads your
            notes back out of the markdown files in the sync folder. Anything
            this device has not written into the folder yet goes out first, and
            the files themselves are never changed. The app stays open.
          </p>
          {vaultPath === null && (
            <p className="settings-copy">
              Choose a sync folder first: a rebuild reads your notes back out of
              that folder, and there is nothing to read without one.
            </p>
          )}
          {rebuilt && !confirmingRebuild && (
            <p role="status">
              {rebuilt.documents.toLocaleString()}
              {" "}{rebuilt.documents === 1 ? "document" : "documents"} read,
              {" "}{rebuilt.unreadable.toLocaleString()} could not be read
            </p>
          )}
          {confirmingRebuild ? (
            <>
              <button
                className="danger-button"
                type="button"
                disabled={rebuilding}
                onClick={() => void runRebuild()}
              >
                Throw away the database and rebuild
              </button>
              <button
                type="button"
                disabled={rebuilding}
                onClick={() => setConfirmingRebuild(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={rebuilding || vaultPath === null}
              onClick={() => setConfirmingRebuild(true)}
            >
              {rebuilding ? "Rebuilding..." : "Rebuild from the sync folder..."}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * One row per outline level. The deepest level configured here is also what
 * every level below it draws, which the heading says rather than repeating the
 * rule beside each row.
 */
/**
 * One row per level, starting at a single one. A level is added on the end and
 * removed from the end alone: taking one out of the middle would pull every
 * level below it up a place, changing markers nobody asked to change.
 */
function OutlineMarkerGroup({
  styles,
  onChange
}: {
  readonly styles: readonly OutlineMarkerStyle[];
  readonly onChange: (styles: OutlineMarkerStyle[]) => void;
}) {
  const replace = (level: number, style: OutlineMarkerStyle) =>
    onChange(styles.map((current, index) =>
      index === level ? style : current));
  return (
    <div className="theme-settings-group">
      <h3>Outline markers</h3>
      <p className="marker-level-hint">
        Rows deeper than level {styles.length} keep level {styles.length}&apos;s marker.
      </p>
      {styles.map((style, level) => (
        <div className="marker-level-row" key={level}>
          <span className="marker-level-name">
            <span className="marker-level-label">Level {level + 1}</span>
            {/* The slot stands whether or not the icon does, so a level being
                added or removed never shifts the row's other controls. */}
            <span className="marker-level-remove-slot">
              {level === styles.length - 1 && styles.length > 1 ? (
                <button
                  type="button"
                  className="marker-level-remove"
                  aria-label={`Remove level ${level + 1}`}
                  onClick={() => onChange(styles.slice(0, -1))}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              ) : null}
            </span>
          </span>
          <div
            className="marker-shape-row"
            role="group"
            aria-label={`Level ${level + 1} marker`}
          >
            {markerShapeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className="marker-shape-button"
                aria-label={`${option.label} marker for level ${level + 1}`}
                aria-pressed={style.shape === option.value}
                onClick={() => replace(level, {
                  ...style,
                  shape: option.value,
                  char: option.value === "custom"
                    ? style.char || defaultCustomMarker
                    : ""
                })}
              >
                <MarkerPreview shape={option.value} char={style.char} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
          {style.shape === "custom" ? (
            <input
              className="marker-custom-char"
              aria-label={`Level ${level + 1} marker character`}
              value={style.char}
              onChange={(event) => replace(level, {
                ...style,
                char: normalizeMarkerChar(event.target.value)
              })}
            />
          ) : null}
          <span className="marker-color-field">
            <span className="marker-color-label">Color</span>
            {/* The picker always answers with a colour -- it has no "none" --
                so the way back to the theme's own colour is this badge, and it
                shows only where there is a colour to clear. */}
            <span className="marker-color-slot">
              <input
                type="color"
                className={style.color === null
                  ? "marker-color-swatch marker-color-swatch-auto"
                  : "marker-color-swatch"}
                aria-label={`Level ${level + 1} marker color`}
                value={style.color ?? defaultMarkerColor}
                onChange={(event) =>
                  replace(level, { ...style, color: event.target.value })}
              />
              {style.color === null ? null : (
                <button
                  type="button"
                  className="marker-color-clear"
                  aria-label={`Clear level ${level + 1} color`}
                  onClick={() => replace(level, { ...style, color: null })}
                >
                  <X size={9} aria-hidden="true" />
                </button>
              )}
            </span>
          </span>
        </div>
      ))}
      {styles.length < MAX_OUTLINE_MARKER_LEVELS ? (
        <div className="marker-level-row">
          <button
            type="button"
            className="marker-level-add"
            aria-label={`Add level ${styles.length + 1}`}
            onClick={() => onChange([
              ...styles, { shape: "dot", char: "", color: null }
            ])}
          >
            + Add level {styles.length + 1}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MarkerPreview({
  shape,
  char
}: {
  readonly shape: OutlineMarkerShape;
  readonly char: string;
}) {
  if (shape === "hyphen" || shape === "custom") {
    // The hyphen preview takes the same monospace font the row draws it in, so
    // the button shows the long even dash rather than the interface font's tick.
    return (
      <span
        className={shape === "hyphen"
          ? "marker-preview marker-preview-glyph marker-preview-hyphen"
          : "marker-preview marker-preview-glyph"}
        aria-hidden="true"
      >
        {shape === "hyphen" ? "-" : char || defaultCustomMarker}
      </span>
    );
  }
  return (
    <span className={`marker-preview marker-preview-${shape}`} aria-hidden="true" />
  );
}

function CaretColorGroup({
  value,
  onChange
}: {
  readonly value: CaretColor;
  readonly onChange: (color: CaretColor) => void;
}) {
  return (
    <div className="theme-settings-group">
      <h3>Caret color</h3>
      <div className="caret-swatch-row" role="group" aria-label="Caret color">
        <button
          type="button"
          className="caret-swatch caret-swatch-auto"
          aria-label="Auto (theme default)"
          aria-pressed={value === "auto"}
          onClick={() => onChange("auto")}
        />
        {caretColorOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className="caret-swatch"
            style={{ background: option.value }}
            aria-label={option.label}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          />
        ))}
        <label className="caret-custom">
          <span>Custom</span>
          <input
            type="color"
            value={value === "auto" ? "#0a84ff" : value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}

function ThemeRadioGroup<Value extends string>({
  title,
  options,
  value,
  optionSuffix,
  onChange
}: {
  readonly title: string;
  readonly options: ReadonlyArray<{ value: Value; label: string }>;
  readonly value: Value;
  readonly optionSuffix: string;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <div className="theme-settings-group">
      <h3>{title}</h3>
      <RadioGroup
        className="theme-options"
        aria-label={title}
        value={value}
        onValueChange={(next) => onChange(next as Value)}
      >
        {options.map((option) => (
          <Radio.Root
            key={option.value}
            value={option.value}
            render={<label />}
            aria-label={`${option.label} ${optionSuffix}`}
            className={
              value === option.value ? "theme-option active" : "theme-option"
            }
          >
            <span className="ui-radio" aria-hidden="true">
              <Radio.Indicator className="ui-radio-indicator" />
            </span>
            <span>{option.label}</span>
          </Radio.Root>
        ))}
      </RadioGroup>
    </div>
  );
}
