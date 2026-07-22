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
import type { AppSettings } from "../appSettings";
import type { UseGithubAuthResult } from "../hooks/useGithubAuth";
import type { UseGithubServersResult } from "../hooks/useGithubServers";
import type { UseProjectVisibilityResult } from "../hooks/useProjectVisibility";
import type { DarkTheme, LightTheme, ThemeMode } from "../hooks/useTheme";
import type { ResetProgressState, ResetProgressStepStatus } from "../resetProgress";
import type { OwnerGroup } from "../services/githubItems";
import { GithubServersSection } from "./GithubServersSection";
import { MarkdownStyleComparison } from "./MarkdownStyleComparison";
import { ProjectsVisibilitySection } from "./ProjectsVisibilitySection";
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
  repositoryGroups: OwnerGroup[];
  projectVisibility: UseProjectVisibilityResult;
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onBrowseVaultFolder: (current: string) => Promise<string | null>;
  onSave: (event: FormEvent) => void;
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
  repositoryGroups,
  projectVisibility,
  onUpdate,
  onBrowseVaultFolder,
  onSave,
  onResetAll,
  onClose
}: SettingsPageProps) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [highlightedTarget, setHighlightedTarget] =
    useState<SettingsTarget | null>(null);

  const handleBrowseVaultFolder = async () => {
    const selected = await onBrowseVaultFolder(settings.vaultFolder);
    if (selected !== null && selected !== settings.vaultFolder) {
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
              <div className="settings-input-row">
                <input
                  aria-label="Vault folder"
                  value={settings.vaultFolder}
                  onChange={(event) =>
                    onUpdate("vaultFolder", event.target.value)
                  }
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
            <div className="settings-checks">
              <SettingsCheck
                label="Sync queued changes when online"
                checked={settings.syncQueuedOnReconnect}
                onCheckedChange={(next) => onUpdate("syncQueuedOnReconnect", next)}
              >
                Sync queued changes when online
              </SettingsCheck>
              <SettingsCheck
                label="Cache linked attachments"
                checked={settings.cacheLinkedAttachments}
                onCheckedChange={(next) => onUpdate("cacheLinkedAttachments", next)}
              >
                Cache linked attachments
              </SettingsCheck>
              <SettingsCheck
                label="Download comments while syncing"
                checked={settings.downloadCommentsWhileSyncing}
                onCheckedChange={(next) =>
                  onUpdate("downloadCommentsWhileSyncing", next)
                }
              >
                Download comments while syncing
              </SettingsCheck>
              <SettingsCheck
                label="Prefetch visible conversations"
                checked={settings.prefetchVisibleItems !== false}
                onCheckedChange={(next) => onUpdate("prefetchVisibleItems", next)}
              >
                Prefetch visible conversations
              </SettingsCheck>
              <SettingsCheck
                label="Desktop notifications for new items"
                checked={settings.desktopNotifications}
                onCheckedChange={(next) => onUpdate("desktopNotifications", next)}
              >
                Desktop notifications for new items
              </SettingsCheck>
            </div>
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
            <ConfirmDialog
              open={showResetConfirm}
              onOpenChange={setShowResetConfirm}
              title="Reset all settings and caches?"
              description="This signs out saved GitHub sessions and clears local caches. Vault Markdown files and outbox documents will be kept."
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

      {(section === "appearance" || section === "vault" || section === "notes") && (
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
