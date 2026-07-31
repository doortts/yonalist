import { Plus, Search, Settings } from "lucide-react";
import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type CSSProperties
} from "react";
import "./styles.css";
import "./notes.css";
import { tauriNotesApi, type NotesApi } from "./api";
import { NotesStore } from "./notesStore";
import type { LibraryView } from "./LibraryViewButtons";
import type { PaneRestoreRequest } from "./NotesOutline";
import { NotesInteractionHistory } from "./notesInteractionHistory";
import {
  capturePane,
  emptyPaneLocation,
  type AppNavigationLocation
} from "./appNavigation";
import { NotesDetailPanes } from "./NotesDetailPanes";
import type { OutlineTagToken } from "./OutlineTextField";
import {
  LazyMonacoOutlineSessionRegistry
} from "./monaco-outline/lazyRegistry";
import {
  preloadMonacoOutlineRuntime
} from "./monaco-outline/runtimeLoader";
const SearchPanel = lazy(() => import("./SearchPanel").then((module) =>
  ({ default: module.SearchPanel })));
const LibraryViewButtons = lazy(() =>
  import("./LibraryViewButtons").then((module) => ({
    default: module.LibraryViewButtons
  })));
const LibraryPageRow = lazy(() =>
  import("./LibraryPageRow").then((module) => ({
    default: module.LibraryPageRow
  })));
const WindowChrome = lazy(() =>
  import("./WindowChrome").then((module) => ({
    default: module.WindowChrome
  })));

export function App({ api = tauriNotesApi }: { readonly api?: NotesApi }) {
  const store = useMemo(() => new NotesStore(api), [api]);
  const monacoSessions = useMemo(
    () => new LazyMonacoOutlineSessionRegistry({
      loadMonacoPage: (pageId) => store.loadMonacoPage(pageId),
      executeEditorBatch: (requestId, commands) =>
        store.executeEditorBatch(requestId, commands)
    }),
    [store]
  );
  const state = useSyncExternalStore(
    store.subscribeShell,
    store.getShellSnapshot,
    store.getShellSnapshot
  );
  const [query, setQuery] = useState("");
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
  useEffect(() => {
    preloadMonacoOutlineRuntime(window.location.search);
  }, []);
  useEffect(
    () => () => interactionHistory.dispose(),
    [interactionHistory]
  );
  useEffect(
    () => () => {
      void monacoSessions.dispose().catch(() => undefined);
    },
    [monacoSessions]
  );
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
        async () => {
          await monacoSessions.flushAll("close");
          await store.close();
        },
        () => appWindow.destroy()
      ));
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [monacoSessions, store]);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const modifier = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
      if (!modifier || event.key.toLowerCase() !== "z") return;
      if (!shouldRouteUndoToApplication(
        event.target,
        modifier,
        monacoSessions.hasFocusedEditor(event.target)
      )) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) void interactionHistory.redo();
      else void interactionHistory.undo();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [interactionHistory, monacoSessions]);
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
  const activePage = state.pages.find((page) => page.id === state.activePageId);
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
      const currentPageId = store.getSnapshot().activePageId;
      if (currentPageId) {
        await monacoSessions.flushPage(currentPageId, "navigation");
      }
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
  }, [monacoSessions, store]);
  applyNavigationRef.current = applyNavigation;
  const recordNavigation = useCallback((
    before: AppNavigationLocation,
    after: AppNavigationLocation
  ) => interactionHistory.recordNavigation(before, after), [
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
    const currentPageId = store.getSnapshot().activePageId;
    if (currentPageId) {
      await monacoSessions.flushPage(currentPageId, "navigation");
    }
    await store.flushAllDrafts();
    const before = captureNavigation();
    await store.openPage(pageId);
    const after = emptyPaneLocation(pageId);
    await applyNavigation(after);
    recordNavigation(before, after);
  }, [
    applyNavigation,
    captureNavigation,
    monacoSessions,
    recordNavigation,
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
      <Suspense fallback={null}>
        <WindowChrome
          sidebarCollapsed={sidebarCollapsed}
          detailMaximized={detailMaximized}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onToggleDetail={() => setDetailMaximized((value) => !value)}
        />
      </Suspense>
      <nav className="yonalist-navigation-pane" aria-label="Navigation" data-active-feature="notes">
        <div className="pane-titlebar-spacer" />
        <header className="yonalist-navigation-header">
          <h1>Yonalist</h1>
          <div className="yonalist-navigation-header-actions" />
        </header>
        <div className="yonalist-navigation-scroll">
          <section
            className="notes-navigation-content"
            aria-label="Yonalist library"
            aria-busy={state.status === "loading"}
          >
            <div className="notes-library-discovery">
              <button
                className="primary-button notes-new-page"
                type="button"
                  disabled={state.status === "loading"}
                  onClick={() => {
                    const before = captureNavigation();
                    afterDraftFlush(() => {
                      void store.createPage().then((pageId) => {
                        const after = emptyPaneLocation(pageId);
                        void applyNavigation(after).then(() =>
                          recordNavigation(before, after));
                      });
                    });
                  }}
              >
                <Plus size={16} aria-hidden="true" />
                <span>New page</span>
              </button>
              <label className="notes-search-field">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search Yonalist"
                  placeholder="Search Yonalist"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              {libraryQuery && (
                <Suspense fallback={<p className="notes-pane-state">Searching...</p>}>
                  <SearchPanel
                    query={libraryQuery}
                    store={store}
                    onOpen={(pageId) => {
                      setQuery("");
                      void openPage(pageId);
                    }}
                  />
                </Suspense>
              )}
              <section className="notes-navigation-section" aria-labelledby="library-title">
                <h2 id="library-title" className="eyebrow">Library</h2>
                <div className="notes-library-views" role="group" aria-label="Yonalist library views">
                  <Suspense fallback={null}>
                    <LibraryViewButtons
                      active={libraryView}
                      onSelect={(view) => {
                        setLibraryView(view);
                        setQuery("");
                      }}
                    />
                  </Suspense>
                </div>
              </section>
            </div>
            <section
              className="notes-navigation-section notes-navigation-pages"
              aria-labelledby="pages-title"
              hidden={libraryView !== "all" || query.trim().length > 0}
            >
              <h2 id="pages-title" className="eyebrow">Pages</h2>
              <div className="notes-library-list">
                <Suspense fallback={null}>
                  {state.pages.map((page) => (
                    <LibraryPageRow
                      key={page.id}
                      page={page}
                      active={page.id === state.activePageId}
                      store={store}
                      onOpen={() => void openPage(page.id)}
                    />
                  ))}
                </Suspense>
              </div>
            </section>
          </section>
        </div>
        <footer className="yonalist-navigation-footer">
          <button className="nav-item" type="button" disabled>
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
        onOpenSplit={openSplit}
        onCloseSplit={closeSplit}
        onTagClick={handleTagClick}
        monacoSessions={monacoSessions}
      />
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

export function shouldRouteUndoToApplication(
  target: EventTarget | null,
  modifierPressed: boolean,
  hasFocusedMonaco = false
): boolean {
  if (!modifierPressed || hasFocusedMonaco) return false;
  return !(
    target instanceof Element &&
    target.closest(".notes-monaco-outline")
  );
}
