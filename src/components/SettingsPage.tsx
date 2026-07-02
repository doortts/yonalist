import { CheckCircle2, HardDrive, SunMoon, X } from "lucide-react";
import type { FormEvent } from "react";
import type { AppSettings } from "../appSettings";
import type { UseGithubAuthResult } from "../hooks/useGithubAuth";
import type { UseGithubServersResult } from "../hooks/useGithubServers";
import type { ThemeMode } from "../hooks/useTheme";
import { GithubServersSection } from "./GithubServersSection";

interface SettingsPageProps {
  settings: AppSettings;
  status: string;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  servers: UseGithubServersResult;
  auth: UseGithubAuthResult;
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onSave: (event: FormEvent) => void;
  onClose: () => void;
}

const themeModeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

export function SettingsPage({
  settings,
  status,
  themeMode,
  onThemeModeChange,
  servers,
  auth,
  onUpdate,
  onSave,
  onClose
}: SettingsPageProps) {
  return (
    <form className="settings-page" aria-label="Settings page" onSubmit={onSave}>
      <header className="settings-header">
        <div>
          <p className="eyebrow">Preferences</p>
          <h2>Settings</h2>
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
          <div className="settings-section-title">
            <SunMoon size={18} />
            <h3>Appearance</h3>
          </div>
          <div className="theme-options" role="radiogroup" aria-label="Theme">
            {themeModeOptions.map((option) => (
              <label
                key={option.value}
                className={
                  themeMode === option.value ? "theme-option active" : "theme-option"
                }
              >
                <input
                  type="radio"
                  name="theme-mode"
                  aria-label={`${option.label} theme`}
                  value={option.value}
                  checked={themeMode === option.value}
                  onChange={() => onThemeModeChange(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>

        <GithubServersSection servers={servers} auth={auth} />

        <section className="settings-section">
          <div className="settings-section-title">
            <HardDrive size={18} />
            <h3>Vault and sync</h3>
          </div>
          <label>
            Vault folder
            <input
              aria-label="Vault folder"
              value={settings.vaultFolder}
              onChange={(event) => onUpdate("vaultFolder", event.target.value)}
            />
          </label>
          <div className="settings-checks">
            <label className="settings-check">
              <input
                aria-label="Sync queued changes when online"
                type="checkbox"
                checked={settings.syncQueuedOnReconnect}
                onChange={(event) =>
                  onUpdate("syncQueuedOnReconnect", event.target.checked)
                }
              />
              <span>Sync queued changes when online</span>
            </label>
            <label className="settings-check">
              <input
                aria-label="Cache linked attachments"
                type="checkbox"
                checked={settings.cacheLinkedAttachments}
                onChange={(event) =>
                  onUpdate("cacheLinkedAttachments", event.target.checked)
                }
              />
              <span>Cache linked attachments</span>
            </label>
            <label className="settings-check">
              <input
                aria-label="Download comments while syncing"
                type="checkbox"
                checked={settings.downloadCommentsWhileSyncing}
                onChange={(event) =>
                  onUpdate("downloadCommentsWhileSyncing", event.target.checked)
                }
              />
              <span>Download comments while syncing</span>
            </label>
          </div>
        </section>
      </div>

      <footer className="settings-actions">
        <span>{status}</span>
        <button className="primary-button" type="submit">
          <CheckCircle2 size={16} />
          Save settings
        </button>
      </footer>
    </form>
  );
}
