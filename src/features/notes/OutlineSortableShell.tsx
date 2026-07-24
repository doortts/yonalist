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
  useMemo,
  useRef
} from "react";
import type { NoteId, NoteMarkerKind } from "../../domain/notes";

export type OutlineSortableHandleValue = {
  readonly attributes?: ReturnType<typeof useSortable>["attributes"];
  readonly listeners: ReturnType<typeof useSortable>["listeners"];
  readonly setActivatorNodeRef: ReturnType<
    typeof useSortable
  >["setActivatorNodeRef"];
  readonly isDragDisabled: () => boolean;
};

type SortableResult = ReturnType<typeof useSortable>;

export interface OutlineSortableController {
  readonly attributes?: SortableResult["attributes"];
  readonly listeners: SortableResult["listeners"];
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly setActivatorNodeRef: (node: HTMLElement | null) => void;
  readonly isDragDisabled: () => boolean;
  readonly snapshot: {
    attributes?: SortableResult["attributes"];
    listeners: SortableResult["listeners"];
    isDragging: boolean;
    transform: SortableResult["transform"];
    transition: SortableResult["transition"];
    disabled: boolean;
    root: HTMLElement | null;
    suppressDragPresentation: boolean;
  };
  updateRuntime(result: SortableResult, disabled: boolean): void;
}

export function createOutlineSortableController(): OutlineSortableController {
  let setNodeRefCurrent: SortableResult["setNodeRef"] = () => undefined;
  let setActivatorNodeRefCurrent: SortableResult["setActivatorNodeRef"] = () =>
    undefined;
  const rawListenersRef: { current: SortableResult["listeners"] } = {
    current: undefined,
  };
  const listenerCache = new Map<
    string | symbol,
    (...args: never[]) => unknown
  >();
  const listeners: NonNullable<SortableResult["listeners"]> = new Proxy(
    {} as NonNullable<SortableResult["listeners"]>,
    {
      get: (_target, property: string | symbol) => {
        let wrapper = listenerCache.get(property);
        if (!wrapper) {
          wrapper = (...args: never[]) => {
            const listener = rawListenersRef.current?.[property as string];
            return typeof listener === "function"
              ? Reflect.apply(listener, undefined, args)
              : undefined;
          };
          listenerCache.set(property, wrapper);
        }
        return wrapper;
      },
      ownKeys: () => Object.keys(rawListenersRef.current ?? {}),
      getOwnPropertyDescriptor: (
        _target,
        property: string | symbol,
      ): PropertyDescriptor => ({
        configurable: true,
        enumerable: true,
        value: listeners[property as keyof typeof listeners],
      }),
    },
  );
  const snapshot: OutlineSortableController["snapshot"] = {
    attributes: undefined,
    listeners,
    isDragging: false,
    transform: null,
    transition: undefined,
    disabled: false,
    root: null,
    suppressDragPresentation: false,
  };
  const controller: OutlineSortableController = {
    attributes: undefined,
    listeners,
    setNodeRef: (node) => {
      snapshot.root = node;
      setNodeRefCurrent(node);
    },
    setActivatorNodeRef: (node) => setActivatorNodeRefCurrent(node),
    isDragDisabled: () => snapshot.disabled,
    snapshot,
    updateRuntime(result, disabled) {
      setNodeRefCurrent = result.setNodeRef;
      setActivatorNodeRefCurrent = result.setActivatorNodeRef;
      rawListenersRef.current = result.listeners;
      snapshot.attributes = result.attributes;
      snapshot.listeners = listeners;
      snapshot.isDragging = result.isDragging;
      snapshot.transform = result.transform;
      snapshot.transition = result.transition;
      snapshot.disabled = disabled;
    },
  };
  return controller;
}

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
  readonly controller: OutlineSortableController;
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
  "controller",
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

export interface OutlineSortableRuntimeProps {
  readonly controller: OutlineSortableController;
  readonly nodeId: NoteId;
  readonly sortableId?: string;
  readonly disabled: boolean;
  readonly suppressDragPresentation: boolean;
}

