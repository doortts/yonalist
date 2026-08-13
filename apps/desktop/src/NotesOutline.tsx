import {
  lazy, Suspense, useEffect, useMemo, useRef, useState,
  useSyncExternalStore
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
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
import { writeImageClipboard } from "./imageClipboard";
import {
  buildOutlineClipboardFormats, CUT_OVER_CLIPBOARD_BOUNDS, SELECTION_INCOMPLETE
} from "./outlineClipboard";
import {
  focusAfterCommit, focusOutlineEditor, focusOutlineSnapshot
} from "./outlineFocus";
import { subtreeIds } from "./storeState";
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
    if (!restoreRequest.focus || !scopeRef.current) return;
    reveal(restoreRequest.focus.nodeId);
    // The revealed row mounts a tick or two from here, which is what
    // focusOutlineSnapshot waits out -- and it waits on timers, so the caret
    // still arrives in a window the browser is painting no frames for.
    focusOutlineSnapshot(scopeRef.current, restoreRequest.focus);
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
      setSelectionFeedback(SELECTION_INCOMPLETE);
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
   */
  const clearSelection = (collapse?: "start" | "end") => {
    const selected = new Set(selection.selectedIds);
    const band = collapse
      ? bodyNodes.filter((node) => selected.has(node.id))
      : [];
    selection.clear();
    setSelectionFeedback("");
    const target = collapse === "start" ? band[0] : band.at(-1);
    const scope = scopeRef.current;
    if (!target || !scope) return;
    focusOutlineEditor(scope, target.id, collapse === "start" ? "start" : "end");
  };
  /**
   * The caret is standing in one of the rows about to go, so removal hands it
   * to the row above -- the row below when there is none, the heading when the
   * outline is emptied. Read before the command, off the rows as they still
   * stand.
   */
  const handOffCaret = (rootIds: readonly string[]): (() => void) => {
    const removed = new Set(subtreeIds(state.nodes, rootIds));
    const first = bodyNodes.findIndex((node) => removed.has(node.id));
    const previous = first > 0 ? bodyNodes[first - 1] : undefined;
    const next = first < 0
      ? undefined
      : bodyNodes.slice(first + 1).find((node) => !removed.has(node.id));
    const target = previous ?? next;
    return () => {
      const scope = scopeRef.current;
      if (!scope) return;
      focusAfterCommit(
        scope,
        target?.id ?? outlineRootId,
        previous ? "end" : "start"
      );
    };
  };
  const deleteSelection = async () => {
    const takeCaret = handOffCaret(selection.selectedRootIds);
    await store.deleteSubtrees(selection.selectedRootIds);
    clearSelection();
    takeCaret();
  };
  // One image on its own goes to the clipboard as the image, not as the line
  // its filename would serialize to.
  const selectedImage = selection.selectedIds.length === 1 &&
    selection.selectedNodes[0]?.kind === "image"
    ? selection.selectedNodes[0]
    : null;
  // The whole snapshot, not the row on its own: an image row can have children
  // and drafts of its own, and a payload built from `[node]` would paste the
  // picture back with its subtree missing. Undefined when the subtree runs past
  // what the clipboard format holds.
  const nodeClipboardHtml = (node: NoteView) =>
    buildOutlineClipboardFormats(store.getSnapshot(), [node.id])?.html;
  // The read promise goes straight into the write: WebKit refuses a clipboard
  // write that starts after the gesture that asked for it, so nothing may be
  // awaited between the key and `writeImageClipboard`.
  const writeNodeImage = (
    node: NoteView,
    // The row's own payload rides along, so pasting the image back here
    // restores the node by hash while other apps still get the picture.
    html = nodeClipboardHtml(node)
  ) => writeImageClipboard(
    store.images.read(node.id),
    node.image?.mimeType ?? "application/octet-stream",
    node.image?.originalName ?? node.text,
    html
  );
  // A copy may fall back to the picture alone -- nothing is lost either way.
  // A cut may not: the payload is the only thing that can bring the rows under
  // the image back, so without one there is nothing to delete against.
  const writeSelectionToClipboard = (payloadRequired: boolean) => {
    if (!selectedImage) return selection.copyToSystem(payloadRequired);
    const html = nodeClipboardHtml(selectedImage);
    if (!html && payloadRequired) {
      return Promise.reject(new Error(CUT_OVER_CLIPBOARD_BOUNDS));
    }
    return writeNodeImage(selectedImage, html);
  };
  const reportWriteFailure = () => setSelectionFeedback(selectedImage
    ? "Could not write the image to the clipboard."
    : "Could not write the selected outline to the clipboard.");
  const copySelection = async () => {
    try {
      await writeSelectionToClipboard(false);
      setSelectionFeedback(selectedImage
        ? "Copied image."
        : "Copied selected outline.");
    } catch {
      reportWriteFailure();
    }
  };
  const cutSelection = async () => {
    if (!selection.canCut) return;
    try {
      await writeSelectionToClipboard(true);
    } catch (error) {
      if (error instanceof Error &&
        error.message === CUT_OVER_CLIPBOARD_BOUNDS) {
        setSelectionFeedback(CUT_OVER_CLIPBOARD_BOUNDS);
      } else {
        reportWriteFailure();
      }
      return;
    }
    try {
      await deleteSelection();
      setSelectionFeedback("Cut selected outline.");
    } catch {
      setSelectionFeedback("Copied, but couldn't remove the selected outline.");
    }
  };
  // A bullet gets its copy and cut as clipboard events; WebKit sends none to an
  // image row, so its own keydown lands here with nothing selected. The write
  // leaves inside that keydown -- only what follows it waits on the guard.
  const putImageOnClipboard = (
    nodeId: string,
    done: () => Promise<void> | void,
    html?: string
  ) => {
    const node = index.node(nodeId);
    if (!node) return;
    const written = writeNodeImage(node, html)
      .then(() => true, () => false);
    runExclusive(async () => {
      if (!await written) {
        setSelectionFeedback("Could not write the image to the clipboard.");
        return;
      }
      await done();
    });
  };
  // The refusals the rich payload replaced are gone, so a picture with a
  // caption under it cuts and pastes back with the caption. One guard survives
  // them: the payload beside the bytes is the only thing that brings those rows
  // back, so a subtree too big to carry is a subtree too big to delete.
  const cutImageNode = (nodeId: string) => {
    const node = index.node(nodeId);
    if (!node) return;
    // The payload is built from the loaded window, and the delete takes the
    // whole subtree the server holds: past the window those two disagree, so
    // this waits on the window being whole. The selection's own forest says
    // nothing here -- this row was never part of a selection.
    if (!structuralContextComplete) {
      setSelectionFeedback(SELECTION_INCOMPLETE);
      return;
    }
    const html = nodeClipboardHtml(node);
    if (!html) {
      setSelectionFeedback(CUT_OVER_CLIPBOARD_BOUNDS);
      return;
    }
    const takeCaret = handOffCaret([nodeId]);
    putImageOnClipboard(nodeId, async () => {
      await store.deleteSubtrees([nodeId]);
      clearSelection();
      takeCaret();
      setSelectionFeedback("Cut image.");
    }, html);
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
    onExtendSelection: selection.extend,
    onClearSelection: clearSelection,
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
