import {
  closestCenter,
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
import type { CrossPaneOrdinaryDropProjection } from "./notesCrossPaneDrag";

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
  containsPoint(point: { readonly x: number; readonly y: number }): boolean;
  draggedRootIds(): readonly string[];
  projectExternal(
    event: DragMoveEvent,
    sourceRootIds: readonly string[]
  ): CrossPaneOrdinaryDropProjection | null;
  clearExternalPreview(): void;
  commitCrossPane(
    destinationPaneId: NotesPaneId,
    projection: CrossPaneOrdinaryDropProjection
  ): void;
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

function rawAnnouncementArgs<T extends {
  readonly active: DragStartEvent["active"];
  readonly over?: DragMoveEvent["over"];
}>(args: T): T {
  return {
    ...args,
    active: { ...args.active, id: rawId(args.active.id) },
    ...(args.over === undefined
      ? {}
      : {
          over: args.over
            ? { ...args.over, id: rawId(args.over.id) }
            : null
        })
  };
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
  const collisionPaneIdRef = useRef<NotesPaneId | null>(null);
  const crossDropRef = useRef<{
    readonly destinationPaneId: NotesPaneId;
    readonly projection: CrossPaneOrdinaryDropProjection;
  } | null>(null);
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
        activeAdapter()?.announcements.onDragStart(
          rawAnnouncementArgs(args)
        ),
      onDragOver: (args) =>
        activeAdapter()?.announcements.onDragOver(
          rawAnnouncementArgs(args)
        ),
      onDragEnd: (args) =>
        activeAdapter()?.announcements.onDragEnd(
          rawAnnouncementArgs(args)
        ),
      onDragCancel: (args) =>
        activeAdapter()?.announcements.onDragCancel(
          rawAnnouncementArgs(args)
        )
    }),
    []
  );
  const collisionDetection: CollisionDetection = (args) => {
    const source = activeAdapter();
    if (!source) return [];
    if (args.pointerCoordinates === null) {
      collisionPaneIdRef.current = source.paneId;
      return source.collisionDetection(args);
    }
    const destination = [...adaptersRef.current.values()].find((adapter) =>
      adapter.containsPoint(args.pointerCoordinates!)
    );
    if (destination) {
      collisionPaneIdRef.current = destination.paneId;
      return destination.collisionDetection(args);
    }
    const nearest = closestCenter(args)[0];
    const nearestPaneId = nearest
      ? (parseNotesPaneDndId(String(nearest.id))?.paneId ?? source.paneId)
      : source.paneId;
    collisionPaneIdRef.current = nearestPaneId;
    return (
      adaptersRef.current.get(nearestPaneId)?.collisionDetection(args) ??
      source.collisionDetection(args)
    );
  };
  const clearCrossDrop = () => {
    const previous = crossDropRef.current;
    if (previous) {
      adaptersRef.current
        .get(previous.destinationPaneId)
        ?.clearExternalPreview();
    }
    crossDropRef.current = null;
  };
  const routeDragMove = (event: DragMoveEvent) => {
    const source = activeAdapter();
    if (!source) return;
    const overPaneId = event.over
      ? parseNotesPaneDndId(String(event.over.id))?.paneId
      : null;
    const destinationPaneId =
      overPaneId ?? collisionPaneIdRef.current ?? source.paneId;
    if (destinationPaneId === source.paneId) {
      clearCrossDrop();
      source.onDragMove(rawMoveEvent(event, source.paneId));
      return;
    }
    source.clearExternalPreview();
    clearCrossDrop();
    const destination = adaptersRef.current.get(destinationPaneId);
    const projection = destination?.projectExternal(
      rawMoveEvent(event, destinationPaneId),
      source.draggedRootIds()
    );
    crossDropRef.current =
      destination && projection ? { destinationPaneId, projection } : null;
  };

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
          collisionPaneIdRef.current = activePaneIdRef.current;
          crossDropRef.current = null;
          activeAdapter()?.onDragStart(rawStartEvent(event));
        }}
        onDragMove={routeDragMove}
        onDragOver={routeDragMove}
        onDragCancel={() => {
          clearCrossDrop();
          activeAdapter()?.onDragCancel();
          activePaneIdRef.current = null;
          collisionPaneIdRef.current = null;
        }}
        onDragEnd={(event) => {
          const source = activeAdapter();
          const crossDrop = crossDropRef.current;
          if (source && crossDrop) {
            source.commitCrossPane(
              crossDrop.destinationPaneId,
              crossDrop.projection
            );
            adaptersRef.current
              .get(crossDrop.destinationPaneId)
              ?.clearExternalPreview();
          } else if (source) {
            source.onDragEnd(rawEndEvent(event, source.paneId));
          }
          crossDropRef.current = null;
          activePaneIdRef.current = null;
          collisionPaneIdRef.current = null;
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
