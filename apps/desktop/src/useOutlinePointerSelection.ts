import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { focusOutlineEditor } from "./outlineFocus";
import type { useOutlineSelection } from "./useOutlineSelection";

interface MouseSelectionGesture {
  readonly pointerId: number;
  readonly anchorId: string;
  readonly scope: HTMLElement;
  promoted: boolean;
}

type OutlineSelection = ReturnType<typeof useOutlineSelection>;

const INTERACTIVE_SELECTOR =
  "button, a, [role='button'], [role='separator']";
const TEXT_SURFACE_SELECTOR =
  ".notes-node-title-field, .notes-node-note-field, .notes-image-node-content";

function rowIdFromTarget(target: EventTarget | null): string | null {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId ?? null
    : null;
}

function rowIdFromCoordinates(clientX: number, clientY: number): string | null {
  return typeof document.elementFromPoint === "function"
    ? rowIdFromTarget(document.elementFromPoint(clientX, clientY))
    : null;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element &&
    target.closest(INTERACTIVE_SELECTOR) !== null;
}

function isTextSurface(target: EventTarget | null): boolean {
  return target instanceof Element &&
    !isInteractiveTarget(target) &&
    target.closest(TEXT_SURFACE_SELECTOR) !== null;
}

export function useOutlinePointerSelection(
  selection: OutlineSelection,
  visibleNodes: readonly NoteView[]
) {
  const gestureRef = useRef<MouseSelectionGesture | null>(null);
  const visibleIdsRef = useRef<ReadonlySet<string>>(new Set());
  const headIdRef = useRef(selection.headId);
  visibleIdsRef.current = new Set(visibleNodes.map((node) => node.id));
  headIdRef.current = selection.headId;

  useEffect(() => {
    const retire = (event: globalThis.PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (!gesture.promoted || event.type !== "pointerup") return;
      window.setTimeout(() => {
        const headId = headIdRef.current;
        if (headId) focusOutlineEditor(gesture.scope, headId, "preserve");
      }, 0);
    };
    window.addEventListener("pointerup", retire, true);
    window.addEventListener("pointercancel", retire, true);
    return () => {
      window.removeEventListener("pointerup", retire, true);
      window.removeEventListener("pointercancel", retire, true);
    };
  }, []);

  const onPointerDownCapture = (
    event: ReactPointerEvent<HTMLOListElement>
  ) => {
    gestureRef.current = null;
    if (event.button !== 0 || !isTextSurface(event.target)) return;
    const anchorId = rowIdFromTarget(event.target);
    if (!anchorId || !visibleIdsRef.current.has(anchorId)) return;
    if (event.shiftKey) {
      event.preventDefault();
      selection.select(anchorId, true, false);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      selection.select(anchorId, false, true);
      return;
    }
    selection.beginPointer(anchorId);
    gestureRef.current = {
      pointerId: event.pointerId,
      anchorId,
      scope: event.currentTarget,
      promoted: false
    };
  };

  const onPointerMoveCapture = (
    event: ReactPointerEvent<HTMLOListElement>
  ) => {
    const gesture = gestureRef.current;
    if (
      !gesture ||
      event.pointerId !== gesture.pointerId ||
      event.buttons !== 1 ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }
    const targetId = rowIdFromTarget(event.target);
    const currentId = targetId === gesture.anchorId
      ? rowIdFromCoordinates(event.clientX, event.clientY) ?? targetId
      : targetId;
    if (
      !currentId ||
      !visibleIdsRef.current.has(currentId) ||
      (!gesture.promoted && currentId === gesture.anchorId)
    ) {
      return;
    }
    if (!gesture.promoted) {
      window.getSelection()?.removeAllRanges();
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && gesture.scope.contains(active)) {
        active.setSelectionRange(active.selectionStart, active.selectionStart);
        active.blur();
      }
      gesture.promoted = true;
    }
    selection.extend(gesture.anchorId, currentId);
    event.preventDefault();
  };

  return { onPointerDownCapture, onPointerMoveCapture };
}
