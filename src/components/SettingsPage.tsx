import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  RotateCcw,
  X
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { AppSettings } from "../appSettings";
import type { UseGithubAuthResult } from "../hooks/useGithubAuth";
import type { UseGithubServersResult } from "../hooks/useGithubServers";
import type { UseProjectVisibilityResult } from "../hooks/useProjectVisibility";
import type { ThemeMode } from "../hooks/useTheme";
import type { ResetProgressState, ResetProgressStepStatus } from "../resetProgress";
import type { OwnerGroup } from "../services/githubItems";
import { GithubServersSection } from "./GithubServersSection";
import { MarkdownStyleComparison } from "./MarkdownStyleComparison";
import { ProjectsVisibilitySection } from "./ProjectsVisibilitySection";
import { settingsSections, type SettingsSection } from "./SettingsCategoryPane";

interface SettingsPageProps {
  section: SettingsSection;
  settings: AppSettings;
  status: string;
  resetProgress: ResetProgressState;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  servers: UseGithubServersResult;
  auth: UseGithubAuthResult;
  repositoryGroups: OwnerGroup[];
  projectVisibility: UseProjectVisibilityResult;
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onSave: (event: FormEvent) => void;
  onResetAll: () => void;
  onClose: () => void;
}

const themeModeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

const resetStepStatusLabels: Record<ResetProgressStepStatus, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed"
};

function ResetStepIcon({ status }: { status: ResetProgressStepStatus }) {
  if (status === "done") {
    return <CheckCircle2 size={16} />;
  }
  if (status === "running") {
    return <Loader2 size={16} className="spinning" />;
  }
  if (status === "failed") {
    return <AlertTriangle size={16} />;
  }
  return <Circle size={16} />;
}

export function SettingsPage({
  section,
  settings,
  status,
  resetProgress,
  themeMode,
  onThemeModeChange,
  servers,
  auth,
  repositoryGroups,
  projectVisibility,
  onUpdate,
  onSave,
  onResetAll,
  onClose
}: SettingsPageProps) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const meta = settingsSections.find((entry) => entry.key === section);
  const resetRunning = resetProgress.status === "running";

  return (
    <form className="settings-page" aria-label="Settings page" onSubmit={onSave}>
      <header className="settings-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>{meta?.label ?? "Settings"}</h2>
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
        {section === "appearance" && (
          <>
            <section className="settings-section">
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
            <MarkdownStyleComparison
              value={settings.markdownStyle}
              onChange={(nextStyle) => onUpdate("markdownStyle", nextStyle)}
            />
          </>
        )}

        {section === "servers" && (
          <GithubServersSection servers={servers} auth={auth} />
        )}

        {section === "projects" && (
          <ProjectsVisibilitySection
            groups={repositoryGroups}
            visibility={projectVisibility}
          />
        )}

        {section === "vault" && (
          <section className="settings-section">
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
              <label className="settings-check">
                <input
                  aria-label="Desktop notifications for new items"
                  type="checkbox"
                  checked={settings.desktopNotifications}
                  onChange={(event) =>
                    onUpdate("desktopNotifications", event.target.checked)
                  }
                />
                <span>Desktop notifications for new items</span>
              </label>
            </div>
          </section>
        )}

        {section === "reset" && (
          <section className="settings-section reset-settings-section">
            <div className="settings-section-title">
              <RotateCcw size={18} />
              <h3>Reset settings and caches</h3>
            </div>
            <p className="settings-copy">
              Restore app preferences to their defaults, sign out of saved GitHub
              sessions, and clear notification, repository, avatar, and index caches.
              Vault Markdown files and outbox documents are kept.
            </p>
            <button
              className="danger-button"
              type="button"
              disabled={resetRunning}
              onClick={() => setShowResetConfirm(true)}
            >
              <RotateCcw size={16} />
              {resetRunning ? "Resetting..." : "Reset settings and caches"}
            </button>
            {showResetConfirm && (
              <div
                className="reset-confirm-card"
                role="dialog"
                aria-label="Confirm reset settings and caches"
              >
                <div>
                  <strong>Reset all settings and caches?</strong>
                  <p>
                    This signs out saved GitHub sessions and clears local caches.
                    Vault Markdown files and outbox documents will be kept.
                  </p>
                </div>
                <div className="reset-confirm-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setShowResetConfirm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => {
                      setShowResetConfirm(false);
                      void onResetAll();
                    }}
                  >
                    <RotateCcw size={16} />
                    Yes, reset everything
                  </button>
                </div>
              </div>
            )}
            {resetProgress.steps.length > 0 && (
              <div
                className={`reset-progress reset-progress-${resetProgress.status}`}
                aria-label="Reset progress"
                aria-live="polite"
              >
                {resetProgress.message && (
                  <p className="reset-progress-message">{resetProgress.message}</p>
                )}
                <ol>
                  {resetProgress.steps.map((step) => (
                    <li
                      key={step.id}
                      className={`reset-progress-step reset-step-${step.status}`}
                    >
                      <span className="reset-step-icon" aria-hidden="true">
                        <ResetStepIcon status={step.status} />
                      </span>
                      <span className="reset-step-label">{step.label}</span>
                      <span className="reset-step-status">
                        {resetStepStatusLabels[step.status]}
                      </span>
                      {step.detail && (
                        <span className="reset-step-detail">{step.detail}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        )}
      </div>

      {(section === "appearance" || section === "vault") && (
        <footer className="settings-actions">
          <span>{status}</span>
          <button className="primary-button" type="submit">
            <CheckCircle2 size={16} />
            Save settings
          </button>
        </footer>
      )}
    </form>
  );
}
