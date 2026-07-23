import { useSortable } from "@dnd-kit/sortable";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactElement,
  createContext,
  memo,
  useContext
} from "react";
import type { NoteId, NoteMarkerKind } from "../../domain/notes";

export type OutlineSortableHandleValue = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

const OutlineSortableHandleContext =
  createContext<OutlineSortableHandleValue | null>(null);

export function useOutlineSortableHandle(): OutlineSortableHandleValue {
  const value = useContext(OutlineSortableHandleContext);
  if (!value) {
    throw new Error("OutlineSortableHandle requires OutlineSortableShell.");
  }
  return value;
}

export interface OutlineSortableShellProps {
  readonly nodeId: NoteId;
  readonly disabled: boolean;
  readonly depth: number;
  readonly suppressDragPresentation: boolean;
  readonly className: string;
  readonly completed: boolean;
  readonly markerKind: NoteMarkerKind;
  readonly emptyBullet: boolean;
  readonly guideEndId: NoteId | null;
  readonly selected: boolean;
  readonly rangeSelected: boolean;
  readonly attachmentTargetId: NoteId | null;
  readonly imageDropActive: boolean;
  readonly editor: ReactElement;
}

const OUTLINE_SHELL_PRIMITIVE_KEYS = [
  "nodeId",
  "disabled",
  "depth",
  "suppressDragPresentation",
  "className",
  "completed",
  "markerKind",
  "emptyBullet",
  "guideEndId",
  "selected",
  "rangeSelected",
  "attachmentTargetId",
  "imageDropActive"
] as const satisfies readonly (keyof OutlineSortableShellProps)[];

function shallowObjectIs(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(next, key) &&
        Object.is(previous[key], next[key])
    )
  );
}

export function areOutlineSortableShellPropsEqual(
  previous: OutlineSortableShellProps,
  next: OutlineSortableShellProps
): boolean {
  return (
    OUTLINE_SHELL_PRIMITIVE_KEYS.every((key) =>
      Object.is(previous[key], next[key])
    ) &&
    previous.editor.type === next.editor.type &&
    previous.editor.key === next.editor.key &&
    shallowObjectIs(
      previous.editor.props as Readonly<Record<string, unknown>>,
      next.editor.props as Readonly<Record<string, unknown>>
    )
  );
}

export const OutlineSortableShell = memo(
  function OutlineSortableShell(props: OutlineSortableShellProps) {
    const sortable = useSortable({
      id: props.nodeId,
      disabled: props.disabled,
      attributes: {
        role: "button",
        roleDescription: "sortable note",
        tabIndex: 0
      }
    });
    return (
      <OutlineSortableHandleContext.Provider
        value={{
          attributes: sortable.attributes,
          listeners: sortable.listeners,
          setActivatorNodeRef: sortable.setActivatorNodeRef
        }}
      >
        <div
          ref={sortable.setNodeRef}
          className={props.className}
          data-outline-id={props.nodeId}
          data-completed={props.completed ? "true" : undefined}
          data-marker-kind={props.markerKind}
          data-empty-bullet={props.emptyBullet ? "true" : undefined}
          data-dragging={
            !props.suppressDragPresentation && sortable.isDragging
              ? "true"
              : undefined
          }
          data-guide-end-id={props.guideEndId ?? undefined}
          data-selected={props.selected ? "true" : undefined}
          data-range-selected={props.rangeSelected ? "true" : undefined}
          data-notes-attachment-target={
            props.attachmentTargetId ?? undefined
          }
          data-image-drop-active={
            props.imageDropActive ? "true" : undefined
          }
          style={
            {
              "--notes-depth": props.depth,
              transform:
                !props.suppressDragPresentation && sortable.transform
                  ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0) scaleX(${sortable.transform.scaleX}) scaleY(${sortable.transform.scaleY})`
                  : undefined,
              transition: props.suppressDragPresentation
                ? undefined
                : sortable.transition
            } as CSSProperties
          }
        >
          {props.editor}
        </div>
      </OutlineSortableHandleContext.Provider>
    );
  },
  areOutlineSortableShellPropsEqual
);

export interface OutlineSortableHandleProps
  extends Omit<ComponentPropsWithoutRef<"button">, "ref"> {
  readonly enabled: boolean;
}

export const OutlineSortableHandle = memo(function OutlineSortableHandle({
  enabled,
  onKeyDown,
  ...buttonProps
}: OutlineSortableHandleProps) {
  const sortable = useOutlineSortableHandle();
  const {
    onKeyDown: onSortableKeyDown,
    ...listenerProps
  } = enabled ? (sortable.listeners ?? {}) : {};
  return (
    <button
      {...(enabled ? sortable.attributes : {})}
      {...listenerProps}
      {...buttonProps}
      ref={sortable.setActivatorNodeRef}
      onKeyDown={(event) => {
        onSortableKeyDown?.(event);
        onKeyDown?.(event);
      }}
    />
  );
});
