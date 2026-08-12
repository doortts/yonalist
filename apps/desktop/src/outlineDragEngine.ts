import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  planCrossPaneDrop,
  planOutlineDrop,
  type OutlineDropPlan
} from "./outlineDragPlan";
import type { SelectionNodeMove } from "./selectionMoves";
import type { useOutlineSelection } from "./useOutlineSelection";
import { outlinePane } from "./outlinePaneRegistry";

export interface UseOutlineDragInput {
  readonly enabled: boolean;
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly outlineRootId: string;
  readonly selection: ReturnType<typeof useOutlineSelection>;
  readonly moveNodes: (moves: readonly SelectionNodeMove[]) => Promise<void>;
  readonly labelForId: (id: string) => string;
}

export interface DragGesture {
  readonly pointerId: number;
  readonly activeId: string;
  readonly rootIds: readonly string[];
  /** Row count when the selection owns the dragged row; null means the count
   * is the active row's own subtree, which only gets walked once the pointer
   * has actually travelled far enough to be a drag. */
  readonly selectedCount: number | null;
  readonly startX: number;
  readonly startY: number;
  readonly captureTarget: HTMLButtonElement;
  readonly sourceScope: HTMLElement;
  total: number | null;
  dragging: boolean;
}

export interface KeyboardGesture {
  readonly activeId: string;
  readonly rootIds: readonly string[];
  readonly sourceScope: HTMLElement;
  readonly sourceButton: HTMLButtonElement;
  readonly total: number;
  overId: string;
  horizontalOffset: number;
}

interface MutableRef<T> {
  current: T;
}

export interface OutlineDragHost {
  readonly inputRef: MutableRef<UseOutlineDragInput>;
  readonly keyboardRef: MutableRef<KeyboardGesture | null>;
  readonly planRef: MutableRef<OutlineDropPlan | null>;
  readonly targetScopeRef: MutableRef<HTMLElement | null>;
  readonly suppressClickRef: MutableRef<string | null>;
  readonly setPlan: (plan: OutlineDropPlan | null) => void;
  readonly setTargetScope: (scope: HTMLElement | null) => void;
  readonly setDraggedRootIds: (rootIds: readonly string[]) => void;
  readonly setDraggedTotal: (total: number) => void;
  readonly setDragSourceIds: (ids: ReadonlySet<string>) => void;
  readonly setPointer: (pointer: { x: number; y: number } | null) => void;
  readonly setAnnouncement: (message: string) => void;
  readonly clearVisuals: () => void;
}

export interface OutlineDragEngine {
  /** Plans the drop for a pointer that has already crossed the drag threshold. */
  readonly trackPointer: (
    gesture: DragGesture,
    clientX: number,
    clientY: number,
    target: EventTarget | null
  ) => void;
  readonly keyDown: (
    key: string,
    activeId: string,
    button: HTMLButtonElement
  ) => void;
}

interface PointerDestination {
  readonly scope: HTMLElement;
  readonly outlineRootId: string;
  readonly visibleNodes: readonly NoteView[];
  readonly overId: string | null;
}

const KEYBOARD_INDENT = 36;

function pointerDestination(
  clientX: number,
  clientY: number,
  target: EventTarget | null
): PointerDestination | null {
  const pointed = typeof document.elementFromPoint === "function"
    ? document.elementFromPoint(clientX, clientY)
    : null;
  const element = pointed ?? (target instanceof Element ? target : null);
  const scope = element?.closest<HTMLElement>(
    ".notes-outline[data-outline-root-id]"
  );
  // Hit testing is a question about pixels, so it reads the DOM; the row list
  // is a question about the outline, so it comes from the pane's own model.
  // Reading it back out of the DOM would silently shrink to whatever rows
  // happen to be within the rendered window.
  const overId = element?.closest<HTMLElement>("[data-outline-id]")
    ?.dataset.outlineId ?? null;
  const outlineRootId = scope?.dataset.outlineRootId;
  if (!scope || !outlineRootId) return null;
  return {
    scope,
    outlineRootId,
    visibleNodes: outlinePane(scope)?.visibleNodes ?? [],
    overId
  };
}

function isInSubtree(
  node: NoteView,
  roots: ReadonlySet<string>,
  byId: ReadonlyMap<string, NoteView>
): boolean {
  let currentId: string | null = node.id;
  const visited = new Set<string>();
  while (currentId && visited.add(currentId)) {
    if (roots.has(currentId)) return true;
    currentId = byId.get(currentId)?.parentId ?? null;
  }
  return false;
}

