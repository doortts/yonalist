import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  planCrossPaneDrop,
  planOutlineDrop,
  type OutlineDropPlan
} from "./outlineDragPlan";
import type { SelectionNodeMove } from "./selectionMoves";
import type { useOutlineSelection } from "./useOutlineSelection";

interface DragGesture {
  readonly pointerId: number;
  readonly activeId: string;
  readonly rootIds: readonly string[];
  readonly startX: number;
  readonly startY: number;
  readonly captureTarget: HTMLButtonElement;
  readonly sourceScope: HTMLElement;
  readonly total: number;
  dragging: boolean;
}

interface KeyboardGesture {
  readonly activeId: string;
  readonly rootIds: readonly string[];
  readonly sourceScope: HTMLElement;
  readonly sourceButton: HTMLButtonElement;
  readonly total: number;
  overId: string;
  horizontalOffset: number;
}

interface PointerDestination {
  readonly scope: HTMLElement;
  readonly outlineRootId: string;
  readonly visibleNodes: readonly NoteView[];
  readonly overId: string | null;
}

interface UseOutlineDragInput {
  readonly enabled: boolean;
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly outlineRootId: string;
  readonly selection: ReturnType<typeof useOutlineSelection>;
  readonly moveNodes: (moves: readonly SelectionNodeMove[]) => Promise<void>;
  readonly labelForId: (id: string) => string;
}

const ACTIVATION_DISTANCE = 4;