export const OutlineSortableRuntime = memo(function OutlineSortableRuntime({
  controller,
  nodeId,
  sortableId,
  disabled,
  suppressDragPresentation,
}: OutlineSortableRuntimeProps) {
  const sortable = useSortable({
    id: sortableId ?? nodeId,
    disabled: false,
    attributes: {
      role: "button",
      roleDescription: "sortable note",
      tabIndex: 0,
    },
  });
  controller.updateRuntime(sortable, disabled);
  controller.snapshot.suppressDragPresentation = suppressDragPresentation;
  useLayoutEffect(() => {
    const root = controller.snapshot.root;
    if (!root) return;
    root.style.transform =
      !suppressDragPresentation && sortable.transform
        ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0) scaleX(${sortable.transform.scaleX}) scaleY(${sortable.transform.scaleY})`
        : "";
    root.style.transition = suppressDragPresentation
      ? ""
      : (sortable.transition ?? "");
    if (suppressDragPresentation || !sortable.isDragging) {
      delete root.dataset.dragging;
    } else {
      root.dataset.dragging = "true";
    }
    const activator = root.querySelector<HTMLElement>(
      '[data-sortable-activator="true"]',
    );
    if (!activator) return;
    for (const [key, value] of Object.entries(sortable.attributes ?? {})) {
      const attributeName = key === "tabIndex" ? "tabindex" : key;
      if (disabled || value === undefined || value === false) {
        activator.removeAttribute(attributeName);
      } else {
        activator.setAttribute(attributeName, String(value));
      }
    }
  }, [
    controller,
    disabled,
    sortable.attributes,
    sortable.isDragging,
    sortable.transform,
    sortable.transition,
    suppressDragPresentation,
  ]);
  return null;
});

export const OutlineSortableShell = memo(function OutlineSortableShell(
  props: OutlineSortableShellProps,
) {
  props.controller.snapshot.suppressDragPresentation =
    props.suppressDragPresentation;
  const sortableSnapshot = props.controller.snapshot;
  const shellRootRef = useRef<HTMLDivElement | null>(null);
  const setShellRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      shellRootRef.current = node;
      props.controller.setNodeRef(node);
    },
    [props.controller],
  );
  const handleValue = useMemo<OutlineSortableHandleValue>(() => {
    const controller = props.controller;
    return {
      get attributes() {
        return controller.snapshot.attributes;
      },
      listeners: controller.listeners,
      setActivatorNodeRef: controller.setActivatorNodeRef,
      isDragDisabled: controller.isDragDisabled,
    };
  }, [props.controller]);
  return (
    <OutlineSortableHandleContext.Provider value={handleValue}>
      <div
        ref={setShellRootRef}
        className={props.className}
        data-outline-id={props.nodeId}
        data-completed={props.completed ? "true" : undefined}
        data-marker-kind={props.markerKind}
        data-empty-bullet={props.emptyBullet ? "true" : undefined}
        data-dragging={
          !props.suppressDragPresentation && sortableSnapshot.isDragging
            ? "true"
            : undefined
        }
        data-guide-end-id={props.guideEndId ?? undefined}
        data-selected={props.selected ? "true" : undefined}
        data-range-selected={props.rangeSelected ? "true" : undefined}
        data-notes-attachment-target={props.attachmentTargetId ?? undefined}
        data-image-drop-active={props.imageDropActive ? "true" : undefined}
        style={
          {
            "--notes-depth": props.depth,
            transform:
              !props.suppressDragPresentation && sortableSnapshot.transform
                ? `translate3d(${sortableSnapshot.transform.x}px, ${sortableSnapshot.transform.y}px, 0) scaleX(${sortableSnapshot.transform.scaleX}) scaleY(${sortableSnapshot.transform.scaleY})`
                : undefined,
            transition: props.suppressDragPresentation
              ? undefined
              : sortableSnapshot.transition,
          } as CSSProperties
        }
      >
        <MemoizedOutlineSortableEditor editor={props.editor} />
      </div>
    </OutlineSortableHandleContext.Provider>
  );
}, areOutlineSortableShellPropsEqual);

export interface OutlineSortableHandleProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "ref"
> {
  readonly enabled: boolean;
}

export const OutlineSortableHandle = memo(function OutlineSortableHandle({
  enabled,
  onKeyDown,
  ...buttonProps
}: OutlineSortableHandleProps) {
  const sortable = useOutlineSortableHandle();
  const dragActive = enabled && !sortable.isDragDisabled();
  const { onKeyDown: onSortableKeyDown, ...listenerProps } = enabled
    ? (sortable.listeners ?? {})
    : {};
  const guardedListenerProps = Object.fromEntries(
    Object.entries(listenerProps).map(([name, listener]) => [
      name,
      (event: unknown) => {
        if (!sortable.isDragDisabled()) {
          (listener as (event: unknown) => void)(event);
        }
      },
    ]),
  ) as typeof listenerProps;
  return (
    <button
      data-sortable-activator="true"
      {...(dragActive ? (sortable.attributes ?? {}) : {})}
      {...guardedListenerProps}
      {...buttonProps}
      ref={sortable.setActivatorNodeRef}
      onKeyDown={(event) => {
        if (enabled && !sortable.isDragDisabled()) {
          onSortableKeyDown?.(event);
        }
        onKeyDown?.(event);
      }}
    />
  );
});
