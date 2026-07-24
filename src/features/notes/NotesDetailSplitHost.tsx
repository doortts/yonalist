import { Columns2, PanelRightClose } from "lucide-react";
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  Profiler,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";
import { VaultRootContext } from "../../VaultRootContext";
import { IconTooltip } from "../../components/ui/Tooltip";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesPaneScope } from "./NotesPaneScope";
import { NotesSplitDndContext } from "./NotesSplitDndContext";
import {
  useNotesActions,
  useNotesPaneRegistry,
  useNotesState
} from "./NotesWorkspaceContext";
import {
  loadNotesSplitLayout,
  reconcilePersistedSplitLayout,
  saveNotesSplitLayout,
  type NotesSplitLayoutStateV1
} from "./notesSplitLayoutStore";
import { markNotesSplitInputBenchmarkPaneCommit } from "./notesSplitLatencyProbe";

const RATIO_STEP = 0.02;
const PRIMARY_EDITOR_SELECTOR = [
  "textarea.notes-page-title:not(:disabled):not([readonly])",
  "textarea.notes-page-note:not(:disabled):not([readonly])",
  "textarea.notes-node-title:not(:disabled):not([readonly])",
  "textarea.notes-node-note:not(:disabled):not([readonly])",
  ".notes-image-atom-editor[contenteditable='true']"
].join(",");

function boundedRatio(value: number): number {
  return Math.min(0.75, Math.max(0.25, value));
}