function pointerDestination(
  event: globalThis.PointerEvent,
  nodes: readonly NoteView[]
): PointerDestination | null {
  const pointed = typeof document.elementFromPoint === "function"
    ? document.elementFromPoint(event.clientX, event.clientY)
    : null;
  const target = pointed ?? (
    event.target instanceof Element ? event.target : null
  );
  const scope = target?.closest<HTMLElement>(
    ".notes-outline[data-outline-root-id]"
  );
  const overId = target?.closest<HTMLElement>("[data-outline-id]")
    ?.dataset.outlineId ?? null;
  const outlineRootId = scope?.dataset.outlineRootId;
  if (!scope || !outlineRootId) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visibleNodes = [...scope.querySelectorAll<HTMLElement>(
    "[data-outline-id]"
  )].flatMap((row) => {
    const node = row.dataset.outlineId
      ? byId.get(row.dataset.outlineId)
      : undefined;
    return node ? [node] : [];
  });
  return { scope, outlineRootId, visibleNodes, overId };
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

export function useOutlineDrag(input: UseOutlineDragInput) {
  const inputRef = useRef(input);
  const gestureRef = useRef<DragGesture | null>(null);
  const keyboardRef = useRef<KeyboardGesture | null>(null);
  const planRef = useRef<OutlineDropPlan | null>(null);
  const targetScopeRef = useRef<HTMLElement | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const [plan, setPlan] = useState<OutlineDropPlan | null>(null);
  const [targetScope, setTargetScope] = useState<HTMLElement | null>(null);
  const [draggedRootIds, setDraggedRootIds] = useState<readonly string[]>([]);
  const [draggedTotal, setDraggedTotal] = useState(0);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  inputRef.current = input;
  planRef.current = plan;
  targetScopeRef.current = targetScope;

  useEffect(() => {
    const clearVisuals = () => {
      planRef.current = null;
      targetScopeRef.current = null;
      setPlan(null);
      setTargetScope(null);
      setDraggedRootIds([]);
      setDraggedTotal(0);
      setPointer(null);
    };
    const finish = (pointerId: number, cancelled: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== pointerId) return;
      gestureRef.current = null;
      if (gesture.captureTarget.hasPointerCapture?.(pointerId)) {
        gesture.captureTarget.releasePointerCapture(pointerId);
      }
      const committedPlan = planRef.current;
      clearVisuals();
      if (!gesture.dragging) return;
      suppressClickRef.current = gesture.activeId;
      if (!cancelled && committedPlan) {
        void inputRef.current.moveNodes(committedPlan.moves);
      }
    };
    const move = (event: globalThis.PointerEvent) => {
      const gesture = gestureRef.current;
      if (
        !gesture ||
        gesture.pointerId !== event.pointerId ||
        event.buttons !== 1
      ) {
        return;
      }
      if (!gesture.dragging) {
        const distance = Math.hypot(
          event.clientX - gesture.startX,
          event.clientY - gesture.startY
        );
        if (distance < ACTIVATION_DISTANCE) return;
        gesture.dragging = true;
        setDraggedRootIds(gesture.rootIds);
        setDraggedTotal(gesture.total);
      }
      setPointer({ x: event.clientX, y: event.clientY });
      const current = inputRef.current;
      const destination = pointerDestination(event, current.nodes);
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
              horizontalOffset: event.clientX - gesture.startX,
              outlineRootId: current.outlineRootId
            })
          : planCrossPaneDrop({
              nodes: current.nodes,
              visibleNodes: destination.visibleNodes,
              selectedRootIds: gesture.rootIds,
              overId: destination.overId,
              horizontalOffset: event.clientX - gesture.startX,
              outlineRootId: destination.outlineRootId
            })
        : null;
      planRef.current = nextPlan;
      targetScopeRef.current = nextPlan ? destination?.scope ?? null : null;
      setPlan(nextPlan);
      setTargetScope(targetScopeRef.current);
      event.preventDefault();
    };
    const up = (event: globalThis.PointerEvent) =>
      finish(event.pointerId, false);
    const cancel = (event: globalThis.PointerEvent) =>
      finish(event.pointerId, true);
    const cancelActive = () => {
      const pointerId = gestureRef.current?.pointerId;
      if (pointerId !== undefined) finish(pointerId, true);
      if (keyboardRef.current) {
        keyboardRef.current = null;
        clearVisuals();
        setAnnouncement("Keyboard move cancelled.");
      }
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") cancelActive();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("lostpointercapture", cancel, true);
    window.addEventListener("blur", cancelActive);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("lostpointercapture", cancel, true);
      window.removeEventListener("blur", cancelActive);
      document.removeEventListener("visibilitychange", visibility);
      cancelActive();
    };
  }, []);

  const dragSourceIds = useMemo(() => {
    const roots = new Set(draggedRootIds);
    const byId = new Map(input.nodes.map((node) => [node.id, node]));
    return new Set(input.nodes
      .filter((node) => isInSubtree(node, roots, byId))
      .map((node) => node.id));
  }, [draggedRootIds, input.nodes]);

  const dragRoots = (activeId: string) => {
    const selectionOwnsActive = input.selection.selectedIds.includes(activeId);
    const rootIds = selectionOwnsActive
      ? [...input.selection.selectedRootIds]
      : [activeId];
    const roots = new Set(rootIds);
    const byId = new Map(input.nodes.map((node) => [node.id, node]));
    return {
      rootIds,
      total: selectionOwnsActive
        ? input.selection.selectedIds.length
        : input.nodes.filter((node) => isInSubtree(node, roots, byId)).length
    };
  };
  const start = (
    event: ReactPointerEvent<HTMLButtonElement>,
    activeId: string
  ) => {
    if (event.button !== 0 || !input.enabled) return;
    const sourceScope = event.currentTarget.closest<HTMLElement>(
      ".notes-outline[data-outline-root-id]"
    );
    if (!sourceScope) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const { rootIds, total } = dragRoots(activeId);
    gestureRef.current = {
      pointerId: event.pointerId,
      activeId,
      rootIds,
      startX: event.clientX,
      startY: event.clientY,
      captureTarget: event.currentTarget,
      sourceScope,
      total,
      dragging: false
    };
  };
  const keyboardPlan = (gesture: KeyboardGesture) => {
    const current = inputRef.current;
    const nextPlan = planOutlineDrop({
      nodes: current.nodes,
      visibleNodes: current.visibleNodes,
      selectedRootIds: gesture.rootIds,
      activeId: gesture.activeId,
      overId: gesture.overId,
      horizontalOffset: gesture.horizontalOffset,
      outlineRootId: current.outlineRootId
    });
    planRef.current = nextPlan;
    targetScopeRef.current = nextPlan ? gesture.sourceScope : null;
    setPlan(nextPlan);
    setTargetScope(targetScopeRef.current);
    if (nextPlan) {
      setAnnouncement(
        `Move preview at depth ${nextPlan.depth + 1}. Press Space or Enter to drop.`
      );
    }
  };
  const finishKeyboard = (cancelled: boolean) => {
    const gesture = keyboardRef.current;
    if (!gesture) return;
    keyboardRef.current = null;
    const committedPlan = planRef.current;
    planRef.current = null;
    targetScopeRef.current = null;
    setPlan(null);
    setTargetScope(null);
    setDraggedRootIds([]);
    setDraggedTotal(0);
    setPointer(null);
    suppressClickRef.current = gesture.activeId;
    if (cancelled) {
      setAnnouncement("Keyboard move cancelled.");
      return;
    }
    if (committedPlan) {
      setAnnouncement("Dropped note.");
      void inputRef.current.moveNodes(committedPlan.moves);
    } else {
      setAnnouncement("No valid move target was selected.");
    }
    requestAnimationFrame(() => gesture.sourceButton.focus());
  };
  const keyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    activeId: string
  ) => {
    const activation = event.key === " " || event.key === "Enter";
    let gesture = keyboardRef.current;
    if (!gesture && !activation) return;
    event.preventDefault();
    event.stopPropagation();
    if (!gesture) {
      if (!input.enabled) return;
      const sourceScope = event.currentTarget.closest<HTMLElement>(
        ".notes-outline[data-outline-root-id]"
      );
      if (!sourceScope) return;
      const { rootIds, total } = dragRoots(activeId);
      const rectangle = event.currentTarget.getBoundingClientRect();
      gesture = {
        activeId,
        rootIds,
        sourceScope,
        sourceButton: event.currentTarget,
        total,
        overId: activeId,
        horizontalOffset: 0
      };
      keyboardRef.current = gesture;
      suppressClickRef.current = activeId;
      setDraggedRootIds(rootIds);
      setDraggedTotal(total);
      setPointer({
        x: rectangle.left + rectangle.width / 2,
        y: rectangle.top + rectangle.height / 2
      });
      const label = input.labelForId(activeId) || "Untitled";
      setAnnouncement(
        `Picked up ${label}. Use arrow keys to move, Space or Enter to drop, Escape to cancel.`
      );
      return;
    }
    if (gesture.activeId !== activeId) return;
    if (activation) {
      finishKeyboard(false);
      return;
    }
    if (event.key === "Escape") {
      finishKeyboard(true);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      gesture.horizontalOffset += event.key === "ArrowRight"
        ? OUTLINE_KEYBOARD_INDENT
        : -OUTLINE_KEYBOARD_INDENT;
      keyboardPlan(gesture);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const forest = new Set(input.nodes
      .filter((node) => {
        const roots = new Set(gesture!.rootIds);
        const byId = new Map(input.nodes.map((candidate) => [
          candidate.id,
          candidate
        ]));
        return isInSubtree(node, roots, byId);
      })
      .map((node) => node.id));
    const currentIndex = input.visibleNodes.findIndex(
      (node) => node.id === gesture!.overId
    );
    const activeIndex = input.visibleNodes.findIndex(
      (node) => node.id === gesture!.activeId
    );
    const startIndex = currentIndex >= 0 ? currentIndex : activeIndex;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    for (
      let index = startIndex + direction;
      index >= 0 && index < input.visibleNodes.length;
      index += direction
    ) {
      const candidate = input.visibleNodes[index];
      if (!forest.has(candidate.id)) {
        gesture.overId = candidate.id;
        keyboardPlan(gesture);
        break;
      }
    }
  };
  const consumeClick = (nodeId: string): boolean => {
    if (suppressClickRef.current !== nodeId) return false;
    suppressClickRef.current = null;
    return true;
  };
  const rowProps = (nodeId: string) => ({
    dragSource: dragSourceIds.has(nodeId),
    onDragHandlePointerDown: (
      event: ReactPointerEvent<HTMLButtonElement>
    ) => start(event, nodeId),
    onDragHandleKeyDown: (
      event: ReactKeyboardEvent<HTMLButtonElement>
    ) => keyDown(event, nodeId),
    consumeDragHandleClick: () => consumeClick(nodeId)
  });

  const preview = pointer ? {
    ...pointer,
    labels: draggedRootIds.map((id) => input.labelForId(id)),
    total: draggedTotal
  } : null;
  const dropTarget = plan && targetScope ? { plan, scope: targetScope } : null;
  return { announcement, dropTarget, plan, preview, rowProps };
}

const OUTLINE_KEYBOARD_INDENT = 36;
