import { Radio, RadioGroup } from "@base-ui/react";
import { X } from "lucide-react";

import type {
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

export function SettingsView({
  themeMode,
  lightTheme,
  darkTheme,
  onThemeModeChange,
  onLightThemeChange,
  onDarkThemeChange,
  onClose
}: {
  readonly themeMode: ThemeMode;
  readonly lightTheme: LightTheme;
  readonly darkTheme: DarkTheme;
  readonly onThemeModeChange: (mode: ThemeMode) => void;
  readonly onLightThemeChange: (theme: LightTheme) => void;
  readonly onDarkThemeChange: (theme: DarkTheme) => void;
  readonly onClose: () => void;
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
        </section>
      </div>
    </section>
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
