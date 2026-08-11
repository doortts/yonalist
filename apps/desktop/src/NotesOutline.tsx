import {
  lazy, Suspense, useEffect, useMemo, useRef, useState,
  useSyncExternalStore
} from "react";
import { NotesStore } from "./notesStore";
import type { NotesShellSnapshot } from "./storeSubscriptions";
import {
  hideCollapsedSubtrees, hideCompletedSubtrees
} from "./outlineVisibility";
import { useOutlineSelection } from "./useOutlineSelection";
import { useOutlinePointerSelection } from "./useOutlinePointerSelection";
import { useOutlineDrag } from "./useOutlineDrag";
import { OutlineHeader, OutlinePageHeading } from "./OutlineHeader";
import { OutlineRow, OutlineRowRuntime } from "./OutlineRow";
import { NotesChildComposer } from "./NotesChildComposer";
import { buildTodoProgressMap } from "./outlineTodo";
import type { OutlineTagToken } from "./OutlineTextField";
import type { SelectionMovePlan } from "./selectionMoves";
import { OutlineIndex } from "./outlineIndex";
import type { PaneFocusSnapshot } from "./appNavigation";
import { useImageIngest } from "./useImageIngest";
import { NotesExportBoundary } from "./NotesExportBoundary";
import { useOutlineWindow } from "./useOutlineWindow";
import { registerOutlinePane } from "./outlinePaneRegistry";
import { ROOT_ID } from "./storeSupport";

const OutlineSelectionActionBar = lazy(() =>
  import("./OutlineSelectionActionBar").then((module) => ({
    default: module.OutlineSelectionActionBar
  })));
const OutlineDragVisuals = lazy(() =>
  import("./OutlineDragVisuals").then((module) => ({
    default: module.OutlineDragVisuals
  })));

type SelectionPlanner = typeof import("./selectionMoves");

export interface PaneRestoreRequest {
  readonly epoch: number;
  readonly selectedIds: readonly string[];
  readonly focus: PaneFocusSnapshot | null;
}

