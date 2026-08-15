import { Radio, RadioGroup } from "@base-ui/react";
import { Database, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { UnusedAssetsReport } from "../../../packages/contracts/generated/UnusedAssetsReport";
import {
  MAX_OUTLINE_MARKER_LEVELS,
  normalizeMarkerChar,
  type OutlineMarkerShape,
  type OutlineMarkerStyle
} from "./outlineMarkers";
import type {
  CaretColor,
  DarkTheme,
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
  { value: "mono", label: "Monospace" }
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
  markerStyles,
  onThemeModeChange,
  onLightThemeChange,
  onDarkThemeChange,
  onCaretColorChange,
  onTextFontChange,
  onMarkerStylesChange,
  onClose,
  unusedAssets,
  deleteAllData
}: {
  readonly themeMode: ThemeMode;
  readonly lightTheme: LightTheme;
  readonly darkTheme: DarkTheme;
  readonly caretColor: CaretColor;
  readonly textFont: TextFont;
  readonly markerStyles: readonly OutlineMarkerStyle[];
  readonly onThemeModeChange: (mode: ThemeMode) => void;
  readonly onLightThemeChange: (theme: LightTheme) => void;
  readonly onDarkThemeChange: (theme: DarkTheme) => void;
  readonly onCaretColorChange: (color: CaretColor) => void;
  readonly onTextFontChange: (font: TextFont) => void;
  readonly onMarkerStylesChange: (styles: OutlineMarkerStyle[]) => void;
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
          <ThemeRadioGroup
            title="Outline text"
            options={textFontOptions}
            value={textFont}
            optionSuffix="outline text"
            onChange={onTextFontChange}
          />
          <CaretColorGroup value={caretColor} onChange={onCaretColorChange} />
          <OutlineMarkerGroup
            styles={markerStyles}
            onChange={onMarkerStylesChange}
          />
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
