import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef
} from "react";
import type { NotesPaneId } from "./notesPaneSession";
import { parseNotesPaneDndId } from "./notesPaneDndId";

const screenReaderInstructions = {
  draggable:
    "To pick up a note, press Space or Enter. Use Arrow Up and Arrow Down to choose a visible row. Press Space or Enter to drop, or Escape to cancel."
};
const pointerSensorOptions = { activationConstraint: { distance: 4 } };
const keyboardSensorOptions = { coordinateGetter: sortableKeyboardCoordinates };

export interface NotesPaneDndAdapter {
  readonly paneId: NotesPaneId;
  readonly announcements: Announcements;
  readonly collisionDetection: CollisionDetection;
  readonly measureDragOverlay: (node: HTMLElement) => DOMRect;
  onDragStart(event: DragStartEvent): void;
  onDragMove(event: DragMoveEvent): void;
  onDragCancel(): void;
  onDragEnd(event: DragEndEvent): void;
}

interface NotesSplitDndBridge {
  register(adapter: NotesPaneDndAdapter): () => void;
}

const NotesSplitDndBridgeContext =
  createContext<NotesSplitDndBridge | null>(null);

function rawId(value: string | number): string | number {
  return parseNotesPaneDndId(String(value))?.nodeId ?? value;
}

function samePaneOver(
  event: DragMoveEvent | DragEndEvent,
  paneId: NotesPaneId
): DragMoveEvent["over"] {
  const parsed = event.over
    ? parseNotesPaneDndId(String(event.over.id))
    : null;
  return parsed?.paneId === paneId && parsed.nodeId !== null
    ? { ...event.over!, id: parsed.nodeId }
    : null;
}

function rawStartEvent(event: DragStartEvent): DragStartEvent {
  return { ...event, active: { ...event.active, id: rawId(event.active.id) } };
}

function rawMoveEvent(
  event: DragMoveEvent,
  paneId: NotesPaneId
): DragMoveEvent {
  return {
    ...event,
    active: { ...event.active, id: rawId(event.active.id) },
    over: samePaneOver(event, paneId)
  };
}

function rawEndEvent(
  event: DragEndEvent,
  paneId: NotesPaneId
): DragEndEvent {
  return {
    ...event,
    active: { ...event.active, id: rawId(event.active.id) },
    over: samePaneOver(event, paneId)
  };
}

function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, pointerSensorOptions),
    useSensor(KeyboardSensor, keyboardSensorOptions)
  );
}

export function NotesSplitDndContext({ children }: PropsWithChildren) {
  const adaptersRef = useRef(
    new Map<NotesPaneId, NotesPaneDndAdapter>()
  );
  const activePaneIdRef = useRef<NotesPaneId | null>(null);
  const sensors = useDndSensors();
  const bridge = useMemo<NotesSplitDndBridge>(
    () => ({
      register(adapter) {
        adaptersRef.current.set(adapter.paneId, adapter);
        return () => {
          if (adaptersRef.current.get(adapter.paneId) === adapter) {
            adaptersRef.current.delete(adapter.paneId);
          }
        };
      }
    }),
    []
  );
  const activeAdapter = () =>
    activePaneIdRef.current
      ? adaptersRef.current.get(activePaneIdRef.current)
      : undefined;
  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: (args) =>
        activeAdapter()?.announcements.onDragStart(args),
      onDragOver: (args) =>
        activeAdapter()?.announcements.onDragOver(args),
      onDragEnd: (args) =>
        activeAdapter()?.announcements.onDragEnd(args),
      onDragCancel: (args) =>
        activeAdapter()?.announcements.onDragCancel(args)
    }),
    []
  );
  const collisionDetection: CollisionDetection = (args) =>
    activeAdapter()?.collisionDetection(args) ?? [];

  return (
    <NotesSplitDndBridgeContext.Provider value={bridge}>
      <DndContext
        accessibility={{ announcements, screenReaderInstructions }}
        collisionDetection={collisionDetection}
        measuring={{
          dragOverlay: {
            measure: (node) =>
              activeAdapter()?.measureDragOverlay(node) ??
              node.getBoundingClientRect()
          }
        }}
        sensors={sensors}
        onDragStart={(event) => {
          const parsed = parseNotesPaneDndId(String(event.active.id));
          activePaneIdRef.current = parsed?.paneId ?? null;
          activeAdapter()?.onDragStart(rawStartEvent(event));
        }}
        onDragMove={(event) => {
          const adapter = activeAdapter();
          if (adapter) adapter.onDragMove(rawMoveEvent(event, adapter.paneId));
        }}
        onDragOver={(event) => {
          const adapter = activeAdapter();
          if (adapter) adapter.onDragMove(rawMoveEvent(event, adapter.paneId));
        }}
        onDragCancel={() => {
          activeAdapter()?.onDragCancel();
          activePaneIdRef.current = null;
        }}
        onDragEnd={(event) => {
          const adapter = activeAdapter();
          if (adapter) adapter.onDragEnd(rawEndEvent(event, adapter.paneId));
          activePaneIdRef.current = null;
        }}
      >
        {children}
      </DndContext>
    </NotesSplitDndBridgeContext.Provider>
  );
}

export function NotesPaneDndBoundary({
  adapter,
  children,
  overlay
}: {
  readonly adapter: NotesPaneDndAdapter;
  readonly children: ReactNode;
  readonly overlay?: ReactNode;
}) {
  const bridge = useContext(NotesSplitDndBridgeContext);
  useEffect(
    () => bridge?.register(adapter),
    [adapter, bridge]
  );
  if (bridge) {
    return (
      <>
        {children}
        {overlay}
      </>
    );
  }
  return (
    <LocalNotesPaneDndBoundary adapter={adapter} overlay={overlay}>
      {children}
    </LocalNotesPaneDndBoundary>
  );
}

function LocalNotesPaneDndBoundary({
  adapter,
  children,
  overlay
}: {
  readonly adapter: NotesPaneDndAdapter;
  readonly children: ReactNode;
  readonly overlay?: ReactNode;
}) {
  const sensors = useDndSensors();
  return (
    <DndContext
      accessibility={{
        announcements: adapter.announcements,
        screenReaderInstructions
      }}
      collisionDetection={adapter.collisionDetection}
      measuring={{ dragOverlay: { measure: adapter.measureDragOverlay } }}
      sensors={sensors}
      onDragStart={(event) => adapter.onDragStart(rawStartEvent(event))}
      onDragMove={(event) =>
        adapter.onDragMove(rawMoveEvent(event, adapter.paneId))
      }
      onDragOver={(event) =>
        adapter.onDragMove(rawMoveEvent(event, adapter.paneId))
      }
      onDragCancel={adapter.onDragCancel}
      onDragEnd={(event) =>
        adapter.onDragEnd(rawEndEvent(event, adapter.paneId))
      }
    >
      {children}
      {overlay}
    </DndContext>
  );
}