export function NotesOutline({
  store, status, error, pendingWrites, page, zoomRootId, onZoomRootChange,
  onHome, onOpenSplit, onTagClick, onClose, paneId, restoreRequest
}: {
  readonly store: NotesStore;
  readonly status: NotesShellSnapshot["status"];
  readonly error: string | null;
  readonly pendingWrites: number;
  readonly page: { id: string; title: string } | undefined;
  readonly zoomRootId: string | null;
  readonly onZoomRootChange: (nodeId: string | null) => void;
  readonly onHome: () => void;
  readonly onOpenSplit?: (nodeId: string) => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onClose?: () => void;
  readonly paneId: "primary" | "secondary";
  readonly restoreRequest: PaneRestoreRequest | null;
}) {
  const state = useSyncExternalStore(
    store.subscribeOutline,
    store.getOutlineSnapshot,
    store.getOutlineSnapshot
  );
  const scopeRef = useRef<HTMLElement>(null);
  const [rowRuntime] = useState(() => new OutlineRowRuntime());
  const [showCompleted, setShowCompleted] = useState(true);
  const [selectionFeedback, setSelectionFeedback] = useState("");
  const selectionOperation = useRef(false);
  const [selectionOperationBusy, setSelectionOperationBusy] = useState(false);
  const index = useMemo(() => new OutlineIndex(state.nodes), [state.nodes]);
  const zoomRoot = zoomRootId
    ? index.node(zoomRootId)
    : undefined;
  const allBodyNodes = useMemo(
    () => zoomRoot
      ? state.nodes.filter((node) =>
          node.id !== zoomRoot.id && index.isDescendant(node.id, zoomRoot.id)
        )
      : state.nodes,
    [index, state.nodes, zoomRoot]
  );
  const outlineRootId = zoomRoot?.id ?? page?.id ?? "";
  const imageIngest = useImageIngest({
    store,
    outlineRootId,
    index,
    scopeRef
  });
  const expandedBodyNodes = useMemo(
    () => hideCollapsedSubtrees(allBodyNodes, outlineRootId, index),
    [allBodyNodes, index, outlineRootId]
  );
  const bodyNodes = useMemo(
    () => showCompleted
      ? expandedBodyNodes
      : hideCompletedSubtrees(expandedBodyNodes, outlineRootId, index),
    [expandedBodyNodes, index, outlineRootId, showCompleted]
  );
  const visibleIndex = useMemo(() => new OutlineIndex(bodyNodes), [bodyNodes]);
  const outlineWindow = useOutlineWindow(bodyNodes);
  const reveal = outlineWindow.reveal;
  useEffect(() => {
    if (scopeRef.current) {
      registerOutlinePane(scopeRef.current, { visibleNodes: bodyNodes, reveal });
    }
  }, [bodyNodes, reveal]);
  const structuralContextComplete =
    state.beforeCursor === null && state.afterCursor === null;
  const selection = useOutlineSelection(
    bodyNodes, state.nodes, store,
    `${page?.id ?? ""}:${zoomRootId ?? ""}`,
    structuralContextComplete,
    state.revision);
  const restoreSelectionRef = useRef(selection.replace);
  restoreSelectionRef.current = selection.replace;
  const {
    materializeForest,
    rootKey,
    selectedRootIds
  } = selection;
  useEffect(() => {
    if (!restoreRequest) return;
    restoreSelectionRef.current(restoreRequest.selectedIds);
    if (restoreRequest.focus) reveal(restoreRequest.focus.nodeId);
    const frame = requestAnimationFrame(() => {
      if (!restoreRequest.focus || !scopeRef.current) return;
      const editor = [...scopeRef.current.querySelectorAll<
        HTMLTextAreaElement
      >("textarea[data-node-id][data-outline-field]")].find((candidate) =>
        candidate.dataset.nodeId === restoreRequest.focus?.nodeId &&
        candidate.dataset.outlineField === restoreRequest.focus?.field
      );
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(
        restoreRequest.focus.selectionStart,
        restoreRequest.focus.selectionEnd
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [restoreRequest, reveal]);
  useEffect(() => {
    if (!rootKey) return;
    let active = true;
    const rootIds = [...selectedRootIds];
    void store.queryForest(rootIds).then((forest) => {
      if (!active || forest.revision !== store.getSnapshot().revision) return;
      materializeForest(
        rootIds, forest.nodes, forest.complete, forest.revision);
    }).catch(() => {
      if (active) setSelectionFeedback(
        "The complete selection could not be loaded safely."
      );
    });
    return () => {
      active = false;
    };
  }, [
    materializeForest,
    rootKey,
    selectedRootIds,
    state.revision,
    store
  ]);
  const pointerSelection = useOutlinePointerSelection(selection, bodyNodes);
  const outlineDrag = useOutlineDrag({
    enabled: structuralContextComplete &&
      (selection.selectedIds.length === 0 || selection.forestComplete),
    nodes: state.nodes, visibleNodes: bodyNodes, outlineRootId, selection,
    moveNodes: (moves) => store.moveNodes(moves),
    labelForId: (id) => store.getNodeSnapshot(id).title
  });
  // Move planning only matters once rows are selected, so it stays out of the
  // editable first-paint bundle and is fetched as soon as the pane is up.
  const [planner, setPlanner] = useState<SelectionPlanner | null>(null);
  useEffect(() => {
    void import("./selectionMoves").then(setPlanner);
  }, []);
  const allSelectedCompleted = planner !== null && planner.selectedCompletion(
    selection.selectedNodes,
    selection.selectedIds
  );
  const movePlans = planner && structuralContextComplete
    ? planner.buildSelectionMovePlans(
      state.nodes,
      // With nothing selected the planner short-circuits, so the id list it
      // would read is not worth building on every keystroke.
      selection.selectedRootIds.length === 0
        ? []
        : bodyNodes.map((node) => node.id),
      selection.selectedRootIds,
      outlineRootId
    )
    : {
      indent: { available: false, reason: "Load the complete outline first." },
      outdent: { available: false, reason: "Load the complete outline first." },
      up: { available: false, reason: "Load the complete outline first." },
      down: { available: false, reason: "Load the complete outline first." },
      duplicate: { available: false, reason: "Load the complete outline first." }
    } as const;
  const runSelectionAction = (
    action: () => Promise<unknown> | unknown
  ) => {
    if (selectionOperation.current) return;
    if (!selection.forestComplete) {
      setSelectionFeedback("The complete selection is not available yet.");
      return;
    }
    selectionOperation.current = true;
    setSelectionOperationBusy(true);
    void Promise.resolve().then(action).finally(() => {
      selectionOperation.current = false;
      setSelectionOperationBusy(false);
    });
  };
  const executeMovePlan = (plan: SelectionMovePlan) => {
    if (plan.available) runSelectionAction(() => store.moveNodes(plan.moves));
  };
  const clearSelection = () => {
    selection.clear();
    setSelectionFeedback("");
  };
  const deleteSelection = async () => {
    await store.deleteSubtrees(selection.selectedRootIds);
    clearSelection();
  };
  const copySelection = async () => {
    try {
      await selection.copyToSystem();
      setSelectionFeedback("Copied selected outline.");
    } catch {
      setSelectionFeedback("Could not write the selected outline to the clipboard.");
    }
  };
  const cutSelection = async () => {
    if (!selection.canCut) return;
    try {
      await selection.copyToSystem();
    } catch {
      setSelectionFeedback("Could not write the selected outline to the clipboard.");
      return;
    }
    try {
      await deleteSelection();
      setSelectionFeedback("Cut selected outline.");
    } catch {
      setSelectionFeedback("Copied, but couldn't remove the selected outline.");
    }
  };
  const duplicateSelection = async () => {
    const plan = movePlans.duplicate;
    if (!plan.available) return;
    selection.replace(await store.duplicateNodes(
      selection.selectedRootIds, plan.parentId, plan.beforeId));
  };
  const todoProgress = useMemo(
    () => buildTodoProgressMap(state.nodes),
    [state.nodes]
  );
  const selectedIds = useMemo(
    () => new Set(selection.selectedIds),
    [selection.selectedIds]
  );
  if (status === "loading" && !page) {
    return <section className="notes-outline"><p className="notes-pane-state">Loading notes...</p></section>;
  }
  if (!page) {
    return <section className="notes-outline"><p className="notes-pane-state">No outline yet.</p></section>;
  }
  rowRuntime.state = {
    visibleNodes: bodyNodes,
    index,
    visibleIndex,
    pageId: zoomRoot?.id ?? page.id,
    selectionHeadId: selection.headId,
    hasSelection: selection.selectedIds.length > 0,
    selectionRootIds: selection.selectedRootIds,
    selectionPlans: movePlans,
    allSelectedCompleted,
    selectionCutRefusal: selection.cutRefusal,
    forestComplete: selection.forestComplete,
    onZoom: (nodeId, split) => {
      if (split && onOpenSplit) onOpenSplit(nodeId);
      else onZoomRootChange(nodeId);
    },
    onZoomOut: () => onZoomRootChange(null),
    onExtendSelection: selection.extend,
    onClearSelection: clearSelection,
    onTagClick,
    onPickImage: (nodeId) => void imageIngest.openPicker(nodeId),
    selectionActions: {
      indent: () => executeMovePlan(movePlans.indent),
      outdent: () => executeMovePlan(movePlans.outdent),
      move: (direction) => executeMovePlan(movePlans[direction]),
      toggleComplete: () => runSelectionAction(() =>
        store.setCompletedMany(
          selection.selectedIds, !allSelectedCompleted
        )),
      duplicate: () => runSelectionAction(duplicateSelection),
      delete: () => runSelectionAction(deleteSelection),
      copy: () => runSelectionAction(copySelection),
      cut: () => runSelectionAction(cutSelection)
    },
    onDragHandlePointerDown: (nodeId, event) =>
      outlineDrag.rowProps(nodeId).onDragHandlePointerDown(event),
    onDragHandleKeyDown: (nodeId, event) =>
      outlineDrag.rowProps(nodeId).onDragHandleKeyDown(event),
    consumeDragHandleClick: (nodeId) =>
      outlineDrag.rowProps(nodeId).consumeDragHandleClick()
  };
  const header = zoomRoot ?? { id: page.id, text: page.title };
  const selectedExportNode = selection.selectedIds.length === 1
    ? selection.selectedNodes[0]
    : undefined;
  const exportMenu = (
    <NotesExportBoundary
      store={store}
      currentRoot={{ id: header.id, title: header.text }}
      selectedNode={selectedExportNode
        ? { id: selectedExportNode.id, title: selectedExportNode.text }
        : null}
    />
  );
  return (
    <section
      ref={scopeRef}
      className="notes-outline"
      aria-label="Notes outline"
      data-outline-root-id={outlineRootId}
      data-outline-pane-id={paneId}
      onCopy={selection.copy}
      onCut={(event) => {
        if (selection.selectedIds.length === 0) return;
        if (selection.cutRefusal) {
          event.preventDefault();
          setSelectionFeedback(selection.cutRefusal);
          return;
        }
        if (!selection.writeToEvent(event)) {
          setSelectionFeedback("Could not write the selected outline to the clipboard.");
          return;
        }
        runSelectionAction(() => deleteSelection().catch(() => {
          setSelectionFeedback("Copied, but couldn't remove the selected outline.");
        }));
      }}
      {...imageIngest.sectionProps}
    >
      <OutlineHeader
        store={store}
        target={header}
        nodes={state.nodes}
        index={index}
        pageId={page.id}
        pageTitle={page.title}
        zoomed={zoomRoot !== undefined}
        showCompleted={showCompleted}
        error={error}
        onToggleCompleted={() => setShowCompleted((visible) => !visible)}
        onBack={() => onZoomRootChange(null)}
        onHome={onHome}
        onZoomTo={onZoomRootChange}
        onClose={onClose}
        selectionToolbar={selection.selectedIds.length > 0 ? (
          <Suspense fallback={null}>
            <OutlineSelectionActionBar
              count={selection.selectedIds.length}
              allCompleted={allSelectedCompleted}
              canCut={selection.canCut}
              busy={pendingWrites > 0 ||
                selectionOperationBusy ||
                !selection.forestComplete}
              plans={movePlans}
              onClear={clearSelection}
              onComplete={() => runSelectionAction(() =>
                store.setCompletedMany(
                  selection.selectedIds,
                  !allSelectedCompleted
                ))}
              onCopy={() => runSelectionAction(copySelection)}
              onCut={() => runSelectionAction(cutSelection)}
              onMove={executeMovePlan}
              onDuplicate={() => runSelectionAction(duplicateSelection)}
              onDelete={() => runSelectionAction(deleteSelection)}
              trailingAction={exportMenu}
            />
          </Suspense>
        ) : undefined}
        exportMenu={selection.selectedIds.length === 0
          ? exportMenu
          : undefined}
      />
      {imageIngest.error && (
        <div className="notes-inline-error" role="alert">
          {imageIngest.error}
        </div>
      )}
      {selectionFeedback && (
        <span className="notes-selection-visually-hidden" role="status">
          {selectionFeedback}
        </span>
      )}
      {outlineDrag.announcement && (
        <span className="notes-selection-visually-hidden" role="status">
          {outlineDrag.announcement}
        </span>
      )}
      <div className="notes-outline-rows" ref={outlineWindow.scrollRef}>
        <div className="notes-outline-content" data-zoomed-page="true">
          {/* Home is the root itself, and the root is nobody's title: it gets
              a heading only once a zoom gives it one. */}
          {(zoomRoot || page.id !== ROOT_ID) && (
            <OutlinePageHeading
              store={store}
              target={header}
              nodes={state.nodes}
              visibleNodes={bodyNodes}
              index={index}
              visibleIndex={visibleIndex}
              onBack={() => onZoomRootChange(null)}
              onTagClick={onTagClick}
              imageDropTarget={imageIngest.dropTargetId === header.id}
              onPickImage={() => void imageIngest.openPicker(header.id)}
            />
          )}
          {allBodyNodes.length === 0 && <p className="notes-pane-state">No outline yet.</p>}
          {!showCompleted && bodyNodes.length < allBodyNodes.length && (
            <p className="notes-pane-state">Completed items are hidden.</p>
          )}
          <ol
            className="notes-outline-list"
            role="list"
            ref={outlineWindow.listRef}
            {...pointerSelection}
          >
            {outlineWindow.items.map((item) => {
              if (item.kind === "gap") {
                return (
                  <li
                    key={item.key}
                    aria-hidden="true"
                    role="presentation"
                    style={{ height: item.height }}
                  />
                );
              }
              const node = item.node;
              return (
              <OutlineRow
                key={node.id}
                node={node}
                store={store}
                selected={selectedIds.has(node.id)}
                depth={index.depthOf(node.id, zoomRoot?.id ?? page.id)}
                hasChildren={index.hasChildren(node.id)}
                todoProgress={todoProgress.get(node.id) ?? null}
                imageDropTarget={imageIngest.dropTargetId === node.id}
                dragSource={outlineDrag.rowProps(node.id).dragSource}
                runtime={rowRuntime}
              />
              );
            })}
          </ol>
          {(outlineDrag.dropTarget || outlineDrag.preview) && (
            <Suspense fallback={null}>
              <OutlineDragVisuals
                dropTarget={outlineDrag.dropTarget}
                preview={outlineDrag.preview}
              />
            </Suspense>
          )}
          <NotesChildComposer
            store={store}
            parentId={outlineRootId}
            hasChildren={allBodyNodes.length > 0}
          />
          {state.afterCursor && (
            <OutlineAutoLoad
              cursor={state.afterCursor}
              onReached={() => void store.loadMore()}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function OutlineAutoLoad({
  cursor,
  onReached
}: {
  readonly cursor: string;
  readonly onReached: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const requestedCursorRef = useRef<string | null>(null);
  const onReachedRef = useRef(onReached);
  onReachedRef.current = onReached;
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    if (typeof IntersectionObserver !== "function") {
      // No observer (older runtimes, jsdom): load the rest without waiting for
      // a scroll so the outline never gets stuck at the pagination boundary.
      if (requestedCursorRef.current !== cursor) {
        requestedCursorRef.current = cursor;
        onReachedRef.current();
      }
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      // One request per cursor: the observer keeps firing while the anchor
      // stays in view, and the next page brings a new cursor.
      if (requestedCursorRef.current === cursor) return;
      requestedCursorRef.current = cursor;
      onReachedRef.current();
    }, {
      // The rows scroll in their own container, and rootMargin only offsets
      // the observer's own root: measured against the document it would buy no
      // lead time at all, because the pane clips the anchor first.
      root: anchor.closest(".notes-outline-rows"),
      rootMargin: "600px 0px"
    });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [cursor]);
  // The anchor sits below the windowed list, past the gap standing in for the
  // rows outside the window, so it is only reachable at the real end of the
  // outline and the window never unmounts it.
  return <div ref={anchorRef} className="notes-outline-autoload" aria-hidden="true" />;
}
