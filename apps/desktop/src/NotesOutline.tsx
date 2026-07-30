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
import { OutlineHeader } from "./OutlineHeader";
import { OutlineRow, OutlineRowRuntime } from "./OutlineRow";
import { NotesChildComposer } from "./NotesChildComposer";
import { buildTodoProgressMap } from "./outlineTodo";
import type { OutlineTagToken } from "./OutlineTextField";
import {
  buildSelectionMovePlans, selectedCompletion, type SelectionMovePlan
} from "./selectionMoves";
import { OutlineIndex } from "./outlineIndex";
import type { PaneFocusSnapshot } from "./appNavigation";
import { useImageIngest } from "./useImageIngest";
import { NotesExportBoundary } from "./NotesExportBoundary";
import { outlineSurfaceFromSearch } from "./outlineSurface";

const OutlineSelectionActionBar = lazy(() =>
  import("./OutlineSelectionActionBar").then((module) => ({
    default: module.OutlineSelectionActionBar
  })));
const OutlineDragVisuals = lazy(() =>
  import("./OutlineDragVisuals").then((module) => ({
    default: module.OutlineDragVisuals
  })));
const MonacoOutlineSurface = lazy(() =>
  import("./MonacoOutlineSurface").then((module) => ({
    default: module.MonacoOutlineSurface
  })));

export interface PaneRestoreRequest {
  readonly epoch: number;
  readonly selectedIds: readonly string[];
  readonly focus: PaneFocusSnapshot | null;
}

export function NotesOutline({
  store, status, error, pendingWrites, page, zoomRootId, onZoomRootChange,
  onOpenSplit, onTagClick, onClose, paneId, restoreRequest
}: {
  readonly store: NotesStore;
  readonly status: NotesShellSnapshot["status"];
  readonly error: string | null;
  readonly pendingWrites: number;
  readonly page: { id: string; title: string } | undefined;
  readonly zoomRootId: string | null;
  readonly onZoomRootChange: (nodeId: string | null) => void;
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
  }, [restoreRequest]);
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
  const allSelectedCompleted = selectedCompletion(
    selection.selectedNodes,
    selection.selectedIds
  );
  const movePlans = selection.selectedRootIds.length === 0
    ? buildSelectionMovePlans([], [], [], outlineRootId)
    : structuralContextComplete
    ? buildSelectionMovePlans(
      state.nodes,
      bodyNodes.map((node) => node.id),
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
  const outlineSurface = outlineSurfaceFromSearch(
    typeof location === "undefined" ? "" : location.search
  );
  if (status === "loading" && !page) {
    return <section className="notes-outline"><p className="notes-pane-state">Loading notes...</p></section>;
  }
  if (!page) {
    return <section className="notes-outline"><p className="notes-pane-state">No outline yet.</p></section>;
  }
  rowRuntime.update({
    nodes: state.nodes,
    visibleNodes: bodyNodes,
    index,
    visibleIndex,
    pageId: zoomRoot?.id ?? page.id,
    selectionHeadId: selection.headId,
    hasSelection: selection.selectedIds.length > 0,
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
      delete: () => runSelectionAction(deleteSelection)
    },
    onDragHandlePointerDown: (nodeId, event) =>
      outlineDrag.rowProps(nodeId).onDragHandlePointerDown(event),
    onDragHandleKeyDown: (nodeId, event) =>
      outlineDrag.rowProps(nodeId).onDragHandleKeyDown(event),
    consumeDragHandleClick: (nodeId) =>
      outlineDrag.rowProps(nodeId).consumeDragHandleClick()
  });
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
        if (!selection.canCut) {
          event.preventDefault();
          setSelectionFeedback(
            "Cut is unavailable because the selection contains a note or multiline title."
          );
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
        visibleNodes={bodyNodes}
        index={index}
        visibleIndex={visibleIndex}
        pageTitle={page.title}
        zoomed={zoomRoot !== undefined}
        showCompleted={showCompleted}
        error={error}
        onToggleCompleted={() => setShowCompleted((visible) => !visible)}
        onBack={() => onZoomRootChange(null)}
        onTagClick={onTagClick}
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
        imageDropTarget={imageIngest.dropTargetId === header.id}
        onPickImage={() => void imageIngest.openPicker(header.id)}
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
      <div
        className="notes-outline-rows"
        data-outline-surface={outlineSurface}
      >
        <div className="notes-outline-content" data-zoomed-page="true">
          {allBodyNodes.length === 0 && <p className="notes-pane-state">No outline yet.</p>}
          {!showCompleted && bodyNodes.length < allBodyNodes.length && (
            <p className="notes-pane-state">Completed items are hidden.</p>
          )}
          {outlineSurface === "monaco" ? (
            <Suspense fallback={<div className="notes-monaco-outline" />}>
              <MonacoOutlineSurface
                nodes={bodyNodes}
                index={index}
                rootId={outlineRootId}
                paneId={paneId}
                store={store}
              />
            </Suspense>
          ) : (
            <>
              <ol className="notes-outline-list" role="list" {...pointerSelection}>
                {bodyNodes.map((node) => (
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
                ))}
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
            </>
          )}
          {state.afterCursor && (
            <button className="text-button" type="button" onClick={() => void store.loadMore()}>
              Load more
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