export function NotesDetailSplitHost() {
  const vaultRoot = useContext(VaultRootContext);
  const { actions } = useNotesActions();
  const { state } = useNotesState();
  const registry = useNotesPaneRegistry();
  const splitOpenButtonRef = useRef<HTMLButtonElement>(null);
  const primaryPaneRef = useRef<HTMLDivElement>(null);
  const lastPrimaryEditorRef = useRef<HTMLElement | null>(null);
  const hydratedVaultRef = useRef<string | null>(null);
  const [layout, setLayout] = useState<NotesSplitLayoutStateV1>(() =>
    loadNotesSplitLayout(localStorage, vaultRoot)
  );

  useEffect(() => {
    const restored = loadNotesSplitLayout(localStorage, vaultRoot);
    hydratedVaultRef.current = null;
    setLayout(restored);
  }, [vaultRoot]);

  useEffect(() => {
    if (state.status !== "ready" || hydratedVaultRef.current === vaultRoot) {
      return;
    }
    const restored = reconcilePersistedSplitLayout(layout, state);
    hydratedVaultRef.current = vaultRoot;
    setLayout(restored);
    const secondary = restored.panes.secondary;
    registry.dispatchPane("secondary", {
      type: "setNavigation",
      patch: {
        zoomRootId: secondary.zoomRootId,
        selectedId: secondary.zoomRootId,
        editingNoteId: null,
        pendingFocusId: null,
        pendingFocusField: null
      }
    });
    registry.dispatchPane("secondary", {
      type: "setExpansion",
      nodeIds: new Set(secondary.expandedNodeIds)
    });
    registry.dispatchPane("secondary", {
      type: "setScroll",
      anchorId: secondary.scrollAnchorId,
      offset: secondary.scrollOffset
    });
    if (
      restored.panes.primary.zoomRootId !== null &&
      restored.panes.primary.zoomRootId !== state.zoomRootId
    ) {
      void registry.panes.primary.actionsSlice.actions.zoomTo(
        restored.panes.primary.zoomRootId
      );
    }
  }, [layout, registry, state, vaultRoot]);

  useEffect(() => {
    if (state.status !== "ready" || hydratedVaultRef.current !== vaultRoot) {
      return;
    }
    const primary = registry.getPaneSession("primary");
    const secondary = registry.getPaneSession("secondary");
    saveNotesSplitLayout(localStorage, vaultRoot, {
      ...layout,
      activePaneId: registry.activePaneId,
      panes: {
        primary: {
          zoomRootId: primary.zoomRootId,
          expandedNodeIds: [...primary.locallyExpandedNodeIds],
          scrollAnchorId: primary.scrollAnchorId,
          scrollOffset: primary.scrollOffset
        },
        secondary: {
          zoomRootId: secondary.zoomRootId,
          expandedNodeIds: [...secondary.locallyExpandedNodeIds],
          scrollAnchorId: secondary.scrollAnchorId,
          scrollOffset: secondary.scrollOffset
        }
      }
    });
  }, [
    layout,
    registry,
    registry.activePaneId,
    registry.panes.primary.stateSlice.state.zoomRootId,
    registry.panes.secondary.stateSlice.state.zoomRootId,
    state.status,
    vaultRoot
  ]);

  const rememberPrimaryEditor = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(PRIMARY_EDITOR_SELECTOR)
      ) {
        lastPrimaryEditorRef.current = event.target;
      }
    },
    []
  );

  const focusPrimaryEditor = useCallback(() => {
    const remembered = lastPrimaryEditorRef.current;
    if (remembered?.isConnected && remembered.matches(PRIMARY_EDITOR_SELECTOR)) {
      remembered.focus();
      return;
    }
    const fallback = primaryPaneRef.current?.querySelector<HTMLElement>(
      [
        "textarea.notes-page-title:not(:disabled):not([readonly])",
        "textarea.notes-node-title:not(:disabled):not([readonly])"
      ].join(",")
    );
    (fallback ?? splitOpenButtonRef.current)?.focus();
  }, []);

  const openSplit = useCallback(() => {
    setLayout((current) => ({ ...current, splitOpen: true }));
  }, []);

  const closeSplit = useCallback(async () => {
    if (!(await actions.flushAllDrafts())) return;
    registry.panes.secondary.actionsSlice.actions.releaseEditingFocus?.();
    if (registry.activePaneId === "secondary") {
      registry.setActivePaneId("primary");
    }
    setLayout((current) => ({ ...current, splitOpen: false }));
    requestAnimationFrame(() => focusPrimaryEditor());
  }, [actions, focusPrimaryEditor, registry]);

  const changeRatio = useCallback((delta: number) => {
    setLayout((current) => ({
      ...current,
      splitRatio: boundedRatio(current.splitRatio + delta)
    }));
  }, []);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const host = event.currentTarget.parentElement;
      if (!host) return;
      const resize = (moveEvent: PointerEvent) => {
        const rect = host.getBoundingClientRect();
        if (rect.width <= 0) return;
        setLayout((current) => ({
          ...current,
          splitRatio: boundedRatio(
            (moveEvent.clientX - rect.left) / rect.width
          )
        }));
      };
      const finish = () => {
        window.removeEventListener("pointermove", resize);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };
      window.addEventListener("pointermove", resize);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    []
  );

  const splitOpenControl = !layout.splitOpen ? (
    <IconTooltip label="Open split view" side="bottom">
      <button
        ref={splitOpenButtonRef}
        className="notes-export-trigger notes-split-toggle"
        type="button"
        aria-label="Open split view"
        onClick={openSplit}
      >
        <Columns2 size={16} aria-hidden="true" />
      </button>
    </IconTooltip>
  ) : undefined;

  const splitCloseControl = layout.splitOpen ? (
    <IconTooltip label="Close split view" side="bottom">
      <button
        className="notes-export-trigger notes-split-toggle"
        type="button"
        aria-label="Close split view"
        onClick={() => void closeSplit()}
      >
        <PanelRightClose size={16} aria-hidden="true" />
      </button>
    </IconTooltip>
  ) : undefined;

  return (
    <NotesSplitDndContext>
      <div
        className="notes-detail-split"
        data-split-open={layout.splitOpen ? "true" : undefined}
        style={
          {
            "--notes-split-primary": `${layout.splitRatio * 100}%`
          } as CSSProperties
        }
      >
      <div
        ref={primaryPaneRef}
        className="notes-detail-pane"
        data-notes-pane-id="primary"
        onFocusCapture={rememberPrimaryEditor}
        onPointerDownCapture={() => registry.setActivePaneId("primary")}
      >
        <Profiler id="notes-benchmark-primary" onRender={() => markNotesSplitInputBenchmarkPaneCommit("primary")}>
          <NotesPaneScope paneId="primary">
            <NotesOutlinePane toolbarTrailing={splitOpenControl} />
          </NotesPaneScope>
        </Profiler>
      </div>
      {layout.splitOpen && (
        <div
          className="notes-split-divider"
          role="separator"
          aria-label="Resize split view"
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(layout.splitRatio * 100)}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              changeRatio(-RATIO_STEP);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              changeRatio(RATIO_STEP);
            }
          }}
        />
      )}
      {layout.splitOpen && (
        <div
          className="notes-detail-pane"
          data-notes-pane-id="secondary"
          onPointerDownCapture={() => registry.setActivePaneId("secondary")}
        >
          <Profiler id="notes-benchmark-secondary" onRender={() => markNotesSplitInputBenchmarkPaneCommit("secondary")}>
            <NotesPaneScope paneId="secondary">
              <NotesOutlinePane toolbarTrailing={splitCloseControl} />
            </NotesPaneScope>
          </Profiler>
        </div>
      )}
      </div>
    </NotesSplitDndContext>
  );
}
