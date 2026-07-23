import { useSortable } from "@dnd-kit/sortable";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactElement,
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef
} from "react";
import type { NoteId, NoteMarkerKind } from "../../domain/notes";

export type OutlineSortableHandleValue = {
  readonly attributes?: ReturnType<typeof useSortable>["attributes"];
  readonly listeners: ReturnType<typeof useSortable>["listeners"];
  readonly setActivatorNodeRef: ReturnType<
    typeof useSortable
  >["setActivatorNodeRef"];
};

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
  readonly blockDragActivation?: boolean;
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

const MemoizedOutlineSortableEditor = memo(
  function MemoizedOutlineSortableEditor({
    editor
  }: {
    readonly editor: ReactElement;
  }) {
    return editor;
  },
  (previous, next) => {
    const equal =
      previous.editor.type === next.editor.type &&
      previous.editor.key === next.editor.key &&
      shallowObjectIs(
        previous.editor.props as Readonly<Record<string, unknown>>,
        next.editor.props as Readonly<Record<string, unknown>>
      );
    return equal;
  }
);

const OUTLINE_SHELL_PRIMITIVE_KEYS = [
  "nodeId",
  "disabled",
  "blockDragActivation",
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

function shallowNullableObjectIs(
  previous: object | undefined,
  next: object | undefined
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return shallowObjectIs(
    previous as Readonly<Record<string, unknown>>,
    next as Readonly<Record<string, unknown>>
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
      // The shell owns the disabled boundary. Keeping the dnd hook mounted
      // with a stable option prevents a workspace-wide loading transition from
      // replacing every handle's context value and invalidating each editor.
      disabled: false,
      attributes: {
        role: "button",
        roleDescription: "sortable note",
        tabIndex: 0
      }
    });
    const shellRootRef = useRef<HTMLDivElement | null>(null);
    const sortableRootRef = useRef(sortable.setNodeRef);
    sortableRootRef.current = sortable.setNodeRef;
    const setShellRootRef = useCallback((node: HTMLDivElement | null) => {
      shellRootRef.current = node;
      sortableRootRef.current(node);
    }, []);
    const sortableHandleValueRef = useRef<OutlineSortableHandleValue | null>(
      null
    );
    const attributes = sortable.attributes;
    const listeners = sortable.listeners;
    const previous = sortableHandleValueRef.current;
    if (
      previous === null ||
      !shallowNullableObjectIs(previous.attributes, attributes) ||
      !shallowNullableObjectIs(previous.listeners, listeners) ||
      previous.setActivatorNodeRef !== sortable.setActivatorNodeRef
    ) {
      sortableHandleValueRef.current = {
        attributes,
        listeners,
        setActivatorNodeRef: sortable.setActivatorNodeRef
      };
    }
    useLayoutEffect(() => {
      const root = shellRootRef.current;
      if (!root) return;
      const activator = root.querySelector<HTMLElement>(
        '[data-sortable-activator="true"]'
      );
      if (!activator) return;
      for (const [key, value] of Object.entries(sortable.attributes ?? {})) {
        const attributeName = key === "tabIndex" ? "tabindex" : key;
        if (props.disabled || value === undefined || value === false) {
          activator.removeAttribute(attributeName);
        } else {
          activator.setAttribute(attributeName, String(value));
        }
      }
    }, [props.disabled, sortable.attributes]);
    return (
      <OutlineSortableHandleContext.Provider
        value={sortableHandleValueRef.current!}
      >
        <div
          ref={setShellRootRef}
          onPointerDownCapture={
            props.blockDragActivation
              ? (event) => event.stopPropagation()
              : undefined
          }
          onKeyDownCapture={
            props.blockDragActivation
              ? (event) => event.stopPropagation()
              : undefined
          }
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
          <MemoizedOutlineSortableEditor editor={props.editor} />
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
      {...(enabled ? sortable.attributes ?? {} : {})}
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
