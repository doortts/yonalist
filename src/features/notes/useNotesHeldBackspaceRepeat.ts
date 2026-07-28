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
import { outlineTitleEditor } from "./outlineDom";
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
import {
  readPlainText,
  readPlainTextSelection,
  replacePlainText,
  restorePlainTextSelection,
} from "./plainTextContenteditable";

function dispatchHeldBackspaceInput(
  target: HTMLTextAreaElement | HTMLDivElement,
  value: string,
  caretUtf16: number,
): void {
  if (target instanceof HTMLDivElement) {
    replacePlainText(target, value, {
      anchorUtf16: caretUtf16,
      focusUtf16: caretUtf16,
    });
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    return;
  }
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
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

function editorSource(editor: HTMLTextAreaElement | HTMLDivElement): string {
  return editor instanceof HTMLTextAreaElement
    ? editor.value
    : readPlainText(editor);
}

function editorSelection(
  editor: HTMLTextAreaElement | HTMLDivElement,
  source: string,
): { readonly start: number; readonly end: number } {
  if (editor instanceof HTMLTextAreaElement) {
    return { start: editor.selectionStart, end: editor.selectionEnd };
  }
  const selection = readPlainTextSelection(editor);
  return selection
    ? {
        start: Math.min(selection.anchorUtf16, selection.focusUtf16),
        end: Math.max(selection.anchorUtf16, selection.focusUtf16),
      }
    : { start: source.length, end: source.length };
}

function focusEditor(
  editor: HTMLTextAreaElement | HTMLDivElement,
  caretUtf16: number,
): void {
  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    editor.setSelectionRange(caretUtf16, caretUtf16);
  } else {
    restorePlainTextSelection(editor, {
      anchorUtf16: caretUtf16,
      focusUtf16: caretUtf16,
    });
  }
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
  readonly onRelease: () => void;
}

export interface NotesHeldBackspaceRepeat {
  handleKeyDown(
    token: number,
    nodeId: NoteId,
    repeat: boolean,
    releaseTarget: HTMLTextAreaElement | HTMLDivElement,
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
    caretUtf16?: number;
  } | null>(null);
  const repeatStepRef = useRef<() => boolean>(() => false);
  const controllerRef = useRef<NotesHeldBackspaceRepeatController | null>(
    null,
  );
  if (controllerRef.current === null) {
    controllerRef.current = createNotesHeldBackspaceRepeatController({
      repeat: () => repeatStepRef.current(),
      release: () => optionsRef.current.onRelease(),
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
    const title = outlineTitleEditor(contentRoot, nodeId);
    if (
      !title ||
      (title instanceof HTMLTextAreaElement &&
        (title.disabled || title.readOnly))
    ) {
      return false;
    }
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
    const source = editorSource(title);
    if (route.caretUtf16 !== undefined) {
      focusEditor(title, Math.min(route.caretUtf16, source.length));
    } else {
      title.focus();
    }

    const { start: selectionStart, end: selectionEnd } = editorSelection(
      title,
      source,
    );
    if (
      selectionStart !== selectionEnd ||
      (selectionStart > 0 && source.length > 0)
    ) {
      const deleteStart =
        selectionStart === selectionEnd
          ? previousGraphemeBoundary(source, selectionStart)
          : selectionStart;
      const nextValue =
        source.slice(0, deleteStart) + source.slice(selectionEnd);
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
      title: source,
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
    let focusUtf16 = 0;
    if (focusNodeId !== null) {
      const visibleIndex = current.visibleNodeIds.indexOf(nodeId);
      const focusAtEnd =
        visibleIndex > 0 &&
        current.visibleNodeIds[visibleIndex - 1] === focusNodeId;
      const focusTarget = outlineTitleEditor(
        current.getContentRoot(),
        focusNodeId,
      );
      focusUtf16 =
        focusAtEnd && focusTarget ? editorSource(focusTarget).length : 0;
      if (
        focusTarget &&
        (!(focusTarget instanceof HTMLTextAreaElement) ||
          (!focusTarget.disabled && !focusTarget.readOnly))
      ) {
        current.actions.releaseEditingFocus?.();
        focusEditor(focusTarget, focusUtf16);
      }
      void current.actions.focusNode(focusNodeId, {
        anchorUtf16: focusUtf16,
        focusUtf16,
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
      routeRef.current = {
        token: gesture.token,
        focusNodeId,
        caretUtf16: focusUtf16,
      };
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
      releaseTarget: HTMLTextAreaElement | HTMLDivElement,
    ): "native" | "consume" => {
      routeRef.current = { token, focusNodeId: nodeId };
      return controller.handleKeyDown(token, repeat, releaseTarget);
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
