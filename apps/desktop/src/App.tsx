import { House, Plus, Search, Settings } from "lucide-react";
import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type CSSProperties
} from "react";
import "./styles.css";
import "./notes.css";
import "./formControls.css";
import { tauriNotesApi, type NotesApi } from "./api";
import { useTheme } from "./useTheme";
import { useOutlineMarkerStyles } from "./outlineMarkers";
import { NotesStore } from "./notesStore";
import { WindowChrome } from "./WindowChrome";
import { LibraryViewButtons, type LibraryView } from "./LibraryViewButtons";
import { LibraryPageRow } from "./LibraryPageRow";
import type { PaneRestoreRequest } from "./NotesOutline";
import { NotesInteractionHistory } from "./notesInteractionHistory";
import {
  isDevtoolsShortcut, isDragDebugShortcut, toggleDevtools
} from "./devtools";
import {
  capturePane,
  emptyPaneLocation,
  type AppNavigationLocation
} from "./appNavigation";
import { NotesDetailPanes } from "./NotesDetailPanes";
import { ROOT_ID } from "./store/storeSupport";
import type { OutlineTagToken } from "./outline/OutlineTextField";
import { ShortcutHint, useShortcutHints } from "./shortcutHints";
const SearchPanel = lazy(() => import("./SearchPanel").then((module) =>
  ({ default: module.SearchPanel })));
// Settings pulls in @base-ui/react, which costs ~12KB gzip of first paint the
// outline never needs. It stays out of the entry chunk like the row menus do.
const SettingsView = lazy(() => import("./SettingsView").then((module) =>
  ({ default: module.SettingsView })));
// Shown at most once per install, so it stays out of the startup bundle.
const VaultSetupCard = lazy(() => import("./VaultSetupCard").then((module) =>
  ({ default: module.VaultSetupCard })));

