import {
  lazy, Suspense, useEffect, useMemo, useRef, useState,
  useSyncExternalStore
} from "react";
import { NotesStore } from "./notesStore";
import type { NotesShellSnapshot } from "./store/storeSubscriptions";
import {
  hideCollapsedSubtrees, hideCompletedSubtrees
} from "./outline/outlineVisibility";
import { useOutlineSelection } from "./outline/useOutlineSelection";
import { widenOutlineSelection } from "./outline/outlineWidenSelection";
import { useOutlinePointerSelection } from "./outline/useOutlinePointerSelection";
import { useOutlineDrag } from "./outline/useOutlineDrag";
import { OutlineHeader, OutlinePageHeading } from "./outline/OutlineHeader";
import { OutlineRow, OutlineRowRuntime } from "./outline/OutlineRow";
import { NotesChildComposer } from "./NotesChildComposer";
import { orderedNumbers } from "./outline/outlineOrdered";
import { buildTodoProgressMap } from "./outline/outlineTodo";
import type { OutlineTagToken } from "./outline/OutlineTextField";
import type { SelectionMovePlan } from "./selectionMoves";
import { OutlineIndex } from "./outline/outlineIndex";
import type { PaneFocusSnapshot } from "./appNavigation";
import { useImageIngest } from "./image/useImageIngest";
import { OUTLINE_WINDOW_INCOMPLETE } from "./outline/outlineClipboard";
import { outlineClipboardActions } from "./outline/outlineClipboardActions";
import {
  focusAfterCommit, focusOutlineEditor, focusOutlineSnapshot
} from "./outline/outlineFocus";
import { caretHandoff } from "./outline/outlineCaretHandoff";
import { NotesExportBoundary } from "./NotesExportBoundary";
import { useOutlineWindow } from "./outline/useOutlineWindow";
import { liveHistorySelection } from "./historyRestore";
import { registerOutlinePane } from "./outline/outlinePaneRegistry";
import { ROOT_ID } from "./store/storeSupport";

const OutlineSelectionActionBar = lazy(() =>
  import("./outline/OutlineSelectionActionBar").then((module) => ({
    default: module.OutlineSelectionActionBar
  })));
