import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { NoteId } from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import type { OptimisticBackspaceGesture } from "./notesBackspaceGesture";
import {
  createNotesHeldBackspaceRepeatController,
  previousGraphemeBoundary,
  type NotesHeldBackspaceRepeatController,
} from "./notesHeldBackspaceRepeat";
import type { NotesPaneId } from "./notesPaneSession";
import {
  detectOutlineShortcutPlatform,
  resolveOutlineKey,
} from "./outlineKeyboard";
import type { FlattenedOutlineRow } from "./outlineTree";
import type {
  NotesActionsSlice,
  NotesNodeDraft,
  NotesStateSlice,
} from "./useNotesWorkspace";

function outlineTitleTextarea(
  root: ParentNode | null,
  nodeId: NoteId,
): HTMLTextAreaElement | null {
  const row = Array.from(
    root?.querySelectorAll<HTMLElement>("[data-outline-id]") ?? [],
  ).find((candidate) => candidate.dataset.outlineId === nodeId);
  return (
    row?.querySelector<HTMLTextAreaElement>("textarea.notes-node-title") ?? null
  );
}

function dispatchHeldBackspaceInput(
  target: HTMLTextAreaElement,
  value: string,
  caretUtf16: number,
): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (nativeValueSetter) {
    nativeValueSetter.call(target, value);
  } else {
    target.value = value;
  }
  target.setSelectionRange(caretUtf16, caretUtf16);
  target.dispatchEvent(
    typeof InputEvent === "function"
      ? new InputEvent("input", {
          bubbles: true,
          inputType: "deleteContentBackward",
        })
      : new Event("input", { bubbles: true }),
  );
}

interface NotesHeldBackspaceRepeatOptions {
  readonly paneId: NotesPaneId;
  readonly vaultRoot: string;
  readonly gesture: OptimisticBackspaceGesture | null;
  readonly bodyRows: readonly FlattenedOutlineRow[];
  readonly draftsByNodeId: Readonly<Record<NoteId, NotesNodeDraft>>;
  readonly stateSlice: NotesStateSlice;
  readonly visibleNodeIds: readonly NoteId[];
  readonly selectionVisibleNodeIds: readonly NoteId[];
  readonly actions: NotesActionsSlice["actions"];
  readonly getContentRoot: () => ParentNode | null;
}

export interface NotesHeldBackspaceRepeat {
  handleKeyDown(
    token: number,
    nodeId: NoteId,
    repeat: boolean,
  ): "native" | "consume";
  stop(): void;
}

export function useNotesHeldBackspaceRepeat(
  options: NotesHeldBackspaceRepeatOptions,
): NotesHeldBackspaceRepeat {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const routeRef = useRef<{
    token: number;
    focusNodeId: NoteId;
  } | null>(null);
  const repeatStepRef = useRef<() => boolean>(() => false);
  const controllerRef = useRef<NotesHeldBackspaceRepeatController | null>(
    null,
  );
  if (controllerRef.current === null) {
    controllerRef.current = createNotesHeldBackspaceRepeatController({
      repeat: () => repeatStepRef.current(),
    });
  }
  const controller = controllerRef.current;

  repeatStepRef.current = () => {
    const current = optionsRef.current;
    const gesture = current.gesture;
    const route = routeRef.current;
    if (
      gesture === null ||
      gesture.status !== "active" ||
      gesture.ownerPaneId !== current.paneId ||
      route === null ||
      route.token !== gesture.token
    ) {
      return false;
    }
    const projectedIds = new Set(current.bodyRows.map((row) => row.id));
    const nodeId = projectedIds.has(route.focusNodeId)
      ? route.focusNodeId
      : gesture.focusNodeId;
    if (nodeId === null || !projectedIds.has(nodeId)) return false;
    const contentRoot = current.getContentRoot();
    const title = outlineTitleTextarea(contentRoot, nodeId);
    if (!title || title.disabled || title.readOnly) return false;
    const activeElement = document.activeElement;
    if (
      activeElement !== null &&
      activeElement !== document.body &&
      activeElement instanceof Element &&
      (!contentRoot?.contains(activeElement) ||
        (activeElement !== title &&
          activeElement.closest<HTMLElement>("[data-outline-id]")?.dataset
            .outlineId !== nodeId))
    ) {
      return false;
    }
    title.focus();

    const selectionStart = title.selectionStart;
    const selectionEnd = title.selectionEnd;
    if (
      selectionStart !== selectionEnd ||
      (selectionStart > 0 && title.value.length > 0)
    ) {
      const deleteStart =
        selectionStart === selectionEnd
          ? previousGraphemeBoundary(title.value, selectionStart)
          : selectionStart;
      const nextValue =
        title.value.slice(0, deleteStart) + title.value.slice(selectionEnd);
      current.actions.touchBackspaceGesture?.(gesture.token, nodeId);
      dispatchHeldBackspaceInput(title, nextValue, deleteStart);
      return true;
    }

    const node = current.stateSlice.state.nodesById[nodeId];
    if (!node) return false;
    const draft = current.draftsByNodeId[nodeId];
    const resolution = resolveOutlineKey({
      target: "title",
      key: "Backspace",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      repeat: true,
      selectionStart,
      selectionEnd,
      title: title.value,
      note: draft?.note ?? node.note,
      nodeId,
      platform: detectOutlineShortcutPlatform(),
      workspace: current.stateSlice.state,
      authoritativeWorkspace:
        current.stateSlice.libraryView === "all"
          ? current.stateSlice.state
          : undefined,
      visibleNodeIds: current.visibleNodeIds,
      outdentBoundaryRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
      selectionVisibleNodeIds: current.selectionVisibleNodeIds,
      selection: null,
    });
    if (resolution?.type !== "remove") return false;

    const focusNodeId = resolution.focusNodeId;
    if (focusNodeId !== null) {
      const focusTarget = outlineTitleTextarea(
        current.getContentRoot(),
        focusNodeId,
      );
      if (focusTarget && !focusTarget.disabled && !focusTarget.readOnly) {
        focusTarget.focus();
        focusTarget.setSelectionRange(0, 0);
      }
      void current.actions.focusNode(focusNodeId, {
        anchorUtf16: 0,
        focusUtf16: 0,
      });
    }
    current.actions.touchBackspaceGesture?.(gesture.token, nodeId);
    const removed =
      current.actions.removeEmptyNodeInBackspaceGesture?.(
        gesture.token,
        nodeId,
        focusNodeId,
      ) === true;
    if (removed && focusNodeId !== null) {
      routeRef.current = { token: gesture.token, focusNodeId };
    }
    return removed;
  };

  const stop = useCallback(() => {
    controller.stop();
    routeRef.current = null;
  }, [controller]);
  const handleKeyDown = useCallback(
    (
      token: number,
      nodeId: NoteId,
      repeat: boolean,
    ): "native" | "consume" => {
      routeRef.current = { token, focusNodeId: nodeId };
      return controller.handleKeyDown(token, repeat);
    },
    [controller],
  );
  const vaultRootRef = useRef(options.vaultRoot);
  useLayoutEffect(() => {
    if (vaultRootRef.current === options.vaultRoot) return;
    vaultRootRef.current = options.vaultRoot;
    stop();
  }, [options.vaultRoot, stop]);
  useEffect(() => stop, [stop]);

  return useMemo(
    () => ({ handleKeyDown, stop }),
    [handleKeyDown, stop],
  );
}
