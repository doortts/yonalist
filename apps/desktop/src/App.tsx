import {
  CalendarDays, House, Minus, NotebookText, Plus, Search, Settings
} from "lucide-react";
import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type CSSProperties
} from "react";
import "./styles.css";
import "./notes.css";
import "./handwritingFaces.css";
import "./formControls.css";
import type { SyncChanged } from "../../../packages/contracts/generated/SyncChanged";
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
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  nudgePageZoom,
  pageZoomStep,
  resetPageZoom,
  STEP,
  usePageZoom
} from "./pageZoom";
import {
  isDevtoolsShortcut, isDragDebugShortcut, toggleDevtools
} from "./devtools";
import {
  capturePane,
  emptyPaneLocation,
  owningPageId,
  zoomEntryFocus,
  type AppNavigationLocation,
  type PaneFocusSnapshot
} from "./appNavigation";
import { NotesDetailPanes } from "./NotesDetailPanes";
import type { JournalDateMenuTarget } from "./JournalDateMenu";
import { ROOT_ID } from "./store/storeSupport";
import { journalDateOf, journalDays } from "./journal";
import { localDateIso } from "./outline/outlineSlash";
import type { OutlineTagToken } from "./outline/OutlineTextField";
import { ShortcutHint, useShortcutHints } from "./shortcutHints";
const SearchPanel = lazy(() => import("./SearchPanel").then((module) =>
  ({ default: module.SearchPanel })));
// Neither is on screen when the window opens: the feed waits for the Journals
// row and the menu for a date somebody presses, so their bytes wait too.
const JournalFeed = lazy(() => import("./JournalFeed").then((module) =>
  ({ default: module.JournalFeed })));
const JournalDateMenu = lazy(() => import("./JournalDateMenu").then((module) =>
  ({ default: module.JournalDateMenu })));
// The month is on screen from the start, so it is the one journal surface that
// costs a fallback: the sidebar keeps its height while the chunk lands, and
// what arrives is a grid nobody is typing into.
const JournalCalendar = lazy(() => import("./JournalCalendar").then((module) =>
  ({ default: module.JournalCalendar })));
// Settings pulls in @base-ui/react, which costs ~12KB gzip of first paint the
// outline never needs. It stays out of the entry chunk like the row menus do.
const SettingsView = lazy(() => import("./SettingsView").then((module) =>
  ({ default: module.SettingsView })));