export function App({ api = tauriNotesApi }: { readonly api?: NotesApi }) {
  const theme = useTheme();
  const markers = useOutlineMarkerStyles();
  useShortcutHints();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const store = useMemo(() => new NotesStore(api), [api]);
  const state = useSyncExternalStore(
    store.subscribeShell,
    store.getShellSnapshot,
    store.getShellSnapshot
  );
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const closeSearch = useCallback(() => {
    setQuery("");
    setSearchOpen(false);
  }, []);
  // The settings section re-reads the folder whenever this identity changes, so
  // both stay pinned to the api rather than to a render.
  const readVaultPath = useCallback(() => api.syncVaultGet(), [api]);
  // The settings screen only needs the choice recorded; what the folder held
  // is the first-run card's business.
  const chooseVaultPath = useCallback(
    (path: string) => api.syncVaultSet(path),
    [api]
  );
  const setVaultPath = useCallback(async (path: string) => {
    await chooseVaultPath(path);
  }, [chooseVaultPath]);
  const [libraryView, setLibraryView] = useState<LibraryView>("all");
  const [sidebarWidth, setSidebarWidth] = useState(336);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailMaximized, setDetailMaximized] = useState(false);
  const [primaryZoomRootId, setPrimaryZoomRootId] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [secondaryZoomRootId, setSecondaryZoomRootId] =
    useState<string | null>(null);
  const [primaryRestore, setPrimaryRestore] =
    useState<PaneRestoreRequest | null>(null);
  const [secondaryRestore, setSecondaryRestore] =
    useState<PaneRestoreRequest | null>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const applyNavigationRef = useRef<
    (location: AppNavigationLocation) => Promise<void>
  >(async () => undefined);
  const restoreEpoch = useRef(0);
  const interactionHistory = useMemo(() => new NotesInteractionHistory(
    store,
    (location: AppNavigationLocation) => applyNavigationRef.current(location)
  ), [store]);
  useEffect(() => {
    void store.bootstrap();
  }, [store]);
  useEffect(() => interactionHistory.connect(), [interactionHistory]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void Promise.all([
      import("@tauri-apps/api/window"),
      import("./closeSession")
    ]).then(async ([
      { getCurrentWindow },
      { createCloseRequestHandler }
    ]) => {
      if (!active) return;
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested(createCloseRequestHandler(
        () => store.close(),
        () => appWindow.destroy()
      ));
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [store]);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      // Shares this listener with undo rather than registering a second one:
      // the window has no menu bar, so the inspector has to be reachable from
      // anywhere, including inside a row textarea, and the undo guard below
      // must not apply to it.
      if (isDevtoolsShortcut(event)) {
        event.preventDefault();
        void toggleDevtools();
        return;
      }
      // Purely a paint on the document element, so it needs no React state and
      // cannot re-render (or re-mount a textarea) out from under a drag test.
      if (isDragDebugShortcut(event)) {
        event.preventDefault();
        document.documentElement.toggleAttribute("data-drag-debug");
        return;
      }
      const modifier = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
      // The library search is the window's only find, so Cmd+F reaches it from
      // anywhere, including from inside a row textarea.
      if (modifier && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        // Already open: the field is mounted, so nothing re-runs its autoFocus
        // and the caret has to be sent back by hand.
        searchInput.current?.focus();
        return;
      }
      if (!modifier || event.key.toLowerCase() !== "z") return;
      // Every other text field on screen -- the library search, the Move To
      // and Tags filters -- keeps its own native undo. The outline's row and
      // note textareas deliberately do not, and `data-outline-field` is what
      // marks them: the choosers render inside `.notes-outline`, so the class
      // scope cannot tell the two apart.
      const target = event.target as HTMLElement | null;
      if (
        (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") &&
        !target.hasAttribute("data-outline-field")
      ) return;
      event.preventDefault();
      if (event.shiftKey) void interactionHistory.redo();
      else void interactionHistory.undo();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [interactionHistory]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!resizeStart.current) return;
      setSidebarWidth(Math.min(520, Math.max(240,
        resizeStart.current.width + event.clientX - resizeStart.current.x)));
    };
    const stop = () => {
      resizeStart.current = null;
      document.body.classList.remove("is-resizing-pane");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, []);
  // Home is the root page, and the root is no page's row, so the pane gets a
  // titleless stand-in rather than a lookup that can never hit.
  const atHome = state.activePageId === ROOT_ID;
  const activePage = atHome
    ? { id: ROOT_ID, title: "" }
    : state.pages.find((page) => page.id === state.activePageId);
  const captureNavigation = useCallback((): AppNavigationLocation => {
    const primary = capturePane("primary");
    const secondary = capturePane("secondary");
    return {
      pageId: state.activePageId,
      primaryZoomRootId,
      splitOpen,
      secondaryZoomRootId,
      primarySelectedIds: primary.selectedIds,
      primaryFocus: primary.focus,
      secondarySelectedIds: secondary.selectedIds,
      secondaryFocus: secondary.focus
    };
  }, [
    primaryZoomRootId,
    secondaryZoomRootId,
    splitOpen,
    state.activePageId
  ]);
  const applyNavigation = useCallback(async (
    location: AppNavigationLocation
  ) => {
    if (
      location.pageId &&
      location.pageId !== store.getSnapshot().activePageId
    ) {
      await store.openPage(location.pageId);
    }
    setPrimaryZoomRootId(location.primaryZoomRootId);
    setSplitOpen(location.splitOpen);
    setSecondaryZoomRootId(location.secondaryZoomRootId);
    const epoch = ++restoreEpoch.current;
    setPrimaryRestore({
      epoch,
      selectedIds: location.primarySelectedIds,
      focus: location.primaryFocus
    });
    setSecondaryRestore({
      epoch,
      selectedIds: location.secondarySelectedIds,
      focus: location.secondaryFocus
    });
  }, [store]);
  applyNavigationRef.current = applyNavigation;
  const recordNavigation = useCallback((
    before: AppNavigationLocation,
    after: AppNavigationLocation
  ) => interactionHistory.recordNavigation(before, after), [
    interactionHistory
  ]);
  const recordMutationNavigation = useCallback((
    before: AppNavigationLocation,
    after: AppNavigationLocation
  ) => interactionHistory.recordMutationNavigation(before, after), [
    interactionHistory
  ]);
  const afterDraftFlush = useCallback((action: () => void) => {
    const current = store.getSnapshot();
    if (
      Object.keys(current.drafts).length === 0 &&
      Object.keys(current.noteDrafts).length === 0
    ) {
      action();
      return;
    }
    void store.flushAllDrafts().then(action);
  }, [store]);
  const openPage = useCallback(async (pageId: string) => {
    if (pageId === store.getSnapshot().activePageId) return;
    await store.flushAllDrafts();
    const before = captureNavigation();
    await store.openPage(pageId);
    const after = emptyPaneLocation(pageId);
    await applyNavigation(after);
    recordNavigation(before, after);
  }, [applyNavigation, captureNavigation, recordNavigation, store]);
  // Home is the root page like any other page, house crumb included.
  const openHome = useCallback(() => void openPage(ROOT_ID), [openPage]);
  // Creating a page and trashing one both move the view as part of the
  // command, so each records a single entry that replays both.
  const createPage = useCallback(() => {
    const before = captureNavigation();
    afterDraftFlush(() => {
      void store.createPage().then(async (pageId) => {
        const after = emptyPaneLocation(pageId);
        await applyNavigation(after);
        recordMutationNavigation(before, after);
      });
    });
  }, [
    afterDraftFlush,
    applyNavigation,
    captureNavigation,
    recordMutationNavigation,
    store
  ]);
  const deletePage = useCallback((pageId: string) => {
    const before = captureNavigation();
    afterDraftFlush(() => {
      void store.deleteSubtree(pageId).then(async () => {
        // The store already fell back to Home when the open page went away.
        const after = emptyPaneLocation(store.getSnapshot().activePageId);
        await applyNavigation(after);
        recordMutationNavigation(before, after);
      });
    });
  }, [
    afterDraftFlush,
    applyNavigation,
    captureNavigation,
    recordMutationNavigation,
    store
  ]);
  const updatePrimaryZoom = useCallback((nodeId: string | null) => {
    if (nodeId === primaryZoomRootId) return;
    const before = captureNavigation();
    afterDraftFlush(() => {
      setPrimaryZoomRootId(nodeId);
      recordNavigation(before, {
        ...before,
        primaryZoomRootId: nodeId,
        primarySelectedIds: [],
        primaryFocus: null
      });
    });
  }, [
    afterDraftFlush,
    captureNavigation,
    primaryZoomRootId,
    recordNavigation
  ]);
  const openSplit = useCallback((nodeId: string) => {
    const before = captureNavigation();
    afterDraftFlush(() => {
      setSplitOpen(true);
      setSecondaryZoomRootId(nodeId);
      recordNavigation(before, {
        ...before,
        splitOpen: true,
        secondaryZoomRootId: nodeId,
        secondarySelectedIds: [],
        secondaryFocus: null
      });
    });
  }, [afterDraftFlush, captureNavigation, recordNavigation]);
  const updateSecondaryZoom = useCallback((nodeId: string | null) => {
    if (nodeId === secondaryZoomRootId) return;
    const before = captureNavigation();
    afterDraftFlush(() => {
      setSecondaryZoomRootId(nodeId);
      recordNavigation(before, {
        ...before,
        secondaryZoomRootId: nodeId,
        secondarySelectedIds: [],
        secondaryFocus: null
      });
    });
  }, [
    afterDraftFlush,
    captureNavigation,
    recordNavigation,
    secondaryZoomRootId
  ]);
  const closeSplit = useCallback(() => {
    if (!splitOpen) return;
    const before = captureNavigation();
    afterDraftFlush(() => {
      setSplitOpen(false);
      recordNavigation(before, { ...before, splitOpen: false });
    });
  }, [
    afterDraftFlush,
    captureNavigation,
    recordNavigation,
    splitOpen
  ]);
  const libraryQuery = query.trim() ||
    (libraryView === "starred"
      ? "is:starred"
      : libraryView === "tags"
        ? "is:tagged"
        : libraryView === "trash"
          ? "is:trash"
          : "");
  const handleTagClick = useCallback((token: OutlineTagToken) => {
    setQuery(`tag:${token.prefix}${token.normalized}`);
  }, []);
  const shellStyle = {
    "--sidebar-width": sidebarCollapsed ? "0px" : `${sidebarWidth}px`
  } as CSSProperties;
  return (
    <main
      className="app-shell"
      aria-label="Yonalist layout"
      style={shellStyle}
      data-active-feature="notes"
      data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined}
      data-detail-maximized={detailMaximized ? "true" : undefined}
    >
      <WindowChrome
        sidebarCollapsed={sidebarCollapsed}
        detailMaximized={detailMaximized}
        onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
        onToggleDetail={() => setDetailMaximized((value) => !value)}
      />
      <nav className="yonalist-navigation-pane" aria-label="Navigation" data-active-feature="notes">
        <div className="pane-titlebar-spacer" />
        <header
          className="yonalist-navigation-header"
          data-tauri-drag-region="deep"
          data-search-open={searchOpen ? "true" : undefined}
        >
          <h1>Yonalist</h1>
          {/* The field grows out of the icon's own place and over the title, so
              the icon has to stop being a button once it is the field's leading
              glyph: a click on it inside an open field would otherwise blur the
              input and take the toggle with it. Escape and blur close it. */}
          <div className="notes-search-field">
            {searchOpen ? (
              <>
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchInput}
                  type="search"
                  aria-label="Search Yonalist"
                  placeholder="Search Yonalist"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.stopPropagation();
                    closeSearch();
                  }}
                  // An empty field has nothing to lose, so it goes as soon as
                  // it loses focus. A field with a query stays: its results are
                  // below it, and reaching one means clicking away from it.
                  onBlur={() => {
                    if (query.trim().length === 0) setSearchOpen(false);
                  }}
                />
              </>
            ) : (
              <button
                className="notes-library-icon-button"
                type="button"
                aria-label="Search"
                aria-expanded={false}
                aria-keyshortcuts="Meta+F Control+F"
                onClick={() => setSearchOpen(true)}
              >
                <Search size={16} aria-hidden="true" />
                <ShortcutHint mac="⌘F" other="Ctrl+F" />
              </button>
            )}
          </div>
        </header>
        <div className="yonalist-navigation-scroll">
          <section
            className="notes-navigation-content"
            aria-label="Yonalist library"
            aria-busy={state.status === "loading"}
          >
            <div className="notes-library-discovery">
              {/* Results lead the pane so they sit right under the field they
                  came from, instead of below the New page button. */}
              {libraryQuery && (
                <Suspense fallback={<p className="notes-pane-state">Searching...</p>}>
                  <SearchPanel
                    query={libraryQuery}
                    store={store}
                    onOpen={(pageId) => {
                      closeSearch();
                      void openPage(pageId);
                    }}
                  />
                </Suspense>
              )}
              <button
                className="primary-button notes-new-page"
                type="button"
                  disabled={state.status === "loading"}
                  onClick={createPage}
              >
                <Plus size={16} aria-hidden="true" />
                <span>New page</span>
              </button>
            </div>
            <section
              className="notes-navigation-section notes-navigation-pages"
              aria-labelledby="pages-title"
            >
              <h2 id="pages-title" className="eyebrow">Pages</h2>
              <div className="notes-library-list">
                {/* Home is the root page and no page's row, so the list leads
                    with its own entry instead of one from state.pages. It also
                    stays put while a filtered view or a search is on, since it
                    is the way back out of both. */}
                <div
                  className="notes-library-page-row"
                  data-active={atHome && libraryView === "all" ? "true" : undefined}
                >
                  <button
                    className="notes-library-page"
                    type="button"
                    aria-current={
                      atHome && libraryView === "all" ? "page" : undefined
                    }
                    onClick={() => {
                      setLibraryView("all");
                      setQuery("");
                      openHome();
                    }}
                  >
                    <House size={16} aria-hidden="true" />
                    <span>All</span>
                  </button>
                </div>
                {libraryView === "all" &&
                  query.trim().length === 0 &&
                  state.pages.map((page) => (
                    <LibraryPageRow
                      key={page.id}
                      page={page}
                      active={page.id === state.activePageId}
                      store={store}
                      onOpen={() => void openPage(page.id)}
                      onDelete={() => deletePage(page.id)}
                    />
                  ))}
              </div>
            </section>
            <section
              className="notes-navigation-section notes-navigation-library"
              aria-labelledby="library-title"
            >
              <h2 id="library-title" className="eyebrow">Library</h2>
              <div className="notes-library-views" role="group" aria-label="Yonalist library views">
                <LibraryViewButtons
                  active={atHome ? libraryView : null}
                  onSelect={(view) => {
                    setLibraryView(view);
                    setQuery("");
                    openHome();
                  }}
                />
              </div>
            </section>
          </section>
        </div>
        <footer className="yonalist-navigation-footer">
          <button
            className="nav-item"
            type="button"
            aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings size={16} aria-hidden="true" />
            <span>Settings</span>
          </button>
        </footer>
      </nav>
      <div
        className="pane-resizer sidebar-list-resizer"
        role="separator"
        aria-label="Resize navigation pane"
        aria-orientation="vertical"
        aria-valuemin={240}
        aria-valuemax={520}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={(event) => {
          resizeStart.current = { x: event.clientX, width: sidebarWidth };
          document.body.classList.add("is-resizing-pane");
        }}
      />
      {!settingsOpen && (
        <Suspense fallback={null}>
          <VaultSetupCard
            readVaultPath={readVaultPath}
            setVaultPath={chooseVaultPath}
          />
        </Suspense>
      )}
      {settingsOpen ? (
        <Suspense fallback={<p className="notes-pane-state">Loading settings...</p>}>
          <SettingsView
            themeMode={theme.mode}
            lightTheme={theme.lightTheme}
            darkTheme={theme.darkTheme}
            caretColor={theme.caretColor}
            textFont={theme.textFont}
            markerStyles={markers.markerStyles}
            onThemeModeChange={theme.setMode}
            onLightThemeChange={theme.setLightTheme}
            onDarkThemeChange={theme.setDarkTheme}
            onCaretColorChange={theme.setCaretColor}
            onTextFontChange={theme.setTextFont}
            onMarkerStylesChange={markers.setMarkerStyles}
            onClose={() => setSettingsOpen(false)}
            unusedAssets={(purge) => api.unusedAssets(purge)}
            deleteAllData={() => api.deleteAllData()}
            readVaultPath={readVaultPath}
            setVaultPath={setVaultPath}
          />
        </Suspense>
      ) : (
        <NotesDetailPanes
          store={store}
          status={state.status}
          error={state.error}
          pendingWrites={state.pendingWrites}
          page={activePage}
          splitOpen={splitOpen}
          primaryZoomRootId={primaryZoomRootId}
          secondaryZoomRootId={secondaryZoomRootId}
          primaryRestore={primaryRestore}
          secondaryRestore={secondaryRestore}
          onPrimaryZoomChange={updatePrimaryZoom}
          onSecondaryZoomChange={updateSecondaryZoom}
          onHome={openHome}
          onOpenSplit={openSplit}
          onCloseSplit={closeSplit}
          onTagClick={handleTagClick}
        />
      )}
      <footer className="app-statusbar" aria-label="Status bar">
        <div className="statusbar-feedback">
          {state.error && <span className="statusbar-message" data-kind="error">{state.error}</span>}
          {!state.error && state.pendingWrites > 0 && <span className="statusbar-message">Saving...</span>}
        </div>
        <div className="statusbar-actions"><span className="statusbar-state">Online</span></div>
      </footer>
    </main>
  );
}