const OutlineDragVisuals = lazy(() =>
  import("./outline/OutlineDragVisuals").then((module) => ({
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
  // Declared ahead of the registration below, which hands history a way to read
  // the band and to put one back; the selection hook both point at is built
  // further down.
  const restoreSelectionRef = useRef<(ids: readonly string[]) => void>(
    () => undefined
  );
  const selectedIdsRef = useRef<readonly string[]>([]);
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
  // Read by the restore below, which must not re-run when this is rebuilt.
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    if (scopeRef.current) {
      registerOutlinePane(scopeRef.current, {
        visibleNodes: bodyNodes,
        reveal,
        selectedIds: () => selectedIdsRef.current,
        replaceSelection: (ids) => restoreSelectionRef.current(ids)
      });
    }
  }, [bodyNodes, reveal]);
  const structuralContextComplete =
    state.beforeCursor === null && state.afterCursor === null;
  const selection = useOutlineSelection(
    bodyNodes, state.nodes, store,
    `${page?.id ?? ""}:${zoomRootId ?? ""}`,
    structuralContextComplete,
    state.revision);
  restoreSelectionRef.current = selection.replace;
  selectedIdsRef.current = selection.selectedIds;
  const {
    materializeForest,
    rootKey,
    selectedRootIds
  } = selection;
  useEffect(() => {
    if (!restoreRequest) return;
    // Through the same filter an undo's band goes through: a recorded row the
    // outline no longer has would land as the band's end, and Shift with an
    // arrow has nowhere to step from there.
    restoreSelectionRef.current(liveHistorySelection(
      restoreRequest.selectedIds, store.getSnapshot().nodes));
    if (!restoreRequest.focus || !scopeRef.current) return;
    revealRef.current(restoreRequest.focus.nodeId);
    // The revealed row mounts a tick or two from here, which is what
    // focusOutlineSnapshot waits out -- and it waits on timers, so the caret
    // still arrives in a window the browser is painting no frames for.
    focusOutlineSnapshot(scopeRef.current, restoreRequest.focus);
    // One request, answered once. `reveal` is rebuilt whenever the rows
    // change, and rows change under a reader who is typing -- a row of their
    // own, a page being written for the first time. Waiting on it here would
    // answer the same request again and drop the caret back where the request
    // was made, which is offset zero for a page just opened.
  }, [restoreRequest, store]);
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
  const runExclusive = (action: () => Promise<unknown> | unknown) => {
    if (selectionOperation.current) return;
    selectionOperation.current = true;
    setSelectionOperationBusy(true);
    void Promise.resolve().then(action).finally(() => {
      selectionOperation.current = false;
      setSelectionOperationBusy(false);
    });
  };
  const runSelectionAction = (
    action: () => Promise<unknown> | unknown
  ) => {
    if (selectionOperation.current) return;
    if (!selection.forestComplete) {
      setSelectionFeedback(OUTLINE_WINDOW_INCOMPLETE);
      return;
    }
    runExclusive(action);
  };
  const executeMovePlan = (plan: SelectionMovePlan) => {
    if (plan.available) runSelectionAction(() => store.moveNodes(plan.moves));
  };
  /**
   * `collapse` is how an arrow key clears the band: the caret lands on the edge
   * the key pointed at, so the row it lands in has to be read off the selection
   * before it goes.
   *
   * The ends are the band's visible first and last row, not its anchor and head:
   * a band built upward has them the other way round, and reading the pair would
   * send the caret to the opposite end of the same band.
   *
   * `step` is the vertical arrows: they move a line as they drop a swept span of
   * letters, so they move a row as they drop a band, and the row they land on
   * takes the caret the way a bare arrow off that end would have left it.
   */
  const clearSelection = (collapse?: "start" | "end", step?: boolean) => {
    // WKWebView holds on to the range a band drag left it with, and the rule
    // that keeps that range from being painted goes when the band does. So the
    // range goes with the band.
    scopeRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    const selected = new Set(selection.selectedIds);
    const band = collapse
      ? bodyNodes.filter((node) => selected.has(node.id))
      : [];
    selection.clear();
    setSelectionFeedback("");
    const edge = collapse === "start" ? band[0] : band.at(-1);
    const scope = scopeRef.current;
    if (!edge || !scope) return;
    const at = bodyNodes.indexOf(edge);
    const beyond = step
      ? bodyNodes[collapse === "start" ? at - 1 : at + 1]
      : undefined;
    if (beyond) return void focusOutlineEditor(scope, beyond.id, "start");
    // Above the first row there is only the page title, which is where a bare
    // arrow off that row goes as well. Home draws none, and there the band's
    // own first row is the top.
    if (
      step && collapse === "start" && at === 0 &&
      focusOutlineEditor(scope, outlineRootId, "start")
    ) {
      return;
    }
    focusOutlineEditor(scope, edge.id, collapse === "start" ? "start" : "end");
  };
  const handOffCaret = caretHandoff({
    nodes: state.nodes,
    visibleNodes: bodyNodes,
    outlineRootId,
    scopeRef
  });
  const deleteSelection = async () => {
    const takeCaret = handOffCaret(selection.selectedRootIds);
    await store.deleteSubtrees(selection.selectedRootIds);
    clearSelection();
    takeCaret();
  };
  const {
    selectedImage, copySelection, cutSelection, putImageOnClipboard,
    cutImageNode
  } = outlineClipboardActions({
    store, selection, index, structuralContextComplete, setSelectionFeedback,
    runExclusive, clearSelection, deleteSelection, handOffCaret
  });
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
  const rowNumbers = useMemo(
    () => orderedNumbers(state.nodes),
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
    band: {
      headId: selection.headId,
      anchorId: selection.anchorId,
      hasSelection: selection.selectedIds.length > 0
    },
    selectionRootIds: selection.selectedRootIds,
    selectionPlans: movePlans,
    allSelectedCompleted,
    selectionCutRefusal: selection.cutRefusal,
    forestComplete: structuralContextComplete && selection.forestComplete,
    // A row command reads the loaded window and deletes what the server holds,
    // so it needs the window whole -- not the forest behind whatever is
    // selected, which says nothing about the row that was right-clicked. The
    // same gate the image row's own Cut reads.
    outlineComplete: structuralContextComplete,
    onZoom: (nodeId, split) => {
      if (split && onOpenSplit) onOpenSplit(nodeId);
      else onZoomRootChange(nodeId);
    },
    onZoomOut: () => onZoomRootChange(null),
    onExtendSelection: (originId, headId, edge) => {
      selection.extend(originId, headId);
      // The head is the end the key is moving, so the caret goes with it: left
      // behind, it would sit on a row the pane never scrolls back to, and the
      // head would run off the screen unseen.
      const scope = scopeRef.current;
      if (scope) focusAfterCommit(scope, headId, edge);
    },
    onClearSelection: clearSelection,
    onWidenSelection: (fromNodeId) => {
      const wider = widenOutlineSelection(
        bodyNodes, selection.selectedRootIds, fromNodeId, outlineRootId
      );
      if (wider) selection.replace(wider);
    },
    onTagClick,
    onPickImage: (nodeId) => void imageIngest.openPicker(nodeId),
    onCopyImage: (nodeId) => putImageOnClipboard(
      nodeId,
      () => setSelectionFeedback("Copied image.")
    ),
    onCutImage: cutImageNode,
    onPasteRefused: setSelectionFeedback,
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
      data-band={selection.selectedIds.length > 0 ? "true" : undefined}
      onCopy={(event) => {
        // Bytes cannot ride the event's synchronous text payload, so the image
        // branch takes the clipboard over and writes it itself.
        if (!selectedImage) return selection.copy(event);
        event.preventDefault();
        runSelectionAction(copySelection);
      }}
      onCut={(event) => {
        if (selection.selectedIds.length === 0) return;
        if (selection.cutRefusal) {
          event.preventDefault();
          setSelectionFeedback(selection.cutRefusal);
          return;
        }
        if (selectedImage) {
          event.preventDefault();
          runSelectionAction(cutSelection);
          return;
        }
        const refusal = selection.writeToEvent(event);
        if (refusal) {
          setSelectionFeedback(refusal);
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
              key={header.id}
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
                orderedNumber={rowNumbers.get(node.id) ?? null}
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
