import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { OutlineDropPlan } from "./outlineDragPlan";
import type {
  DragGesture,
  KeyboardGesture,
  OutlineDragEngine,
  OutlineDragHost,
  UseOutlineDragInput
} from "./outlineDragEngine";

const ACTIVATION_DISTANCE = 4;
const NO_ROOT_IDS: readonly string[] = [];
const NO_DRAG_SOURCES: ReadonlySet<string> = new Set();

// Nothing can be dragged before a pointer lands on a bullet, so drop planning,
// hit testing and the keyboard gesture live outside the first-paint bundle.
// The pane fetches the chunk as soon as it mounts, and a gesture that somehow
// beats the fetch waits for it instead of being dropped.
type DragEngineModule = typeof import("./outlineDragEngine");
let dragEngineLoad: Promise<DragEngineModule> | null = null;
function loadDragEngine(): Promise<DragEngineModule> {
  dragEngineLoad ??= import("./outlineDragEngine");
  return dragEngineLoad;
}

export function useOutlineDrag(input: UseOutlineDragInput) {
  const inputRef = useRef(input);
  const gestureRef = useRef<DragGesture | null>(null);
  const keyboardRef = useRef<KeyboardGesture | null>(null);
  const planRef = useRef<OutlineDropPlan | null>(null);
  const targetScopeRef = useRef<HTMLElement | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const engineRef = useRef<OutlineDragEngine | null>(null);
  const hostRef = useRef<OutlineDragHost | null>(null);
  const [plan, setPlan] = useState<OutlineDropPlan | null>(null);
  const [targetScope, setTargetScope] = useState<HTMLElement | null>(null);
  const [draggedRootIds, setDraggedRootIds] = useState(NO_ROOT_IDS);
  const [dragSourceIds, setDragSourceIds] = useState(NO_DRAG_SOURCES);
  const [draggedTotal, setDraggedTotal] = useState(0);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  inputRef.current = input;
  planRef.current = plan;
  targetScopeRef.current = targetScope;

  const clearVisuals = useCallback(() => {
    planRef.current = null;
    targetScopeRef.current = null;
    setPlan(null);
    setTargetScope(null);
    setDraggedRootIds(NO_ROOT_IDS);
    setDragSourceIds(NO_DRAG_SOURCES);
    setDraggedTotal(0);
    setPointer(null);
  }, []);
  hostRef.current ??= {
    inputRef,
    keyboardRef,
    planRef,
    targetScopeRef,
    suppressClickRef,
    setPlan,
    setTargetScope,
    setDraggedRootIds,
    setDraggedTotal,
    setDragSourceIds,
    setPointer,
    setAnnouncement,
    clearVisuals
  };
  const withEngine = useCallback((run: (engine: OutlineDragEngine) => void) => {
    if (engineRef.current) {
      run(engineRef.current);
      return;
    }
    void loadDragEngine().then((module) => {
      const host = hostRef.current;
      if (!host) return;
      engineRef.current ??= module.createOutlineDragEngine(host);
      run(engineRef.current);
    });
  }, []);

  useEffect(() => {
    withEngine(() => {});
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
      }
      event.preventDefault();
      const { clientX, clientY, target } = event;
      withEngine((engine) => {
        if (gestureRef.current !== gesture) return;
        engine.trackPointer(gesture, clientX, clientY, target);
      });
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
  }, [clearVisuals, withEngine]);

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
    // Which rows the drag would carry is decided the moment the pointer lands,
    // so the selection is read here; walking their subtrees waits until the
    // pointer has actually moved far enough to be a drag.
    const selectionOwnsActive = input.selection.selectedIds.includes(activeId);
    gestureRef.current = {
      pointerId: event.pointerId,
      activeId,
      rootIds: selectionOwnsActive
        ? [...input.selection.selectedRootIds]
        : [activeId],
      selectedCount: selectionOwnsActive
        ? input.selection.selectedIds.length
        : null,
      startX: event.clientX,
      startY: event.clientY,
      captureTarget: event.currentTarget,
      sourceScope,
      total: null,
      dragging: false
    };
  };
  const keyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    activeId: string
  ) => {
    const activation = event.key === " " || event.key === "Enter";
    if (!keyboardRef.current && !activation) return;
    event.preventDefault();
    event.stopPropagation();
    // React clears currentTarget once the handler returns, so the button is
    // read now; the rest of the gesture runs against the loaded engine.
    const { key } = event;
    const button = event.currentTarget;
    withEngine((engine) => engine.keyDown(key, activeId, button));
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
