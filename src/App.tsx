import { Toast } from "@base-ui/react/toast";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  AppNavigationContext,
  type AppNavigation,
  type SettingsTarget
} from "./AppNavigationContext";
import { ExternalSourcesContext } from "./ExternalSourcesContext";
import { GithubConnectionContext } from "./GithubConnectionContext";
import { MarkdownStyleContext } from "./MarkdownStyleContext";
import { PaneLayoutContext } from "./PaneLayoutContext";
import { VaultRootContext } from "./VaultRootContext";
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  persistSettings,
  settingsNeedNormalization,
  type AppSettings
} from "./appSettings";
import {
  APP_SNACKBAR_TIMEOUT_MS,
  AppSnackbarToasts,
  appToastManager
} from "./components/AppSnackbar";
import { AppStatusBar } from "./components/AppStatusBar";
import {
  SettingsCategoryPane,
  type SettingsSection
} from "./components/SettingsCategoryPane";
import { YonalistNavigationPane } from "./components/YonalistNavigationPane";
import { TitleBar } from "./components/TitleBar";
import { FeatureRuntimeBoundary } from "./features/core/FeatureRuntimeBoundary";
import {
  beginFeatureActivation,
  finishFeatureActivation,
  type FeatureActivationSample
} from "./features/core/featureActivationTiming";
import {
  featureRegistry,
  getFeatureDefinition
} from "./features/core/featureRegistry";
import {
  loadActiveFeature,
  persistActiveFeature
} from "./features/core/featureSelection";
import type { FeatureId, FeaturePanes } from "./features/core/featureTypes";
import { useFeatureRuntimeHost } from "./features/core/useFeatureRuntimeHost";
import {
  NotesFeedbackProvider,
  NotesStatusBarMessage
} from "./features/notes/NotesFeedbackContext";
import { useGithubNotificationsRuntime } from "./features/notes/githubNotifications/useGithubNotificationsRuntime";
import { acquireNotesVaultDrain } from "./features/notes/notesVaultDrain";
import { useAuthGate } from "./hooks/useAuthGate";
import { useGithubAuth } from "./hooks/useGithubAuth";
import { useGithubServers } from "./hooks/useGithubServers";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { paneWidthLimits, usePaneResize } from "./hooks/usePaneResize";
import { useScrollbarHover } from "./hooks/useScrollbarHover";
import { useSettingsReset } from "./hooks/useSettingsReset";
import { useTheme } from "./hooks/useTheme";
import { clearImageProxyCache } from "./services/imageProxy";
import { notesSyncFlush } from "./services/notesStore";
import { clearNotificationCache } from "./services/notifications";
import { tracePerf } from "./services/perfTrace";
import { pickVaultFolder } from "./services/vaultFolder";

const SettingsPage = lazy(() =>
  import("./components/SettingsPage").then((module) => ({
    default: module.SettingsPage
  }))
);

interface AppProps {
  initialOnline?: boolean;
}

