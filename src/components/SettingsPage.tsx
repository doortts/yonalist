import { Checkbox } from "@base-ui/react/checkbox";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  X
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from "react";
import "./ui/form-controls.css";
import type { SettingsTarget } from "../AppNavigationContext";
import {
  defaultSettings,
  normalizeGithubNotificationsReadRetentionDays,
  type AppSettings
} from "../appSettings";
import type { UseGithubAuthResult } from "../hooks/useGithubAuth";
import type { UseGithubServersResult } from "../hooks/useGithubServers";
import type { DarkTheme, LightTheme, ThemeMode } from "../hooks/useTheme";
import type { ResetProgressState, ResetProgressStepStatus } from "../resetProgress";
import { GithubServersSection } from "./GithubServersSection";
import { MarkdownStyleComparison } from "./MarkdownStyleComparison";
import { settingsSections, type SettingsSection } from "./SettingsCategoryPane";
import { ConfirmDialog } from "./ui/ConfirmDialog";

interface SettingsPageProps {
  section: SettingsSection;
  target: SettingsTarget | null;
  onTargetConsumed: (target: SettingsTarget) => void;
  settings: AppSettings;
  status: string;
  resetProgress: ResetProgressState;
  themeMode: ThemeMode;
  lightTheme: LightTheme;
  darkTheme: DarkTheme;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLightThemeChange: (theme: LightTheme) => void;
  onDarkThemeChange: (theme: DarkTheme) => void;
  servers: UseGithubServersResult;
  auth: UseGithubAuthResult;
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onBrowseVaultFolder: (current: string) => Promise<string | null>;
  onSave: (event: FormEvent, vaultFolder: string) => void;
  onResetAll: () => void;
  onClose: () => void;
}

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

const targetHighlightFallbackMs = 2_000;

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

function SettingsCheck({
  label,
  checked,
  onCheckedChange,
  children
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Checkbox.Root
      className="settings-check"
      render={<label />}
      aria-label={label}
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
    >
      <span className="ui-checkbox" aria-hidden="true">
        <Checkbox.Indicator className="ui-checkbox-indicator">
          <Check size={12} strokeWidth={3} />
        </Checkbox.Indicator>
      </span>
      <span>{children}</span>
    </Checkbox.Root>
  );
}

