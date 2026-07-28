import { Plus, Search, Settings } from "lucide-react";
import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type CSSProperties
} from "react";
import "./styles.css";
import "./notes.css";
import { tauriNotesApi, type NotesApi } from "./api";
import { NotesStore } from "./notesStore";
import { WindowChrome } from "./WindowChrome";
import { LibraryViewButtons, type LibraryView } from "./LibraryViewButtons";
import { LibraryPageRow } from "./LibraryPageRow";
import { useSplitResize } from "./useSplitResize";
import { createCloseRequestHandler } from "./closeSession";
import {
  NotesOutline,
  type PaneFocusSnapshot,
  type PaneRestoreRequest
} from "./NotesOutline";
import { NotesInteractionHistory } from "./notesInteractionHistory";
const SearchPanel = lazy(() => import("./SearchPanel").then((module) =>
  ({ default: module.SearchPanel })));

interface AppNavigationLocation {
  readonly pageId: string | null;
  readonly primaryZoomRootId: string | null;
  readonly splitOpen: boolean;
  readonly secondaryZoomRootId: string | null;
  readonly primarySelectedIds: readonly string[];
  readonly primaryFocus: PaneFocusSnapshot | null;
  readonly secondarySelectedIds: readonly string[];
  readonly secondaryFocus: PaneFocusSnapshot | null;
}

function capturePane(paneId: "primary" | "secondary") {
  const scope = document.querySelector<HTMLElement>(
    `[data-outline-pane-id="${paneId}"]`
  );
  const selectedIds = scope
    ? [...scope.querySelectorAll<HTMLElement>(
        "[data-outline-id][data-selected='true']"
      )].flatMap((node) => node.dataset.outlineId
        ? [node.dataset.outlineId]
        : [])
    : [];
  const active = document.activeElement;
  if (
    !scope ||
    !(active instanceof HTMLTextAreaElement) ||
    !scope.contains(active)
  ) {
    return { selectedIds, focus: null };
  }
  const nodeId = active.dataset.nodeId;
  const field = active.dataset.outlineField;
  const focus = nodeId && (field === "title" || field === "note")
    ? {
        nodeId,
        field,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd
      } satisfies PaneFocusSnapshot
    : null;
  return { selectedIds, focus };
}

export function App({ api = tauriNotesApi }: { readonly api?: NotesApi }) {
  const store = useMemo(() => new NotesStore(api), [api]);
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
  const splitResize = useSplitResize(splitOpen);
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
  useEffect(
    () => () => interactionHistory.dispose(),
    [interactionHistory]
  );
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
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
      const modifier = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
      if (!modifier || event.key.toLowerCase() !== "z") return;
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
  const recordNavigation = (
    before: AppNavigationLocation,
    after: AppNavigationLocation
  ) => interactionHistory.recordNavigation(before, after);
  const afterDraftFlush = (action: () => void) => {
    const current = store.getSnapshot();
    if (
      Object.keys(current.drafts).length === 0 &&
      Object.keys(current.noteDrafts).length === 0
    ) {
      action();
      return;
    }
    void store.flushAllDrafts().then(action);
  };
  const openPage = async (pageId: string) => {
    if (pageId === state.activePageId) return;
    await store.flushAllDrafts();
    const before = captureNavigation();
    await store.openPage(pageId);
    const after = {
      pageId,
      primaryZoomRootId: null,
      splitOpen: false,
      secondaryZoomRootId: null,
      primarySelectedIds: [],
      primaryFocus: null,
      secondarySelectedIds: [],
      secondaryFocus: null
    };
    await applyNavigation(after);
    recordNavigation(before, after);
  };
  const updatePrimaryZoom = (nodeId: string | null) => {
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
  };
  const openSplit = (nodeId: string) => {
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
  };
  const updateSecondaryZoom = (nodeId: string | null) => {
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
  };
  const closeSplit = () => {
    if (!splitOpen) return;
    const before = captureNavigation();
    afterDraftFlush(() => {
      setSplitOpen(false);
      recordNavigation(before, { ...before, splitOpen: false });
    });
  };
  const libraryQuery = query.trim() ||
    (libraryView === "starred"
      ? "is:starred"
      : libraryView === "tags"
        ? "is:tagged"
        : libraryView === "trash"
          ? "is:trash"
          : "");
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
                        const after = {
                          pageId,
                          primaryZoomRootId: null,
                          splitOpen: false,
                          secondaryZoomRootId: null,
                          primarySelectedIds: [],
                          primaryFocus: null,
                          secondarySelectedIds: [],
                          secondaryFocus: null
                        };
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
                  <LibraryViewButtons
                    active={libraryView}
                    onSelect={(view) => {
                      setLibraryView(view);
                      setQuery("");
                    }}
                  />
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
                {state.pages.map((page) => (
                  <LibraryPageRow
                    key={page.id}
                    page={page}
                    active={page.id === state.activePageId}
                    store={store}
                    onOpen={() => void openPage(page.id)}
                  />
                ))}
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
      <section className="detail-pane" aria-label="Detail">
        <div className="pane-titlebar-spacer" />
        <div
          className="detail-scroll"
          style={{ overflowY: splitOpen ? "hidden" : undefined }}
        >
          <div
            ref={splitResize.containerRef}
            className="notes-detail-split"
            data-split-open={splitOpen ? "true" : undefined}
            style={{
              "--notes-split-primary": `${splitResize.primaryPercent}%`
            } as CSSProperties}
          >
            <div
              className="notes-detail-pane"
              style={{ overflowY: splitOpen ? "auto" : undefined }}
            >
              <NotesOutline
                store={store}
                status={state.status}
                error={state.error}
                pendingWrites={state.pendingWrites}
                page={activePage}
                zoomRootId={primaryZoomRootId}
                onZoomRootChange={updatePrimaryZoom}
                paneId="primary"
                restoreRequest={primaryRestore}
                onOpenSplit={openSplit}
                onTagClick={(token) =>
                  setQuery(`tag:${token.prefix}${token.normalized}`)}
              />
            </div>
            {splitOpen && (
              <>
                <div
                  className="notes-split-divider"
                  role="separator"
                  aria-label="Resize split"
                  aria-orientation="vertical"
                  aria-valuemin={25}
                  aria-valuemax={75}
                  aria-valuenow={Math.round(splitResize.primaryPercent)}
                  tabIndex={0}
                  onPointerDown={splitResize.onPointerDown}
                  onKeyDown={splitResize.onKeyDown}
                />
                <div className="notes-detail-pane" style={{ overflowY: "auto" }}>
                  <NotesOutline
                    store={store}
                    status={state.status}
                    error={state.error}
                    pendingWrites={state.pendingWrites}
                    page={activePage}
                    zoomRootId={secondaryZoomRootId}
                    onZoomRootChange={updateSecondaryZoom}
                    paneId="secondary"
                    restoreRequest={secondaryRestore}
                    onOpenSplit={openSplit}
                    onTagClick={(token) =>
                      setQuery(`tag:${token.prefix}${token.normalized}`)}
                    onClose={closeSplit}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </section>
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