export default function App({ initialOnline }: AppProps) {
  useScrollbarHover();
  const { online, toggleOnline } = useOnlineStatus(initialOnline);
  const [activeFeatureId, setActiveFeatureId] =
    useState<FeatureId>(loadActiveFeature);
  const featureActivationSequenceRef = useRef(0);
  const pendingFeatureActivationRef = useRef<FeatureActivationSample | null>(
    null
  );
  const activeFeature = getFeatureDefinition(activeFeatureId);
  const featureRuntimeHost = useFeatureRuntimeHost(activeFeatureId);
  const activeFeatureRuntimeReady =
    featureRuntimeHost.active.status === "ready";
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance");
  const [settingsTarget, setSettingsTarget] =
    useState<SettingsTarget | null>(null);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [vaultFolderDraft, setVaultFolderDraft] = useState(
    () => settings.vaultFolder
  );
  const [settingsStatus, setSettingsStatus] = useState("");
  const vaultFolderRequestTokenRef = useRef(0);
  const vaultFolderPickerTokenRef = useRef(0);
  const {
    paneWidths,
    paneCollapsed,
    detailMaximized,
    togglePaneCollapsed,
    toggleDetailMaximized,
    startResize,
    resizeWithKeyboard
  } = usePaneResize();
  const paneLayoutControls = useMemo(
    () => ({
      detailMaximized,
      toggleDetailMaximized
    }),
    [detailMaximized, toggleDetailMaximized]
  );
  const {
    mode: themeMode,
    setMode: setThemeMode,
    lightTheme,
    setLightTheme,
    darkTheme,
    setDarkTheme
  } = useTheme();
  const servers = useGithubServers();
  const auth = useGithubAuth(servers);
  const authGate = useAuthGate({ auth, servers, online });
  const vaultRoot =
    settings.vaultFolder.trim() || defaultSettings.vaultFolder;
  const githubNotificationsRuntime = useGithubNotificationsRuntime({
    connection: auth.connection,
    authState: authGate.state,
    account: authGate.account,
    online,
    pluginEnabled: settings.githubNotificationsPluginEnabled,
    desktopNotificationsEnabled: settings.desktopNotifications,
    readRetentionDays: settings.githubNotificationsReadRetentionDays
  });

  useEffect(() => {
    setVaultFolderDraft(settings.vaultFolder);
  }, [settings.vaultFolder]);

  useEffect(() => {
    setSettings((current) =>
      settingsNeedNormalization(current) ? normalizeSettings(current) : current
    );
  }, []);

  const previousConnectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${auth.connection.apiBaseUrl}|${auth.connection.token}`;
    if (
      previousConnectionKeyRef.current !== null &&
      previousConnectionKeyRef.current !== key
    ) {
      clearNotificationCache();
      clearImageProxyCache();
    }
    previousConnectionKeyRef.current = key;
  }, [auth.connection.apiBaseUrl, auth.connection.token]);

  const changeActiveFeature = useCallback(
    (nextFeatureId: FeatureId) => {
      if (nextFeatureId !== activeFeatureId) {
        featureActivationSequenceRef.current += 1;
        pendingFeatureActivationRef.current = beginFeatureActivation(
          featureActivationSequenceRef.current,
          nextFeatureId,
          performance.now(),
          tracePerf
        );
      }
      if (nextFeatureId !== "settings") {
        setSettingsTarget(null);
      }
      setActiveFeatureId(nextFeatureId);
    },
    [activeFeatureId]
  );
  const changeActiveFeatureRef = useRef(changeActiveFeature);
  changeActiveFeatureRef.current = changeActiveFeature;

  useEffect(() => {
    persistActiveFeature(activeFeatureId);
  }, [activeFeatureId]);

  useEffect(() => {
    const sample = pendingFeatureActivationRef.current;
    if (
      !sample ||
      sample.featureId !== activeFeatureId ||
      !activeFeatureRuntimeReady
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (pendingFeatureActivationRef.current !== sample) {
        return;
      }
      finishFeatureActivation(sample, performance.now(), tracePerf);
      pendingFeatureActivationRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFeatureId, activeFeatureRuntimeReady]);

  const openSettings = useCallback(
    (section?: SettingsSection, target?: SettingsTarget) => {
      if (section) {
        setSettingsSection(section);
      }
      setSettingsTarget(target ?? null);
      changeActiveFeatureRef.current("settings");
      setSettingsStatus("");
    },
    []
  );
  const openNotes = useCallback(() => {
    changeActiveFeatureRef.current("notes");
  }, []);
  const appNavigation = useMemo<AppNavigation>(
    () => ({ openNotes, openSettings }),
    [openNotes, openSettings]
  );
  const selectSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsTarget(null);
  }, []);
  const consumeSettingsTarget = useCallback((target: SettingsTarget) => {
    setSettingsTarget((current) => (current === target ? null : current));
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsTarget(null);
    changeActiveFeatureRef.current("notes");
  }, []);

  async function requestVaultFolderChange(
    nextFolder: string
  ): Promise<boolean> {
    const requestToken = ++vaultFolderRequestTokenRef.current;
    vaultFolderPickerTokenRef.current += 1;
    const previousRequestedFolder = vaultFolderDraft;
    setVaultFolderDraft(nextFolder);
    const nextRoot = nextFolder.trim() || defaultSettings.vaultFolder;
    const flushCurrentVaultSync = async (
      releaseDrain: () => void
    ): Promise<boolean> => {
      try {
        await notesSyncFlush(vaultRoot);
      } catch {
        releaseDrain();
        if (requestToken === vaultFolderRequestTokenRef.current) {
          setSettingsStatus("Could not save the current Vault. Try again.");
        }
        return false;
      }
      if (requestToken !== vaultFolderRequestTokenRef.current) {
        releaseDrain();
        return false;
      }
      return true;
    };

    if (nextRoot === vaultRoot) {
      if (previousRequestedFolder !== settings.vaultFolder) {
        setSettingsStatus("Saving current Vault…");
        let lease = null;
        try {
          lease = await acquireNotesVaultDrain(vaultRoot);
        } catch {
          lease = null;
        }
        if (requestToken !== vaultFolderRequestTokenRef.current) {
          lease?.release();
          return false;
        }
        if (!lease) {
          setSettingsStatus("Could not save the current Vault. Try again.");
          return false;
        }
        if (!(await flushCurrentVaultSync(() => lease.release()))) {
          return false;
        }
        lease.release();
      }
      setSettings((current) => ({ ...current, vaultFolder: nextFolder }));
      setSettingsStatus("");
      return true;
    }

    setSettingsStatus("Saving current Vault…");
    let lease = null;
    try {
      lease = await acquireNotesVaultDrain(vaultRoot);
    } catch {
      lease = null;
    }
    if (requestToken !== vaultFolderRequestTokenRef.current) {
      lease?.release();
      return false;
    }
    if (!lease) {
      setSettingsStatus("Could not save the current Vault. Try again.");
      return false;
    }
    if (!(await flushCurrentVaultSync(() => lease.release()))) {
      return false;
    }
    setSettings((current) => ({ ...current, vaultFolder: nextFolder }));
    lease.commit();
    setSettingsStatus("");
    return true;
  }

  async function browseVaultFolder(current: string): Promise<string | null> {
    const pickerToken = ++vaultFolderPickerTokenRef.current;
    try {
      const selected = await pickVaultFolder(current);
      return pickerToken === vaultFolderPickerTokenRef.current
        ? selected
        : null;
    } catch {
      return null;
    }
  }

  function updateSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) {
    if (key === "vaultFolder") {
      void requestVaultFolderChange(value as AppSettings["vaultFolder"]);
      return;
    }
    setSettings((current) => ({
      ...current,
      [key]: value
    }));
    setSettingsStatus("");
  }

  async function saveSettings(event: FormEvent, requestedFolder: string) {
    event.preventDefault();
    if (
      requestedFolder !== settings.vaultFolder &&
      !(await requestVaultFolderChange(requestedFolder))
    ) {
      return;
    }
    persistSettings(
      requestedFolder === settings.vaultFolder
        ? settings
        : { ...settings, vaultFolder: requestedFolder }
    );
    setSettingsStatus("Settings saved");
  }

  const { resetProgress, resetAllSettingsAndCaches } = useSettingsReset({
    serverUrls: servers.urls,
    onRestoreDefaults: () => {
      auth.logout();
      servers.reset();
      setThemeMode("system");
      setLightTheme("default");
      setDarkTheme("dark");
      setSettings(defaultSettings);
    },
    onStatus: setSettingsStatus
  });

  function renderSettingsPanes(): FeaturePanes {
    return {
      middle: (
        <SettingsCategoryPane
          section={settingsSection}
          onSelect={selectSettingsSection}
        />
      ),
      detail: (
        <Suspense
          fallback={<div className="detail-loading">Loading settings...</div>}
        >
          <SettingsPage
            section={settingsSection}
            target={settingsTarget}
            onTargetConsumed={consumeSettingsTarget}
            settings={
              vaultFolderDraft === settings.vaultFolder
                ? settings
                : { ...settings, vaultFolder: vaultFolderDraft }
            }
            status={settingsStatus}
            resetProgress={resetProgress}
            themeMode={themeMode}
            lightTheme={lightTheme}
            darkTheme={darkTheme}
            onThemeModeChange={setThemeMode}
            onLightThemeChange={setLightTheme}
            onDarkThemeChange={setDarkTheme}
            servers={servers}
            auth={auth}
            onUpdate={updateSetting}
            onBrowseVaultFolder={browseVaultFolder}
            onSave={saveSettings}
            onResetAll={resetAllSettingsAndCaches}
            onClose={closeSettings}
          />
        </Suspense>
      )
    };
  }

  const withFeatureProviders = (content: ReactNode): ReactNode =>
    featureRegistry.reduceRight<ReactNode>((wrapped, feature) => {
      const runtime = featureRuntimeHost.readyRuntimes.get(feature.id);
      if (!runtime) {
        return wrapped;
      }
      const FeatureProvider = runtime.Provider;
      return <FeatureProvider key={feature.id}>{wrapped}</FeatureProvider>;
    }, content);


  const featurePanes = featureRegistry.flatMap((feature) => {
    const runtime = featureRuntimeHost.readyRuntimes.get(feature.id);
    if (!runtime || (!feature.keepMounted && feature.id !== activeFeatureId)) {
      return [];
    }
    return [
      {
        id: feature.id,
        active: feature.id === activeFeatureId,
        panes: runtime.renderPanes({ renderSettingsPanes })
      }
    ];
  });

  if (featureRuntimeHost.active.status !== "ready") {
    const loading =
      featureRuntimeHost.active.status === "idle" ||
      featureRuntimeHost.active.status === "loading";
    featurePanes.push({
      id: activeFeatureId,
      active: true,
      panes: {
        middle:
          activeFeatureId === "notes"
            ? undefined
            : loading ? (
          <div className="feature-runtime-loading" role="status">
            Loading {activeFeature.label}…
          </div>
        ) : (
          <div className="feature-runtime-error" role="alert">
            <p>{activeFeature.label}를 열 수 없습니다.</p>
            <button type="button" onClick={featureRuntimeHost.retry}>
              다시 시도
            </button>
          </div>
        ),
        detail: <div className="detail-loading" aria-hidden="true" />
      }
    });
  }

  const notesFeaturePanes = featurePanes.find(
    ({ id }) => id === "notes"
  )?.panes;
  const activeFeaturePanes = featurePanes.find(({ active }) => active)?.panes;
  const hasMiddlePane = activeFeaturePanes?.middle !== undefined;
  const notesRuntimeReady = featureRuntimeHost.readyRuntimes.has("notes");
  const notesStatus = notesRuntimeReady
    ? "ready"
    : activeFeatureId === "notes"
      ? featureRuntimeHost.active.status
      : "idle";

  const layoutStyle = {
    "--sidebar-width": paneCollapsed.sidebar
      ? "0px"
      : `${paneWidths.sidebar}px`,
    "--list-width": paneCollapsed.list ? "0px" : `${paneWidths.list}px`
  } as CSSProperties;

  return (
    <NotesFeedbackProvider active={activeFeatureId === "notes"}>
      <GithubConnectionContext.Provider value={auth.connection}>
        <MarkdownStyleContext.Provider value={settings.markdownStyle}>
          <VaultRootContext.Provider value={vaultRoot}>
            <AppNavigationContext.Provider value={appNavigation}>
              <ExternalSourcesContext.Provider
                value={githubNotificationsRuntime.externalSources}
              >
                <PaneLayoutContext.Provider value={paneLayoutControls}>
                  <main
                    className="app-shell"
                    aria-label="Yonalist layout"
                    style={layoutStyle}
                    data-active-feature={activeFeatureId}
                    data-has-middle-pane={hasMiddlePane ? "true" : undefined}
                    data-sidebar-collapsed={
                      paneCollapsed.sidebar ? "true" : undefined
                    }
                    data-list-collapsed={
                      paneCollapsed.list ? "true" : undefined
                    }
                    data-detail-maximized={
                      detailMaximized ? "true" : undefined
                    }
                  >
                    <TitleBar
                      paneToggles={{
                        sidebarCollapsed: paneCollapsed.sidebar,
                        detailMaximized,
                        middlePaneVisible: hasMiddlePane,
                        onToggleSidebar: () =>
                          togglePaneCollapsed("sidebar"),
                        onToggleMaximize: toggleDetailMaximized,
                        showDetailMaximizeToggle: !(
                          activeFeatureId === "notes" &&
                          activeFeatureRuntimeReady
                        )
                      }}
                    />
                    <FeatureRuntimeBoundary
                      featureId={activeFeatureId}
                      onRetry={featureRuntimeHost.retry}
                    >
                      {withFeatureProviders(
                        <>
                          <YonalistNavigationPane
                            activeFeatureId={activeFeatureId}
                            online={online}
                            loginRequired={!auth.signedIn}
                            notesStatus={notesStatus}
                            headerActions={
                              notesFeaturePanes?.navigation?.headerActions ??
                              null
                            }
                            onOpenNotes={openNotes}
                            onOpenSettings={openSettings}
                            onRetryNotes={featureRuntimeHost.retry}
                            onToggleOnline={toggleOnline}
                          >
                            {notesFeaturePanes?.navigation?.content ?? null}
                          </YonalistNavigationPane>

                          <div
                            className="pane-resizer sidebar-list-resizer"
                            role="separator"
                            aria-label="Resize navigation pane"
                            aria-orientation="vertical"
                            aria-valuemin={paneWidthLimits.sidebar.min}
                            aria-valuemax={paneWidthLimits.sidebar.max}
                            aria-valuenow={paneWidths.sidebar}
                            tabIndex={0}
                            onPointerDown={(event) =>
                              startResize("sidebar", event)
                            }
                            onKeyDown={(event) =>
                              resizeWithKeyboard("sidebar", event)
                            }
                          />

                          {hasMiddlePane && (
                            <>
                              <div className="feature-pane-slot">
                                {activeFeaturePanes?.middle}
                              </div>
                              <div
                                className="pane-resizer list-detail-resizer"
                                role="separator"
                                aria-label="Resize item list pane"
                                aria-orientation="vertical"
                                aria-valuemin={paneWidthLimits.list.min}
                                aria-valuemax={paneWidthLimits.list.max}
                                aria-valuenow={paneWidths.list}
                                tabIndex={0}
                                onPointerDown={(event) =>
                                  startResize("list", event)
                                }
                                onKeyDown={(event) =>
                                  resizeWithKeyboard("list", event)
                                }
                              />
                            </>
                          )}

                          <section className="detail-pane" aria-label="Detail">
                            <div className="pane-titlebar-spacer" />
                            <div className="detail-scroll">
                              {featurePanes.map(({ id, active, panes }) => (
                                <div
                                  key={id}
                                  className="feature-pane-slot"
                                  hidden={!active}
                                >
                                  {panes.detail}
                                </div>
                              ))}
                            </div>
                          </section>
                        </>
                      )}
                    </FeatureRuntimeBoundary>

                    <AppStatusBar
                      feedback={<NotesStatusBarMessage />}
                      online={online}
                    />

                    <Toast.Provider
                      toastManager={appToastManager}
                      timeout={APP_SNACKBAR_TIMEOUT_MS}
                    >
                      <Toast.Portal>
                        <Toast.Viewport
                          className="app-toast-viewport"
                          aria-label="App messages"
                        >
                          <AppSnackbarToasts />
                        </Toast.Viewport>
                      </Toast.Portal>
                    </Toast.Provider>
                  </main>
                </PaneLayoutContext.Provider>
              </ExternalSourcesContext.Provider>
            </AppNavigationContext.Provider>
          </VaultRootContext.Provider>
        </MarkdownStyleContext.Provider>
      </GithubConnectionContext.Provider>
    </NotesFeedbackProvider>
  );
}