/** Every row carried by a drag: the dragged roots plus everything beneath. */
export function subtreeIds(
  nodes: readonly NoteView[],
  rootIds: readonly string[]
): ReadonlySet<string> {
  const roots = new Set(rootIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return new Set(nodes
    .filter((node) => isInSubtree(node, roots, byId))
    .map((node) => node.id));
}

export function createOutlineDragEngine(
  host: OutlineDragHost
): OutlineDragEngine {
  const showDraggedRows = (
    rootIds: readonly string[],
    selectedCount: number | null
  ) => {
    const sourceIds = subtreeIds(host.inputRef.current.nodes, rootIds);
    const total = selectedCount ?? sourceIds.size;
    host.setDraggedRootIds(rootIds);
    host.setDraggedTotal(total);
    host.setDragSourceIds(sourceIds);
    return total;
  };
  const commitPlan = (
    nextPlan: OutlineDropPlan | null,
    scope: HTMLElement | null
  ) => {
    host.planRef.current = nextPlan;
    host.targetScopeRef.current = nextPlan ? scope : null;
    host.setPlan(nextPlan);
    host.setTargetScope(host.targetScopeRef.current);
  };
  const trackPointer = (
    gesture: DragGesture,
    clientX: number,
    clientY: number,
    target: EventTarget | null
  ) => {
    if (gesture.total === null) {
      gesture.total = showDraggedRows(gesture.rootIds, gesture.selectedCount);
    }
    host.setPointer({ x: clientX, y: clientY });
    const current = host.inputRef.current;
    const destination = pointerDestination(clientX, clientY, target);
    const samePaneOverId = destination?.overId ??
      destination?.visibleNodes.at(-1)?.id ?? null;
    const nextPlan = destination
      ? destination.scope === gesture.sourceScope
        ? samePaneOverId === null ? null : planOutlineDrop({
            nodes: current.nodes,
            visibleNodes: current.visibleNodes,
            selectedRootIds: gesture.rootIds,
            activeId: gesture.activeId,
            overId: samePaneOverId,
            horizontalOffset: clientX - gesture.startX,
            outlineRootId: current.outlineRootId
          })
        : planCrossPaneDrop({
            nodes: current.nodes,
            visibleNodes: destination.visibleNodes,
            selectedRootIds: gesture.rootIds,
            overId: destination.overId,
            horizontalOffset: clientX - gesture.startX,
            outlineRootId: destination.outlineRootId
          })
      : null;
    commitPlan(nextPlan, destination?.scope ?? null);
  };
  const keyboardPlan = (gesture: KeyboardGesture) => {
    const current = host.inputRef.current;
    const nextPlan = planOutlineDrop({
      nodes: current.nodes,
      visibleNodes: current.visibleNodes,
      selectedRootIds: gesture.rootIds,
      activeId: gesture.activeId,
      overId: gesture.overId,
      horizontalOffset: gesture.horizontalOffset,
      outlineRootId: current.outlineRootId
    });
    commitPlan(nextPlan, gesture.sourceScope);
    if (nextPlan) {
      host.setAnnouncement(
        `Move preview at depth ${nextPlan.depth + 1}. Press Space or Enter to drop.`
      );
    }
  };
  const finishKeyboard = (cancelled: boolean) => {
    const gesture = host.keyboardRef.current;
    if (!gesture) return;
    host.keyboardRef.current = null;
    const committedPlan = host.planRef.current;
    host.clearVisuals();
    host.suppressClickRef.current = gesture.activeId;
    if (cancelled) {
      host.setAnnouncement("Keyboard move cancelled.");
      return;
    }
    if (committedPlan) {
      host.setAnnouncement("Dropped note.");
      void host.inputRef.current.moveNodes(committedPlan.moves);
    } else {
      host.setAnnouncement("No valid move target was selected.");
    }
    // A microtask, not a frame: the move re-renders the row the handle sits on,
    // and an occluded window runs no frames to hand the focus back in.
    queueMicrotask(() => gesture.sourceButton.focus());
  };
  const pickUp = (activeId: string, button: HTMLButtonElement) => {
    const current = host.inputRef.current;
    if (!current.enabled) return;
    const sourceScope = button.closest<HTMLElement>(
      ".notes-outline[data-outline-root-id]"
    );
    if (!sourceScope) return;
    const selectionOwnsActive =
      current.selection.selectedIds.includes(activeId);
    const rootIds = selectionOwnsActive
      ? [...current.selection.selectedRootIds]
      : [activeId];
    const total = showDraggedRows(
      rootIds,
      selectionOwnsActive ? current.selection.selectedIds.length : null
    );
    const rectangle = button.getBoundingClientRect();
    host.keyboardRef.current = {
      activeId,
      rootIds,
      sourceScope,
      sourceButton: button,
      total,
      overId: activeId,
      horizontalOffset: 0
    };
    host.suppressClickRef.current = activeId;
    host.setPointer({
      x: rectangle.left + rectangle.width / 2,
      y: rectangle.top + rectangle.height / 2
    });
    const label = current.labelForId(activeId) || "Untitled";
    host.setAnnouncement(
      `Picked up ${label}. Use arrow keys to move, Space or Enter to drop, Escape to cancel.`
    );
  };
  const stepOver = (gesture: KeyboardGesture, direction: 1 | -1) => {
    const current = host.inputRef.current;
    const forest = subtreeIds(current.nodes, gesture.rootIds);
    const currentIndex = current.visibleNodes.findIndex(
      (node) => node.id === gesture.overId
    );
    const activeIndex = current.visibleNodes.findIndex(
      (node) => node.id === gesture.activeId
    );
    const startIndex = currentIndex >= 0 ? currentIndex : activeIndex;
    for (
      let index = startIndex + direction;
      index >= 0 && index < current.visibleNodes.length;
      index += direction
    ) {
      const candidate = current.visibleNodes[index];
      if (!forest.has(candidate.id)) {
        gesture.overId = candidate.id;
        keyboardPlan(gesture);
        return;
      }
    }
  };
  const keyDown = (
    key: string,
    activeId: string,
    button: HTMLButtonElement
  ) => {
    const activation = key === " " || key === "Enter";
    const gesture = host.keyboardRef.current;
    if (!gesture) {
      if (activation) pickUp(activeId, button);
      return;
    }
    if (gesture.activeId !== activeId) return;
    if (activation) {
      finishKeyboard(false);
      return;
    }
    if (key === "Escape") {
      finishKeyboard(true);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      gesture.horizontalOffset += key === "ArrowRight"
        ? KEYBOARD_INDENT
        : -KEYBOARD_INDENT;
      keyboardPlan(gesture);
      return;
    }
    if (key === "ArrowUp") stepOver(gesture, -1);
    else if (key === "ArrowDown") stepOver(gesture, 1);
  };
  return { trackPointer, keyDown };
}