// Shown at most once per install, so it stays out of the startup bundle.
// Most people never see this one: it draws nothing while sync is well, so
// its bytes have no business in the first load.
const SyncStatusBadge = lazy(() => import("./SyncStatusBadge").then((module) =>
  ({ default: module.SyncStatusBadge })));
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
  // Only for the page list's active row: which page a zoom is inside is a
  // question about the rows, and the shell snapshot does not carry them. It
  // costs this window one more render per structural edit -- an optimistic
  // move publishes rows before its receipt publishes anything else -- and none
  // per keystroke, since a draft publishes to its own row alone.
  const outline = useSyncExternalStore(
    store.subscribeOutline,
    store.getOutlineSnapshot,
    store.getOutlineSnapshot
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
  // Asked every time the card mounts, which is also every time settings closes:
  // a rebuild in there can leave the answer changed, and the card is the one
  // thing that has to notice.
  const isFirstRun = useCallback(() => api.onboardingFirstRun(), [api]);
  // Written and then read back: the guide arrives behind the store's back, so
  // nothing would show it until the next launch otherwise.
  const writeGuide = useCallback(async () => {
    await api.onboardingWriteGuide();
    await store.bootstrap();
  }, [api, store]);
  // Rebuilt and then read back, for the same reason the guide is: every row the
  // window is showing came from the database the rebuild just replaced, so
  // nothing on screen is about the notes that are there now.
  const rebuildFromVault = useCallback(async () => {
    const report = await api.rebuildFromVault();
    await store.bootstrap();
    return report;
  }, [api, store]);
  const readConflicts = useCallback(() => api.syncConflicts(200), [api]);
  const restoreConflict = useCallback(
    (seq: number) => api.syncRestoreConflict(seq),
    [api]
  );
  const forgetConflict = useCallback(
    (seq: number) => api.syncForgetConflict(seq),
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
  // The feed is the day the reader is writing in with the days before it
  // read underneath, so it stands in for the detail panes rather than
  // beside them: one editable outline is on screen either way.
  const [feedOpen, setFeedOpen] = useState(false);
  // The date a reader pressed, and where its menu opens. Held here rather
  // than in the pane: the same menu answers for a date in a row, in a note
  // and in a page title, and only one of them can be open at a time.
  const [dateMenu, setDateMenu] =
    useState<JournalDateMenuTarget | null>(null);
  const [secondaryZoomRootId, setSecondaryZoomRootId] =
    useState<string | null>(null);
  const [primaryRestore, setPrimaryRestore] =
    useState<PaneRestoreRequest | null>(null);
  const [secondaryRestore, setSecondaryRestore] =
    useState<PaneRestoreRequest | null>(null);
  const [paneSelections, setPaneSelections] =
    useState({ primary: 0, secondary: 0 });
  const pageZoom = usePageZoom();
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const applyNavigationRef = useRef<
    (location: AppNavigationLocation) => Promise<void>
  >(async () => undefined);
  const restoreEpoch = useRef(0);
  // Where the reader was when the settings screen went up, so Escape can put
  // them back on the row they were writing in.
  const settingsReturn = useRef<AppNavigationLocation | null>(null);
  const interactionHistory = useMemo(() => new NotesInteractionHistory(
    store,
    (location: AppNavigationLocation) => applyNavigationRef.current(location)
  ), [store]);
  // In the browser only. Under Tauri the first read waits for the vault
  // listener below: a merge announced before that subscription exists is
  // announced to nobody, and the window would hold a revision the session has
  // already left.
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) return;
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
    if (!("__TAURI_INTERNALS__" in window)) return;
    let stop: (() => void) | undefined;
    let active = true;
    void Promise.all([
      import("@tauri-apps/api/event"),
      import("./syncChanged")
    ]).then(([{ listen }, { connectVaultSync }]) => {
      if (!active) return;
      stop = connectVaultSync(
        (event, handler) =>
          listen<SyncChanged>(event, ({ payload }) => handler(payload)),
        (change) => store.absorbVaultChange(change),
        () => store.bootstrap()
      );
    }, () => {
      // The listener is where the first read hangs off now, so a module that
      // will not load must not leave the window empty as well as deaf. Not
      // for a window that has already gone: the read would be an IPC into
      // nothing.
      if (!active) return;
      void store.bootstrap();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [store]);
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
  // A zoom into home is a page opened by its own bullet: the page list has a
  // row for it, so that row is the one the reader is on, not All. The rows the
  // walk reads are the ones the pane is showing, which is what the zoom root
  // came from; a page it does not list is a page that has gone, and All stands
  // in until the pane follows.
  const zoomedPageId = useMemo(() => {
    const owner = owningPageId(primaryZoomRootId, outline.nodes);
    return owner && state.pages.some((page) => page.id === owner)
      ? owner
      : null;
  }, [outline.nodes, primaryZoomRootId, state.pages]);
  // Journal days are pages, but they are not in this list: one arrives every
  // day a reader writes, and a year of them would bury the pages somebody
  // named. The Journals section above the list is where they are reached.
  const pageRows = useMemo(
    () => state.pages.filter((page) => journalDateOf(page.title) === null),
    [state.pages]
  );
  // A filter or a search takes the page rows off screen, and a row that is not
  // there cannot be the one the reader is on: All keeps the mark, the way it
  // does with no zoom at all.
  const pageRowsListed = libraryView === "all" && query.trim().length === 0;
  const currentPageId = (pageRowsListed ? zoomedPageId : null) ??
    state.activePageId;
  // The All row heads the list it lists: home, unzoomed, with no filter on.
  const atAllPages = currentPageId === ROOT_ID && libraryView === "all";
  // The page nobody has written in yet is open and has no row in the list, so
  // the store is what answers for it. Only that one: an id the list has lost
  // for any other reason -- a page trashed on another device, a stale history
  // entry -- names a page that is gone, and an editable page over a row the
  // backend does not have would refuse every keystroke.
  // Which day the open page is, if it is a day at all. The Journals rows and
  // the calendar read it to know where the reader is standing, and the feed
  // reads it to know it still has a day at the top of it.
  // What the feed reads under today. A day that is not older than the one at
  // the top does not belong under it -- a date somebody wrote ahead of today
  // included.
  const allJournalDays = useMemo(
    () => journalDays(state.pages),
    [state.pages]
  );
  const feedDays = useMemo(
    () => allJournalDays.filter((day) => day.date < localDateIso()),
    [allJournalDays]
  );
  const activePage = atHome
    ? { id: ROOT_ID, title: "" }
    : state.pages.find((page) => page.id === state.activePageId) ??
      (state.provisionalPageId === state.activePageId && state.activePageId
        // A page nobody has written in has no row to read a title off, and a
        // journal day opens with one already decided: the node the store is
        // holding for it is where that title is.
        ? {
          id: state.activePageId,
          title: store.getNodeSnapshot(state.activePageId).title
        }
        : undefined);
  const openJournalDate = activePage ? journalDateOf(activePage.title) : null;
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
  // History drives this one, and a step it replays can land on any page: the
  // feed is a place, not a property of the page, so being sent somewhere by
  // Undo leaves it. The direct callers below clear the flag themselves, which
  // is what lets `openJournals` set it after calling one of them.
  applyNavigationRef.current = (location) => {
    setFeedOpen(false);
    return applyNavigation(location);
  };
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
  // Coming out of a zoom leaves the caret where the reader put it; going in
  // places it, since the rows the reader was looking at are gone from the pane.
  const zoomEntry = useCallback((nodeId: string | null) => {
    if (!nodeId) return null;
    const snapshot = store.getSnapshot();
    return zoomEntryFocus(nodeId, snapshot.nodes, snapshot.drafts);
  }, [store]);
  const updatePrimaryZoom = useCallback((nodeId: string | null) => {
    if (nodeId === primaryZoomRootId) return;
    const before = captureNavigation();
    afterDraftFlush(() => {
      const focus = zoomEntry(nodeId);
      setPrimaryZoomRootId(nodeId);
      setPrimaryRestore({
        epoch: ++restoreEpoch.current, selectedIds: [], focus
      });
      recordNavigation(before, {
        ...before,
        primaryZoomRootId: nodeId,
        primarySelectedIds: [],
        primaryFocus: focus
      });
    });
  }, [
    afterDraftFlush,
    captureNavigation,
    primaryZoomRootId,
    recordNavigation,
    zoomEntry
  ]);
  const openPage = useCallback(async (pageId: string) => {
    // Asking for a page is asking to read it, so the settings screen goes --
    // including when the page asked for is the one already open, which is the
    // way back to where the reader came from.
    setSettingsOpen(false);
    setFeedOpen(false);
    setDateMenu(null);
    if (pageId === store.getSnapshot().activePageId) return;
    await store.flushAllDrafts();
    const before = captureNavigation();
    await store.openPage(pageId);
    const after = emptyPaneLocation(pageId);
    await applyNavigation(after);
    recordNavigation(before, after);
  }, [applyNavigation, captureNavigation, recordNavigation, store]);
  // A row in the attachment list names a bullet on a page. Following it leaves
  // the settings screen — what the user asked to see is the note, not the file
  // — and lands on the bullet itself, selected, rather than at the top of a
  // page they then have to search.
  const openAttachment = useCallback(
    (pageId: string, nodeId: string) => {
      setSettingsOpen(false);
      const before = captureNavigation();
      afterDraftFlush(() => {
        void openPage(pageId).then(async () => {
          const after = {
            ...emptyPaneLocation(pageId),
            primarySelectedIds: nodeId ? [nodeId] : []
          };
          await applyNavigation(after);
          recordNavigation(before, after);
        });
      });
    },
    [afterDraftFlush, applyNavigation, captureNavigation, openPage, recordNavigation]
  );
  // Home is the root page like any other page, house crumb included.
  const openHome = useCallback(() => void openPage(ROOT_ID), [openPage]);
  // What the All row does, wherever it is asked for: Home, and the library
  // back to the view that lists the pages, since that is the list All heads.
  const openAllPages = useCallback(() => {
    setSettingsOpen(false);
    setLibraryView("all");
    setQuery("");
    // A zoom is what stands between the reader and the page list when home is
    // already the open page, and `openPage` returns early on the page it is
    // already on. Elsewhere the page opening clears the zoom itself, and
    // clearing it here would record a second move for nothing.
    if (store.getSnapshot().activePageId === ROOT_ID) updatePrimaryZoom(null);
    openHome();
  }, [openHome, store, updatePrimaryZoom]);
  /**
   * The page at one place in the sidebar's list, by its number. The list is
   * the store's page order, which is the order the sidebar draws -- a filter
   * or a search hides rows without renumbering the pages behind them.
   */
  const openPageAt = useCallback((place: number) => {
    const page = pageRows[place];
    if (!page) return;
    setSettingsOpen(false);
    // The number names a place in the list, so the list has to be the one the
    // reader lands looking at: a filtered view or a search hides those rows.
    setLibraryView("all");
    setQuery("");
    void openPage(page.id);
  }, [openPage, pageRows]);
  /**
   * Leaving the settings screen puts the reader back where they came from --
   * the page, the zoom, the band and the caret they left. Two things take
   * that away: a page that is gone (the data deleted or rebuilt from the
   * vault while the screen was up) and a page opened from the sidebar while
   * the screen was up, which is a newer answer to where they mean to land.
   */
  const closeSettings = useCallback(() => {
    const back = settingsReturn.current;
    settingsReturn.current = null;
    const openPageId = store.getSnapshot().activePageId;
    // A page nobody has written in yet has no row in the list, which is not
    // the same as having nowhere to go back to.
    const live = openPageId !== null && (openPageId === ROOT_ID ||
      openPageId === state.provisionalPageId ||
      state.pages.some((page) => page.id === openPageId));
    if (!live) {
      openAllPages();
      return;
    }
    setSettingsOpen(false);
    if (back?.pageId === openPageId) void applyNavigation(back);
  }, [applyNavigation, openAllPages, state.pages, state.provisionalPageId, store]);
  /**
   * Pointer-down rather than the click: the click lands after focus has left
   * the outline, and the caret is half of what there is to come back to.
   */
  const rememberSettingsReturn = useCallback(() => {
    settingsReturn.current = captureNavigation();
  }, [captureNavigation]);
  // Opening a new page writes nothing, so this is a move and only a move: the
  // caret goes to the empty title, and Undo brings the view back the way any
  // other navigation does. Trashing a page, below, is the one that replays a
  // command as well.
  const createPage = useCallback(() => {
    const before = captureNavigation();
    afterDraftFlush(() => {
      void store.createPage().then(async (pageId) => {
        const after = {
          ...emptyPaneLocation(pageId),
          primaryFocus: {
            nodeId: pageId,
            field: "title",
            selectionStart: 0,
            selectionEnd: 0
          } satisfies PaneFocusSnapshot
        };
        await applyNavigation(after);
        recordNavigation(before, after);
      });
    });
  }, [
    afterDraftFlush,
    applyNavigation,
    captureNavigation,
    recordNavigation,
    store
  ]);
  /**
   * The page a day is written on, opened. A day that has no page yet opens as
   * a page nobody has written in -- the same provisional page a New page click
   * opens, except that this one already knows what it is called.
   */
  const openJournalDay = useCallback((date: string) => {
    setSettingsOpen(false);
    setFeedOpen(false);
    setDateMenu(null);
    setLibraryView("all");
    setQuery("");
    // The day already open is not a move, and recording one would put a step on
    // the undo stack that takes the caret away and puts nothing back. Read off
    // the open page's own title rather than the page list: a day nobody has
    // written in has no row in that list, and pressing it twice would mint a
    // second page for the same day.
    if (openJournalDate === date) return;
    const before = captureNavigation();
    afterDraftFlush(() => {
      void store.openJournal(date).then(async (pageId) => {
        const after = emptyPaneLocation(pageId);
        await applyNavigation(after);
        recordNavigation(before, after);
      });
    });
  }, [
    afterDraftFlush,
    applyNavigation,
    captureNavigation,
    openJournalDate,
    recordNavigation,
    store
  ]);
  /**
   * Today, with somewhere to type. The sidebar's Today only opens the day --
   * looking at it should leave nothing behind -- but the chord is asked for by
   * someone who has something to write, so it ends on a row: the empty one the
   * day already ends with, or a new one after the last.
   */
  const openTodayToWrite = useCallback(() => {
    setSettingsOpen(false);
    setFeedOpen(false);
    setDateMenu(null);
    setLibraryView("all");
    setQuery("");
    const before = captureNavigation();
    afterDraftFlush(() => {
      void store.openJournal(localDateIso()).then(async (pageId) => {
        const snapshot = store.getSnapshot();
        const rows = snapshot.nodes.filter(
          (node) => node.parentId === pageId && !node.deleted
        );
        const last = rows.at(-1);
        const spare = last &&
          ((snapshot.drafts[last.id] ?? last.text).trim().length === 0)
          ? last
          : null;
        const nodeId = spare ? spare.id : await store.createNode(pageId);
        const after = {
          ...emptyPaneLocation(pageId),
          primaryFocus: {
            nodeId,
            field: "title",
            selectionStart: 0,
            selectionEnd: 0
          } satisfies PaneFocusSnapshot
        };
        await applyNavigation(after);
        // A row was written for this trip, so Undo has a command to take back
        // as well as a view to put back.
        if (spare) recordNavigation(before, after);
        else recordMutationNavigation(before, after);
      });
    });
  }, [
    afterDraftFlush,
    applyNavigation,
    captureNavigation,
    recordMutationNavigation,
    recordNavigation,
    store
  ]);
  /**
   * Rows carried forward from earlier days. The bar works out which rows those
   * are; moving them belongs here, like every other structural write in the
   * shell, so that Undo has a view to put back as well as a command to take
   * back.
   */
  const carryRowsInto = useCallback(async (
    pageId: string,
    rowIds: readonly string[]
  ) => {
    const before = captureNavigation();
    await store.flushAllDrafts();
    await store.moveNodes(rowIds.map((id) => ({
      id,
      parentId: pageId,
      beforeId: null
    })));
    // Where the reader is does not change: the same page is open, inside the
    // same zoom, with the same split beside it. Only the rows moved, so both
    // ends of the step are the place they were already standing -- a blank
    // pane location here would close their split and drop their zoom.
    recordMutationNavigation(before, before);
  }, [captureNavigation, recordMutationNavigation, store]);
  /**
   * The feed opens on today -- the day being written -- and reads the days
   * before it underneath. `openJournalDay` clears the flag as every other way
   * of opening a page does, so it is set after, in the same handler.
   */
  const openJournals = useCallback(() => {
    openJournalDay(localDateIso());
    setFeedOpen(true);
  }, [openJournalDay]);
  /**
   * The keyboard's way in, matching what the button does with focus already on
   * it: remember where to come back to, then show the screen. Pressing it
   * again while it is up is nothing -- Escape is the way out.
   */
  const openSettings = useCallback(() => {
    if (settingsOpen) return;
    rememberSettingsReturn();
    setSettingsOpen(true);
  }, [rememberSettingsReturn, settingsOpen]);
  // The listener below is registered once. What it needs from a render it
  // reads through here, so a page opened -- or a page renamed, which rebuilds
  // the page list -- does not tear the window's shortcuts down and put them
  // back.
  const shortcuts = useRef({
    settingsOpen, closeSettings, openAllPages, openPageAt, createPage,
    openSettings, openTodayToWrite
  });
  shortcuts.current = {
    settingsOpen, closeSettings, openAllPages, openPageAt, createPage,
    openSettings, openTodayToWrite
  };
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
      // Nothing inside the settings screen answers Escape today, so this is
      // the only reader of it there. A component that grows one says so by
      // preventing the event, and the screen behind it stays where it is.
      if (
        event.key === "Escape" && shortcuts.current.settingsOpen &&
        !event.defaultPrevented
      ) {
        event.preventDefault();
        shortcuts.current.closeSettings();
        return;
      }
      const onMac = navigator.platform.includes("Mac");
      const modifier = onMac ? event.metaKey : event.ctrlKey;
      // The other primary modifier is somebody else's chord, the way the
      // inspector's shortcut reads it.
      const otherModifier = onMac ? event.ctrlKey : event.metaKey;
      // The sidebar's list, by number: zero heads it the way All does, and the
      // nine keys after it are the nine pages under All. They reach from inside
      // a row textarea like the find below, since a digit with the modifier
      // held is nothing a line of text is asking for.
      if (
        modifier && !otherModifier && !event.shiftKey && !event.altKey &&
        // A key still being composed is the input method's, not a shortcut.
        !event.isComposing && event.key.length === 1
      ) {
        if (event.key === "0") {
          event.preventDefault();
          shortcuts.current.openAllPages();
          return;
        }
        const place = "123456789".indexOf(event.key);
        if (place >= 0) {
          event.preventDefault();
          shortcuts.current.openPageAt(place);
          return;
        }
      }
      // The page's own size, in the 5% steps the numeric row's other end reads
      // in. There is no reset chord: Cmd+0 is All pages here, so the way back
      // is the same key that came out.
      const zoomStep = pageZoomStep(event);
      if (zoomStep !== 0) {
        event.preventDefault();
        void nudgePageZoom(zoomStep);
        return;
      }
      // Today answers from anywhere, Shift and all: a capital J with the
      // modifier held is nothing a line of text is asking for either.
      if (
        modifier && !otherModifier && event.shiftKey &&
        event.key.toLowerCase() === "j"
      ) {
        event.preventDefault();
        shortcuts.current.openTodayToWrite();
        return;
      }
      // A new page and the settings screen answer from anywhere too: neither
      // chord is something a line of text is asking for.
      if (modifier && !otherModifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        shortcuts.current.createPage();
        return;
      }
      if (modifier && !otherModifier && event.key === ",") {
        event.preventDefault();
        shortcuts.current.openSettings();
        return;
      }
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
  const openSplit = useCallback((nodeId: string) => {
    const before = captureNavigation();
    afterDraftFlush(() => {
      const focus = zoomEntry(nodeId);
      setSplitOpen(true);
      setSecondaryZoomRootId(nodeId);
      setSecondaryRestore({
        epoch: ++restoreEpoch.current, selectedIds: [], focus
      });
      recordNavigation(before, {
        ...before,
        splitOpen: true,
        secondaryZoomRootId: nodeId,
        secondarySelectedIds: [],
        secondaryFocus: focus
      });
    });
  }, [afterDraftFlush, captureNavigation, recordNavigation, zoomEntry]);
  const updateSecondaryZoom = useCallback((nodeId: string | null) => {
    if (nodeId === secondaryZoomRootId) return;
    const before = captureNavigation();
    afterDraftFlush(() => {
      const focus = zoomEntry(nodeId);
      setSecondaryZoomRootId(nodeId);
      setSecondaryRestore({
        epoch: ++restoreEpoch.current, selectedIds: [], focus
      });
      recordNavigation(before, {
        ...before,
        secondaryZoomRootId: nodeId,
        secondarySelectedIds: [],
        secondaryFocus: focus
      });
    });
  }, [
    afterDraftFlush,
    captureNavigation,
    recordNavigation,
    secondaryZoomRootId,
    zoomEntry
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
  // Identity has to hold across renders: the panes are memoized, and a fresh
  // callback would re-run the effect that reports through it.
  const reportSelectionCount = useCallback(
    (paneId: "primary" | "secondary", count: number) =>
      setPaneSelections((current) => current[paneId] === count
        ? current
        : { ...current, [paneId]: count }),
    []
  );
  const selectedCount = paneSelections.primary + paneSelections.secondary;
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
  // Under the token it was pressed on, which is where the reader is looking.
  const handleDateClick = useCallback((date: string, anchor: DOMRect) => {
    setDateMenu({ date, top: anchor.bottom + 6, left: anchor.left });
  }, []);
  const showLinkedRows = useCallback((date: string) => {
    setSearchOpen(true);
    setQuery(`date:${date}`);
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
                data-tooltip="Search"
                data-tooltip-align="left"
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
                aria-keyshortcuts="Meta+N Control+N"
                data-tooltip="New page"
                data-tooltip-align="left"
                onClick={createPage}
              >
                <Plus size={16} aria-hidden="true" />
                <span>New page</span>
                <ShortcutHint mac="⌘N" other="Ctrl+N" />
              </button>
            </div>
            <section
              className="notes-navigation-section notes-navigation-journals"
              aria-labelledby="journals-title"
            >
              <h2 id="journals-title" className="eyebrow">Journals</h2>
              <div className="notes-library-list">
                <div
                  className="notes-library-page-row"
                  data-active={openJournalDate === localDateIso()
                    ? "true"
                    : undefined}
                >
                  <button
                    className="notes-library-page"
                    type="button"
                    aria-current={openJournalDate === localDateIso()
                      ? "page"
                      : undefined}
                    aria-keyshortcuts="Meta+Shift+J Control+Shift+J"
                    onClick={() => openJournalDay(localDateIso())}
                  >
                    <CalendarDays size={16} aria-hidden="true" />
                    <span>Today</span>
                    <ShortcutHint mac="⌘⇧J" other="Ctrl+Shift+J" />
                  </button>
                </div>
                <div
                  className="notes-library-page-row"
                  data-active={feedOpen ? "true" : undefined}
                >
                  <button
                    className="notes-library-page"
                    type="button"
                    aria-current={feedOpen ? "page" : undefined}
                    onClick={openJournals}
                  >
                    <NotebookText size={16} aria-hidden="true" />
                    <span>Journals</span>
                  </button>
                </div>
              </div>
              <Suspense
                fallback={<div className="notes-journal-calendar-placeholder" />}
              >
                <JournalCalendar
                  days={allJournalDays}
                  today={localDateIso()}
                  openDate={openJournalDate}
                  onOpenDay={openJournalDay}
                />
              </Suspense>
            </section>
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
                  data-active={atAllPages ? "true" : undefined}
                >
                  <button
                    className="notes-library-page"
                    type="button"
                    aria-current={atAllPages ? "page" : undefined}
                    aria-keyshortcuts="Meta+0 Control+0"
                    onClick={openAllPages}
                  >
                    <House size={16} aria-hidden="true" />
                    <span>All</span>
                    <ShortcutHint mac="⌘0" other="Ctrl+0" />
                  </button>
                </div>
                {pageRowsListed &&
                  pageRows.map((page, place) => (
                    <LibraryPageRow
                      key={page.id}
                      page={page}
                      place={place < 9 ? place + 1 : undefined}
                      active={page.id === currentPageId}
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
        <Suspense fallback={null}>
          <SyncStatusBadge readStatus={() => api.syncStatus()} />
        </Suspense>
        <footer className="yonalist-navigation-footer">
          <button
            className="nav-item"
            type="button"
            aria-pressed={settingsOpen}
            aria-keyshortcuts="Meta+Comma Control+Comma"
            data-tooltip="Settings"
            data-tooltip-align="left"
            onPointerDown={() => {
              if (!settingsOpen) rememberSettingsReturn();
            }}
            onClick={(event) => {
              if (settingsOpen) closeSettings();
              else {
                // `detail` counts the clicks a pointer made, so zero is the
                // keyboard: focus was already on this button and no pointer
                // down ran ahead of it to remember anything.
                if (event.detail === 0) rememberSettingsReturn();
                setSettingsOpen(true);
              }
            }}
          >
            <Settings size={16} aria-hidden="true" />
            <span>Settings</span>
            <ShortcutHint mac="⌘," other="Ctrl+," />
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
            isFirstRun={isFirstRun}
            setVaultPath={chooseVaultPath}
            writeGuide={writeGuide}
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
            handwritingFace={theme.handwritingFace}
            markerStyles={markers.markerStyles}
            onThemeModeChange={theme.setMode}
            onLightThemeChange={theme.setLightTheme}
            onDarkThemeChange={theme.setDarkTheme}
            onCaretColorChange={theme.setCaretColor}
            onTextFontChange={theme.setTextFont}
            onHandwritingFaceChange={theme.setHandwritingFace}
            onMarkerStylesChange={markers.setMarkerStyles}
            onClose={closeSettings}
            unusedAssets={(purge) => api.unusedAssets(purge)}
            deleteAllData={() => api.deleteAllData()}
            rebuildFromVault={rebuildFromVault}
            readVaultPath={readVaultPath}
            setVaultPath={setVaultPath}
            readConflicts={readConflicts}
            restoreConflict={restoreConflict}
            forgetConflict={forgetConflict}
            readAttachments={(limit) => api.syncAttachments(limit)}
            deleteAttachment={(contentHash) => api.syncDeleteAttachment(contentHash)}
            openNode={openAttachment}
          />
        </Suspense>
      ) : feedOpen && openJournalDate ? (
        <Suspense fallback={<p className="notes-pane-state">Loading...</p>}>
          <JournalFeed
          store={store}
          status={state.status}
          error={state.error}
          pendingWrites={state.pendingWrites}
          page={activePage}
          zoomRootId={primaryZoomRootId}
          restoreRequest={primaryRestore}
          days={feedDays}
          onZoomRootChange={updatePrimaryZoom}
          onHome={openHome}
          onTagClick={handleTagClick}
          onDateClick={handleDateClick}
          onOpenPage={(pageId) => void openPage(pageId)}
          onOpenDay={openJournalDay}
          onCarryRows={carryRowsInto}
          today={localDateIso()}
          onSelectionCountChange={reportSelectionCount}
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
          onDateClick={handleDateClick}
          onOpenPage={(pageId) => void openPage(pageId)}
          onOpenDay={openJournalDay}
          onCarryRows={carryRowsInto}
          today={localDateIso()}
          onSelectionCountChange={reportSelectionCount}
        />
      )}
      {dateMenu && !settingsOpen && (
        <Suspense fallback={null}>
          <JournalDateMenu
            target={dateMenu}
            onOpenDay={openJournalDay}
            onShowLinkedRows={showLinkedRows}
            onClose={() => setDateMenu(null)}
          />
        </Suspense>
      )}
      <footer className="app-statusbar" aria-label="Status bar">
        <div className="statusbar-feedback">
          {/* Errors only. A write settles on its own in a few hundred
              milliseconds, so a Saving... here just flickered; the controls
              that actually have to wait carry their own aria-busy. */}
          {state.error && <span className="statusbar-message" data-kind="error">{state.error}</span>}
        </div>
        {/* The count is state the band holds for as long as it lives, which is
            what the group at this end is for -- in the message slot it would
            have had to take turns with messages that come and go. */}
        <div className="statusbar-actions">
          {selectedCount > 0 && (
            <span className="statusbar-selection">{selectedCount} selected</span>
          )}
          <div className="statusbar-zoom-control" role="group" aria-label="Page zoom">
            <button
              className="statusbar-zoom-btn"
              type="button"
              aria-label="Zoom out"
              data-tooltip="Zoom out"
              data-tooltip-align="right"
              disabled={pageZoom <= MIN_ZOOM_PERCENT}
              onClick={() => void nudgePageZoom(-STEP)}
            >
              <Minus size={12} aria-hidden="true" />
            </button>
            <button
              className="statusbar-zoom-label"
              type="button"
              aria-label={`Zoom level ${pageZoom}%. ${pageZoom !== 100 ? "Click to reset to 100%" : ""}`.trim()}
              data-tooltip={pageZoom !== 100 ? "Reset zoom to 100%" : undefined}
              data-tooltip-align="right"
              disabled={pageZoom === 100}
              onClick={() => void resetPageZoom()}
            >
              {pageZoom}%
            </button>
            <button
              className="statusbar-zoom-btn"
              type="button"
              aria-label="Zoom in"
              data-tooltip="Zoom in"
              data-tooltip-align="right"
              disabled={pageZoom >= MAX_ZOOM_PERCENT}
              onClick={() => void nudgePageZoom(STEP)}
            >
              <Plus size={12} aria-hidden="true" />
            </button>
          </div>
          <span className="statusbar-state">Online</span>
        </div>
      </footer>
    </main>
  );
}