export function SettingsPage({
  section,
  target,
  onTargetConsumed,
  settings,
  status,
  resetProgress,
  themeMode,
  lightTheme,
  darkTheme,
  onThemeModeChange,
  onLightThemeChange,
  onDarkThemeChange,
  servers,
  auth,
  onUpdate,
  onBrowseVaultFolder,
  onSave,
  onResetAll,
  onClose
}: SettingsPageProps) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [highlightedTarget, setHighlightedTarget] =
    useState<SettingsTarget | null>(null);
  const [githubRetentionDraft, setGithubRetentionDraft] = useState(() =>
    String(settings.githubNotificationsReadRetentionDays)
  );
  const [vaultFolderInput, setVaultFolderInput] = useState(
    () => settings.vaultFolder
  );

  useEffect(() => {
    setGithubRetentionDraft(
      String(settings.githubNotificationsReadRetentionDays)
    );
  }, [settings.githubNotificationsReadRetentionDays]);
  useEffect(() => {
    setVaultFolderInput(settings.vaultFolder);
  }, [settings.vaultFolder]);

  function updateGithubRetentionDraft(value: string) {
    setGithubRetentionDraft(value);
    if (value === "") return;
    onUpdate(
      "githubNotificationsReadRetentionDays",
      normalizeGithubNotificationsReadRetentionDays(Number(value))
    );
  }

  const handleBrowseVaultFolder = async () => {
    const selected = await onBrowseVaultFolder(vaultFolderInput);
    if (selected !== null && selected !== vaultFolderInput) {
      setVaultFolderInput(selected);
      onUpdate("vaultFolder", selected);
    }
  };

  const imagesSectionRef = useRef<HTMLElement>(null);
  const targetHighlightTimerRef = useRef<number | null>(null);
  const meta = settingsSections.find((entry) => entry.key === section);
  const resetRunning = resetProgress.status === "running";

  useEffect(() => {
    if (section !== "notes") {
      if (targetHighlightTimerRef.current !== null) {
        window.clearTimeout(targetHighlightTimerRef.current);
        targetHighlightTimerRef.current = null;
      }
      setHighlightedTarget(null);
      return;
    }
    if (target !== "images" || !imagesSectionRef.current) {
      return;
    }

    const imagesSection = imagesSectionRef.current;
    imagesSection.scrollIntoView({ block: "nearest" });
    imagesSection.focus({ preventScroll: true });
    if (targetHighlightTimerRef.current !== null) {
      window.clearTimeout(targetHighlightTimerRef.current);
    }
    setHighlightedTarget("images");
    targetHighlightTimerRef.current = window.setTimeout(() => {
      targetHighlightTimerRef.current = null;
      setHighlightedTarget(null);
    }, targetHighlightFallbackMs);
    onTargetConsumed("images");
  }, [onTargetConsumed, section, target]);

  useEffect(
    () => () => {
      if (targetHighlightTimerRef.current !== null) {
        window.clearTimeout(targetHighlightTimerRef.current);
        targetHighlightTimerRef.current = null;
      }
    },
    []
  );

  return (
    <form
      className="settings-page"
      aria-label="Settings page"
      onSubmit={(event) => onSave(event, vaultFolderInput)}
    >
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
              <div className="theme-settings-group">
                <h3>Theme mode</h3>
                <RadioGroup
                  className="theme-options"
                  aria-label="Theme mode"
                  value={themeMode}
                  onValueChange={(value) => onThemeModeChange(value as ThemeMode)}
                >
                  {themeModeOptions.map((option) => (
                    <Radio.Root
                      key={option.value}
                      value={option.value}
                      render={<label />}
                      aria-label={`${option.label} mode`}
                      className={
                        themeMode === option.value
                          ? "theme-option active"
                          : "theme-option"
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

              <div className="theme-settings-group">
                <h3>Light theme</h3>
                <RadioGroup
                  className="theme-options"
                  aria-label="Light theme"
                  value={lightTheme}
                  onValueChange={(value) => onLightThemeChange(value as LightTheme)}
                >
                  {lightThemeOptions.map((option) => (
                    <Radio.Root
                      key={option.value}
                      value={option.value}
                      render={<label />}
                      aria-label={`${option.label} light theme`}
                      className={
                        lightTheme === option.value
                          ? "theme-option active"
                          : "theme-option"
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

              <div className="theme-settings-group">
                <h3>Dark theme</h3>
                <RadioGroup
                  className="theme-options"
                  aria-label="Dark theme"
                  value={darkTheme}
                  onValueChange={(value) => onDarkThemeChange(value as DarkTheme)}
                >
                  {darkThemeOptions.map((option) => (
                    <Radio.Root
                      key={option.value}
                      value={option.value}
                      render={<label />}
                      aria-label={`${option.label} dark theme`}
                      className={
                        darkTheme === option.value
                          ? "theme-option active"
                          : "theme-option"
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

        {section === "vault" && (
          <section className="settings-section">
            <label>
              Vault folder
              <div className="settings-input-row">
                <input
                  aria-label="Vault folder"
                  value={vaultFolderInput}
                  onChange={(event) => setVaultFolderInput(event.target.value)}
                  onBlur={() => onUpdate("vaultFolder", vaultFolderInput)}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleBrowseVaultFolder}
                >
                  Browse…
                </button>
              </div>
            </label>
          </section>
        )}

        {section === "notes" && (
          <section
            ref={imagesSectionRef}
            className={`settings-section notes-images-settings-section${
              highlightedTarget === "images" ? " settings-target-highlight" : ""
            }`}
            aria-labelledby="notes-images-settings-heading"
            tabIndex={-1}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) {
                if (targetHighlightTimerRef.current !== null) {
                  window.clearTimeout(targetHighlightTimerRef.current);
                  targetHighlightTimerRef.current = null;
                }
                setHighlightedTarget(null);
              }
            }}
          >
            <div className="settings-section-title">
              <ImageIcon size={18} />
              <h3 id="notes-images-settings-heading">Images</h3>
            </div>
            <p className="settings-copy">
              Unreferenced image files are quarantined before permanent deletion.
              Changes take effect the next time the app starts.
            </p>
            <div className="settings-field-grid">
              <label>
                Asset trash retention days
                <input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  value={settings.assetTrashRetentionDays}
                  onChange={(event) =>
                    onUpdate("assetTrashRetentionDays", Number(event.target.value))
                  }
                />
              </label>
              <label>
                Large asset trash retention days
                <input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  value={settings.assetTrashLargeFileDays}
                  onChange={(event) =>
                    onUpdate("assetTrashLargeFileDays", Number(event.target.value))
                  }
                />
              </label>
              <label>
                Large asset threshold (MB)
                <input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  value={settings.assetLargeFileThresholdMb}
                  onChange={(event) =>
                    onUpdate("assetLargeFileThresholdMb", Number(event.target.value))
                  }
                />
              </label>
            </div>
          </section>
        )}

        {section === "plugins" && (
          <section className="settings-section">
            <div className="settings-section-title">
              <h3>GitHub Notifications</h3>
            </div>
            <SettingsCheck
              label="GitHub Notifications 사용"
              checked={settings.githubNotificationsPluginEnabled}
              onCheckedChange={(checked) =>
                onUpdate("githubNotificationsPluginEnabled", checked)
              }
            >
              GitHub Notifications 사용
            </SettingsCheck>
            <SettingsCheck
              label="Desktop notifications for GitHub Notifications"
              checked={settings.desktopNotifications}
              onCheckedChange={(checked) =>
                onUpdate("desktopNotifications", checked)
              }
            >
              Desktop notifications for GitHub Notifications
            </SettingsCheck>
            <p className="settings-copy">
              읽은 알림은 설정한 기간 동안 표시됩니다. 읽지 않은 알림은 이
              기간보다 오래되어도 유지됩니다.
            </p>
            <div className="settings-field-grid">
              <label>
                읽은 알림 표시 기간
                <input
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  required
                  disabled={!settings.githubNotificationsPluginEnabled}
                  value={githubRetentionDraft}
                  onChange={(event) =>
                    updateGithubRetentionDraft(event.target.value)
                  }
                  onBlur={() => {
                    if (githubRetentionDraft === "") {
                      const fallback =
                        defaultSettings.githubNotificationsReadRetentionDays;
                      setGithubRetentionDraft(String(fallback));
                      onUpdate("githubNotificationsReadRetentionDays", fallback);
                    }
                  }}
                />
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
              sessions, and clear local settings and runtime caches. Yonalist notes
              and attachments are kept.
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
            <ConfirmDialog
              open={showResetConfirm}
              onOpenChange={setShowResetConfirm}
              title="Reset all settings and caches?"
              description="This signs out saved GitHub sessions and clears local settings and runtime caches. Yonalist notes and attachments will be kept."
              confirmLabel="Yes, reset everything"
              cancelLabel="Cancel"
              danger
              onConfirm={() => void onResetAll()}
            />
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

      {(section === "appearance" ||
        section === "vault" ||
        section === "notes" ||
        section === "plugins") && (
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
