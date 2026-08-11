import { Radio, RadioGroup } from "@base-ui/react";
import { Database, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { UnusedAssetsReport } from "../../../packages/contracts/generated/UnusedAssetsReport";
import type {
  CaretColor,
  DarkTheme,
  LightTheme,
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
  onThemeModeChange,
  onLightThemeChange,
  onDarkThemeChange,
  onCaretColorChange,
  onClose,
  unusedAssets,
  deleteAllData
}: {
  readonly themeMode: ThemeMode;
  readonly lightTheme: LightTheme;
  readonly darkTheme: DarkTheme;
  readonly caretColor: CaretColor;
  readonly onThemeModeChange: (mode: ThemeMode) => void;
  readonly onLightThemeChange: (theme: LightTheme) => void;
  readonly onDarkThemeChange: (theme: DarkTheme) => void;
  readonly onCaretColorChange: (color: CaretColor) => void;
  readonly onClose: () => void;
  readonly unusedAssets: (purge: boolean) => Promise<UnusedAssetsReport>;
  readonly deleteAllData: () => Promise<void>;
}) {
  return (
    <section className="settings-page" aria-label="Settings page">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>Appearance</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close settings"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div className="settings-body">
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
          <CaretColorGroup value={caretColor} onChange={onCaretColorChange} />
        </section>

        <NotesDataSection
          unusedAssets={unusedAssets}
          deleteAllData={deleteAllData}
        />
      </div>
    </section>
  );
}

function NotesDataSection({
  unusedAssets,
  deleteAllData
}: {
  readonly unusedAssets: (purge: boolean) => Promise<UnusedAssetsReport>;
  readonly deleteAllData: () => Promise<void>;
}) {
  const [report, setReport] = useState<UnusedAssetsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAssets = async (purge: boolean) => {
    setBusy(true);
    setError(null);
    setConfirmingPurge(false);
    try {
      const next = await unusedAssets(purge);
      setReport(purge ? { ...next, count: 0, totalBytes: 0 } : next);
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "Notes could not complete the request.");
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
      setError(cause instanceof Error
        ? cause.message
        : "Notes could not complete the request.");
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
            the app with a fresh workspace.
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
      </div>
    </section>
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
