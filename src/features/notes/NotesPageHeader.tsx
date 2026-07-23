import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { Lock } from "lucide-react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { createNoteId, type NoteId } from "../../domain/notes";
import {
  NoteTextField,
  restoreTextareaPrimarySelection
} from "./NoteTextField";
import { useNotesDatePickerIntegration } from "./NotesDatePickerIntegration";
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  NotesBulletMenu
} from "./NotesBulletMenu";
import { NotesAttachmentList } from "./NotesAttachmentList";
import {
  isValidNotesImageAttachmentMetadata,
  NotesImageNodeContent
} from "./NotesImageAttachment";
import {
  ImageAtomEditor,
  type ImageAtomEditorCutRequest,
  type ImageAtomEditorHandle
} from "./ImageAtomEditor";
import { NotesImageUploadStatus } from "./NotesImageUploadStatus";
import {
  noteNodeNavigationLabel,
  noteNodePresentationLabel
} from "./notesPresentation";
import { useNotesExportController } from "./NotesExportController";
import {
  parseNotesImageAtomPaste,
  readNotesImageAtomPasteCandidate
} from "./notesImageAtomClipboard";
import {
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import type { NotesPreparedMove } from "./useNotesWorkspace";
import { resizeTextarea, useAutoGrowTextarea } from "./autoGrowTextarea";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey,
  resolveSupportingNoteKey,
  supportingNoteFocusTarget
} from "./outlineKeyboard";

interface NotesPageHeaderProps {
  nodeId: NoteId;
  getVisibleNodeIds(): readonly NoteId[];
  disabled?: boolean;
  movementProtected?: boolean;
  mode?: "standard" | "archive" | "trash";
  imageDropActive?: boolean;
  showDropPlaceholder?: boolean;
}

export function NotesPageHeader({
  nodeId,
  getVisibleNodeIds,
  disabled = false,
  movementProtected = false,
  mode = "standard",
  imageDropActive = false,
  showDropPlaceholder = false
}: NotesPageHeaderProps) {
  const {
    actions,
    commitPreparedMove,
    loadActiveNodesForMove,
    prepareMoveNode,
    retryFailedDraft,
    registerActiveImageAtomEditor,
    captureActiveImageAtomEditorAuthority,
    captureImageAtomCutAuthority,
    applyImageAtomCutWithAuthority,
    captureImageAtomPasteAuthority,
    isImageAtomPasteAuthorityCurrent,
    applyImageAtomPasteWithAuthority
  } = useNotesActions();
  const { activeTagFilters, pendingPrimarySelection, state } = useNotesState();
  const {
    attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId,
    draftsByNodeId
  } = useNotesDrafts();
  const exportController = useNotesExportController();
  const node = state.nodesById[nodeId];
  const draft = draftsByNodeId[nodeId];
  const contentProtected = node?.isReadonly === true;
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const imageEditorRef = useRef<ImageAtomEditorHandle>(null);
  const focusedPrimarySelectionRequestIdRef = useRef<number | null>(null);
  const titleSelectionRef = useRef<{
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const focusNoteOnOpenRef = useRef(false);
  const dateNoteOnOpenRef = useRef(false);
  const noteComposingRef = useRef(false);
  const noteBlurredDuringCompositionRef = useRef(false);
  const preparedMoveRef = useRef<NotesPreparedMove | null>(null);
  const commandInFlightRef = useRef(false);
  const [revealedNoteNodeId, setRevealedNoteNodeId] =
    useState<NoteId | null>(null);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [trashConfirmReturnsToTitle, setTrashConfirmReturnsToTitle] =
    useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [protectedDraft, setProtectedDraft] = useState(() => ({
    title: node?.title ?? "",
    note: node?.note ?? "",
    imageOffsetUtf16: node?.imageOffsetUtf16 ?? 0
  }));
  const protectedSelectionRef = useRef<{
    field: "title" | "note";
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const protectedFocusRef = useRef<{
    field: "title" | "note";
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const titleValue = contentProtected
    ? protectedDraft.title
    : draft?.title ?? node?.title ?? "";
  const noteValue = contentProtected
    ? protectedDraft.note
    : draft?.note ?? node?.note ?? "";
  const imageOffsetUtf16 = contentProtected
    ? protectedDraft.imageOffsetUtf16
    : draft?.imageOffsetUtf16 ?? node?.imageOffsetUtf16 ?? 0;
  const label = node
    ? noteNodePresentationLabel(
        node,
        titleValue || node.title,
        "Untitled page"
      )
    : "Untitled page";
  const headingLabel = node
    ? noteNodeNavigationLabel(
        node,
        titleValue || node.title,
        "Untitled page"
      )
    : "Untitled page";
  const noteVisible =
    noteValue.length > 0 || revealedNoteNodeId === nodeId;
  const readOnly = mode !== "standard";
  const imageIngestEnabled =
    !disabled &&
    !readOnly &&
    !contentProtected &&
    state.status !== "loading";
  const imageIngestEnabledRef = useRef(imageIngestEnabled);
  imageIngestEnabledRef.current = imageIngestEnabled;
  const imageAttachmentTargetEnabled =
    imageIngestEnabled &&
    (actions.importDroppedImagePaths !== undefined ||
      actions.importClipboardImages !== undefined);
  const imageDropEnabled =
    imageIngestEnabled && actions.importDroppedImagePaths !== undefined;
  const titlePresentationLabel =
    readOnly || disabled ? "Page title" : undefined;
  const attachments = state.attachmentsByNodeId?.[nodeId] ?? [];
  const primaryImageAttachment =
    node?.nodeKind === "image" &&
    attachments.length === 1 &&
    isValidNotesImageAttachmentMetadata(attachments[0]!)
      ? attachments[0]!
      : null;
  const datePicker = useNotesDatePickerIntegration({
    values: { title: titleValue, note: noteValue },
    refs: { title: titleRef, note: noteRef },
    onCommit: (field, value, replacement) => {
      const nextImageOffsetUtf16 =
        node?.nodeKind === "image" &&
        field === "title" &&
        replacement.endUtf16 <= imageOffsetUtf16
          ? imageOffsetUtf16 +
            replacement.text.length -
            (replacement.endUtf16 - replacement.startUtf16)
          : imageOffsetUtf16;
      if (contentProtected) {
        setProtectedDraft((current) => ({
          title: field === "title" ? value : current.title,
          note: field === "note" ? value : current.note,
          imageOffsetUtf16: nextImageOffsetUtf16
        }));
        return;
      }
      actions.updateNodeDraft(
        nodeId,
        field === "title"
          ? { title: value, note: noteValue, imageOffsetUtf16: nextImageOffsetUtf16 }
          : { title: titleValue, note: value, imageOffsetUtf16: nextImageOffsetUtf16 },
        field
      );
      void actions.flushNodeDraft(nodeId);
    }
  });

  useAutoGrowTextarea(titleRef, titleValue);
  useAutoGrowTextarea(noteRef, noteValue, noteVisible);

  useLayoutEffect(() => {
    const next = {
      title: node?.title ?? "",
      note: node?.note ?? "",
      imageOffsetUtf16: node?.imageOffsetUtf16 ?? 0
    };
    if (contentProtected) {
      const active = document.activeElement;
      if (active === titleRef.current || active === noteRef.current) {
        const target = active as HTMLTextAreaElement;
        protectedSelectionRef.current = {
          field: active === titleRef.current ? "title" : "note",
          startUtf16: target.selectionStart,
          endUtf16: target.selectionEnd
        };
      }
    }
    setProtectedDraft(next);
  }, [
    contentProtected,
    node?.imageOffsetUtf16,
    node?.note,
    node?.title
  ]);

  useLayoutEffect(() => {
    const selection = protectedSelectionRef.current;
    if (!contentProtected || !selection) {
      return;
    }
    protectedSelectionRef.current = null;
    const target =
      selection.field === "title" ? titleRef.current : noteRef.current;
    if (!target) {
      return;
    }
    target.focus();
    const end = target.value.length;
    target.setSelectionRange(
      Math.min(selection.startUtf16, end),
      Math.min(selection.endUtf16, end)
    );
  }, [contentProtected, protectedDraft]);

  useLayoutEffect(() => {
    const focus = protectedFocusRef.current;
    if (!contentProtected || !focus) {
      return;
    }
    const target = focus.field === "title" ? titleRef.current : noteRef.current;
    if (!target || document.activeElement === target) {
      return;
    }
    target.focus();
    const end = target.value.length;
    target.setSelectionRange(
      Math.min(focus.startUtf16, end),
      Math.min(focus.endUtf16, end)
    );
  });

  useLayoutEffect(() => {
    if (!noteVisible || !noteRef.current) {
      return;
    }
    if (dateNoteOnOpenRef.current) {
      dateNoteOnOpenRef.current = false;
      const caret = noteRef.current.value.length;
      datePicker.openTypedDate(
        "note",
        { startUtf16: caret, endUtf16: caret },
        noteRef.current
      );
      return;
    }
    if (focusNoteOnOpenRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  }, [datePicker, noteVisible]);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId) {
      focusedPrimarySelectionRequestIdRef.current = null;
      return;
    }
    // A read-only page (archive/trash) is not focusable; wait until it becomes
    // editable. `readOnly` in the deps re-runs this once editability flips so
    // focus lands after a restore — previously an incidental `actions` identity
    // churn (now removed) provided that retry.
    if (readOnly) {
      return;
    }
    const replaySelection =
      pendingPrimarySelection?.nodeId === nodeId &&
      pendingPrimarySelection.field === "title"
        ? pendingPrimarySelection
        : null;
    if (
      replaySelection &&
      focusedPrimarySelectionRequestIdRef.current === replaySelection.requestId
    ) {
      return;
    }
    if (state.pendingFocusField === "note" && !noteVisible) {
      setRevealedNoteNodeId(nodeId);
      return;
    }
    const target =
      state.pendingFocusField === "note"
        ? noteRef.current
        : node?.nodeKind === "image"
          ? imageRef.current
          : titleRef.current;
    let focused = false;
    if (replaySelection && node?.nodeKind === "image") {
      focused = imageEditorRef.current?.focus(replaySelection.selection) ?? false;
    } else if (target) {
      target.focus();
      focused = document.activeElement === target;
      if (focused && replaySelection && target instanceof HTMLTextAreaElement) {
        focused = restoreTextareaPrimarySelection(target, replaySelection.selection);
      }
    }
    if (focused) {
      if (replaySelection) {
        focusedPrimarySelectionRequestIdRef.current = replaySelection.requestId;
      }
      void (replaySelection
        ? actions.acknowledgeFocus(nodeId, replaySelection.requestId)
        : actions.acknowledgeFocus(nodeId));
    }
  }, [
    actions,
    nodeId,
    node?.nodeKind,
    noteVisible,
    pendingPrimarySelection,
    readOnly,
    state.pendingFocusField,
    state.pendingFocusId
  ]);

  if (!node) {
    return null;
  }

  const restoreProtectedDraft = () => {
    setProtectedDraft({
      title: node.title,
      note: node.note,
      imageOffsetUtf16: node.imageOffsetUtf16
    });
  };

  const runCommand = (command: () => Promise<unknown>) => {
    if (commandInFlightRef.current) {
      return;
    }
    commandInFlightRef.current = true;
    setCommandBusy(true);
    let completion: Promise<unknown>;
    try {
      completion = command();
    } catch {
      commandInFlightRef.current = false;
      return;
    }
    const settle = () => {
      commandInFlightRef.current = false;
      setCommandBusy(false);
    };
    void completion.then(settle, settle);
  };

  const openAndFocusNote = () => {
    focusNoteOnOpenRef.current = true;
    setRevealedNoteNodeId(nodeId);
    if (noteRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  };

  const settleNoteBlur = (value: string, includeLiveValue = false) => {
    if (contentProtected) {
      restoreProtectedDraft();
      return;
    }
    if (includeLiveValue) {
      actions.updateNodeDraft(nodeId, { title: titleValue, note: value, imageOffsetUtf16 }, "note");
    }
    if (value.trim().length === 0) {
      setRevealedNoteNodeId(null);
      if (value.length > 0) {
        actions.updateNodeDraft(nodeId, { title: titleValue, note: "", imageOffsetUtf16 }, "note");
      }
    }
    void actions.flushNodeDraft(nodeId);
  };

  const openNoteDate = () => {
    if (!noteRef.current) {
      dateNoteOnOpenRef.current = true;
      setRevealedNoteNodeId(nodeId);
      return;
    }
    const caret = noteRef.current.value.length;
    datePicker.openTypedDate(
      "note",
      { startUtf16: caret, endUtf16: caret },
      noteRef.current
    );
  };

  const removeNote = () => {
    if (contentProtected) {
      restoreProtectedDraft();
      return;
    }
    setRevealedNoteNodeId(null);
    actions.updateNodeDraft(nodeId, { title: titleValue, note: "", imageOffsetUtf16 }, "note");
    void actions.flushNodeDraft(nodeId);
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const historyShortcut = resolveNotesHistoryShortcut({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      platform: detectOutlineShortcutPlatform()
    });
    if (historyShortcut) {
      event.preventDefault();
      void actions[historyShortcut]?.();
      return;
    }
    if (
      contentProtected &&
      event.key === "Escape" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      restoreProtectedDraft();
      return;
    }
    const resolution = resolveOutlineKey({
      target: "title",
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      repeat: event.repeat,
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
      title: titleValue,
      note: noteValue,
      nodeId,
      platform: detectOutlineShortcutPlatform(),
      workspace: state,
      visibleNodeIds: getVisibleNodeIds()
    });
    if (!resolution) {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
      }
      return;
    }
    if (
      ![
        "focus",
        "focusNote",
        "split",
        "consumeTabShortcut",
        "toggleComplete",
        "duplicate",
        "delete",
        "confirmDelete"
      ].includes(resolution.type)
    ) {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    if (contentProtected) {
      if (resolution.type === "split") {
        restoreProtectedDraft();
        runCommand(() => actions.createNextTextSibling(nodeId));
        return;
      }
      if (
        resolution.type === "delete" ||
        resolution.type === "confirmDelete" ||
        resolution.type === "consumeTabShortcut"
      ) {
        restoreProtectedDraft();
        return;
      }
    }
    switch (resolution.type) {
      case "consumeTabShortcut":
        return;
      case "split":
        runCommand(() => actions.createChild(nodeId, "first"));
        return;
      case "focus":
        void actions.flushNodeDraft(nodeId);
        void (resolution.selection
          ? actions.focusNode(resolution.nodeId, resolution.selection)
          : actions.focusNode(resolution.nodeId));
        return;
      case "focusNote":
        openAndFocusNote();
        return;
      case "toggleComplete":
        runCommand(() => actions.toggleComplete(nodeId));
        return;
      case "duplicate":
        runCommand(() => actions.duplicateNode(nodeId));
        return;
      case "delete":
        runCommand(() => actions.deleteNode(nodeId));
        return;
      case "confirmDelete":
        if (actions.deleteNodes !== undefined) {
          runCommand(() => actions.deleteNode(nodeId));
          return;
        }
        setTrashConfirmReturnsToTitle(true);
        setTrashConfirmOpen(true);
        return;
    }
  };

  const handleImageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const historyShortcut = resolveNotesHistoryShortcut({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      platform: detectOutlineShortcutPlatform()
    });
    if (historyShortcut) {
      event.preventDefault();
      void actions[historyShortcut]?.();
      return;
    }
    const resolution = resolveOutlineKey({
      target: "image",
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      repeat: event.repeat,
      selectionStart: null,
      selectionEnd: null,
      title: titleValue,
      note: noteValue,
      nodeId,
      platform: detectOutlineShortcutPlatform(),
      workspace: state
    });
    if (!resolution) return;

    event.preventDefault();
    if (contentProtected || movementProtected) {
      if (
        resolution.type === "move" ||
        resolution.type === "consumeTabShortcut"
      ) {
        if (contentProtected) restoreProtectedDraft();
        return;
      }
      if (
        contentProtected &&
        (resolution.type === "delete" || resolution.type === "remove")
      ) {
        restoreProtectedDraft();
        return;
      }
      if (resolution.type === "createNextTextSibling") {
        restoreProtectedDraft();
        runCommand(() => actions.createNextTextSibling(nodeId));
        return;
      }
      if (resolution.type === "focus" || resolution.type === "focusNote") {
        restoreProtectedDraft();
      }
    }
    switch (resolution.type) {
      case "createNextTextSibling":
        runCommand(() => actions.createNextTextSibling(nodeId));
        return;
      case "focusNote":
        openAndFocusNote();
        return;
      case "move":
        runCommand(() =>
          actions.moveNode(resolution.input, resolution.focusNodeId, {
            expandNodeId: resolution.expandNodeId
          })
        );
        return;
      case "toggleComplete":
        runCommand(() => actions.toggleComplete(nodeId));
        return;
      case "duplicate":
        runCommand(() => actions.duplicateNode(nodeId));
        return;
      case "delete":
        runCommand(() => actions.deleteNode(nodeId));
        return;
      case "toggleCollapsed":
        runCommand(() => actions.toggleCollapsed(nodeId));
        return;
      case "focus":
        void (resolution.selection
          ? actions.focusNode(resolution.nodeId, resolution.selection)
          : actions.focusNode(resolution.nodeId));
        return;
      case "split":
      case "remove":
      case "extendSelection":
      case "clearSelection":
      case "consumeTabShortcut":
      case "batchComplete":
      case "batchDelete":
      case "batchIndent":
      case "batchOutdent":
        return;
    }
  };

  const updateImageDraft = (nextDraft: {
    readonly title: string;
    readonly note: string;
    readonly imageOffsetUtf16: number;
  }) => {
    if (contentProtected) {
      setProtectedDraft({ ...nextDraft });
      return;
    }
    actions.updateNodeDraft(nodeId, nextDraft, "title");
  };

  const runImageAtomEnter = () => {
    if (contentProtected) {
      restoreProtectedDraft();
      runCommand(() => actions.createNextTextSibling(nodeId));
      return;
    }
    runCommand(async () => {
      const selection = await imageEditorRef.current?.flushAndGetSelection();
      if (!selection) return "skipped";
      let siblingId: NoteId;
      try {
        siblingId = createNoteId();
      } catch {
        return "skipped";
      }
      return actions.applyImageAtomEdit(nodeId, selection, {
        kind: "enter",
        siblingId
      });
    });
  };

  const runImageAtomKeyboardRemove = () => {
    runCommand(async () => {
      const selection = await imageEditorRef.current?.flushAndGetSelection();
      return selection
        ? actions.applyImageAtomEdit(nodeId, selection, {
            kind: "remove",
            replacementText: ""
          })
        : "skipped";
    });
  };

  const runImageAtomCut = async ({
    selection,
    selectionAuthority
  }: ImageAtomEditorCutRequest) => {
    const editor = imageEditorRef.current;
    if (
      !editor ||
      !captureActiveImageAtomEditorAuthority ||
      !captureImageAtomCutAuthority ||
      !applyImageAtomCutWithAuthority
    ) {
      return false;
    }
    const editorAuthority = captureActiveImageAtomEditorAuthority(
      nodeId,
      selectionAuthority
    );
    if (!editorAuthority || (await editor.flush()) !== "flushed") return false;
    if (imageEditorRef.current !== editor) return false;
    let persisted = false;
    try {
      persisted = await actions.flushNodeDraft(nodeId);
    } catch {
      return false;
    }
    if (!persisted || imageEditorRef.current !== editor) return false;
    const cutAuthority = captureImageAtomCutAuthority(nodeId, editorAuthority);
    if (!cutAuthority) return false;
    return await applyImageAtomCutWithAuthority(
      cutAuthority,
      nodeId,
      { ...selection }
    ) === "committed";
  };

  const runImageAtomMenuRemove = () => {
    runCommand(async () => {
      const result = await imageEditorRef.current?.flush();
      if (result !== "flushed" && result !== "deferred") return "skipped";
      return actions.applyImageAtomEdit(
        nodeId,
        {
          anchorUtf16: imageOffsetUtf16,
          focusUtf16: imageOffsetUtf16 + 1
        },
        { kind: "remove", replacementText: "" }
      );
    });
  };

  const handleImageAtomPaste = (event: globalThis.ClipboardEvent): boolean => {
    if (!imageIngestEnabled || !event.clipboardData) return false;
    const clipboardData = event.clipboardData;
    const candidate = readNotesImageAtomPasteCandidate(clipboardData);
    if (!candidate.claimed) return false;

    event.preventDefault();
    const parse = parseNotesImageAtomPaste(candidate).catch(
      () => ({ kind: "none" as const })
    );
    const editor = imageEditorRef.current;
    void (async () => {
      const initial = await editor?.flushAndGetSelectionSnapshot();
      if (!editor || !initial || imageEditorRef.current !== editor) return;
      const editorAuthority = captureActiveImageAtomEditorAuthority?.(
        nodeId,
        initial.authority
      );
      if (!editorAuthority) return;
      let persisted = false;
      try {
        persisted = await actions.flushNodeDraft(nodeId);
      } catch {
        return;
      }
      if (
        !persisted ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !imageIngestEnabledRef.current
      ) {
        return;
      }
      const admitted = await editor.flushAndGetSelectionSnapshot();
      if (
        !admitted ||
        admitted.selection.anchorUtf16 !== initial.selection.anchorUtf16 ||
        admitted.selection.focusUtf16 !== initial.selection.focusUtf16 ||
        admitted.authority !== initial.authority
      ) {
        return;
      }
      const authority = captureImageAtomPasteAuthority?.(
        nodeId,
        editorAuthority
      );
      if (!authority || !applyImageAtomPasteWithAuthority) return;
      const exactSelection = { ...admitted.selection };
      const parsed = await parse;
      if (parsed.kind !== "imageAtom" && parsed.kind !== "external") return;
      if (
        !isImageAtomPasteAuthorityCurrent?.(authority) ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !imageIngestEnabledRef.current
      ) {
        return;
      }
      const live = await editor.flushAndGetSelectionSnapshot();
      if (
        !live ||
        live.selection.anchorUtf16 !== exactSelection.anchorUtf16 ||
        live.selection.focusUtf16 !== exactSelection.focusUtf16 ||
        live.authority !== admitted.authority ||
        !isImageAtomPasteAuthorityCurrent(authority) ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !imageIngestEnabledRef.current
      ) {
        return;
      }
      runCommand(() =>
        applyImageAtomPasteWithAuthority(
          authority,
          nodeId,
          exactSelection,
          parsed.value
        )
      );
    })().catch(() => undefined);
    return true;
  };

  return (
    <>
      <header
        className="notes-page-header"
        data-completed={node.completedAt !== null ? "true" : undefined}
        data-selected={state.selectedId === nodeId ? "true" : undefined}
        data-readonly={contentProtected ? "true" : undefined}
        data-notes-attachment-target={
          imageAttachmentTargetEnabled ? nodeId : undefined
        }
        data-image-drop-active={
          imageDropEnabled && imageDropActive ? "true" : undefined
        }
      >
        <div className="notes-page-title-row">
          <div className="notes-page-menu-slot">
            <NotesBulletMenu
              mode={mode}
              label={label}
              completed={node.completedAt !== null}
              starred={node.isStarred}
              isReadonly={contentProtected}
              hasNote={Boolean(noteValue.trim())}
              saveFailed={draft?.status === "failed"}
              disabled={disabled}
              actionBusy={commandBusy}
              createdAt={node.createdAt}
              updatedAt={node.updatedAt}
              getMoveDestinations={() => {
                preparedMoveRef.current = null;
                if (prepareMoveNode) {
                  return prepareMoveNode(nodeId).then((prepared) => {
                    preparedMoveRef.current = prepared;
                    return buildNotesMoveDestinations(
                      Object.fromEntries(
                        prepared.nodes.map((item) => [item.id, item])
                      ),
                      nodeId
                    );
                  });
                }
                if (!loadActiveNodesForMove) {
                  return buildNotesMoveDestinations(state.nodesById, nodeId);
                }
                return loadActiveNodesForMove()
                  .then((nodes) =>
                    buildNotesMoveDestinations(
                      Object.fromEntries(
                        nodes.map((item) => [item.id, item])
                      ),
                      nodeId
                    )
                  )
                  .catch(() =>
                    buildNotesMoveDestinations(state.nodesById, nodeId)
                  );
              }}
              exportDisabled={
                exportController.unavailable || exportController.busy
              }
              onToggleComplete={() =>
                runCommand(() => actions.toggleComplete(nodeId))
              }
              onToggleStar={() =>
                runCommand(() => actions.toggleStar(nodeId))
              }
              onToggleReadonly={
                actions.setReadonly
                  ? () =>
                      runCommand(() =>
                        actions.setReadonly!(nodeId, !contentProtected)
                      )
                  : undefined
              }
              onOpenNote={openAndFocusNote}
              onAddDate={() => {
                if (node.nodeKind === "image") {
                  openNoteDate();
                  return;
                }
                datePicker.openTitleDate(titleSelectionRef.current ?? undefined);
                titleSelectionRef.current = null;
              }}
              onUploadImage={
                actions.uploadImage
                  ? () => void actions.uploadImage?.(nodeId)
                  : undefined
              }
              onMoveTo={movementProtected ? undefined : (destinationId) => {
                if (preparedMoveRef.current && commitPreparedMove) {
                  return commitPreparedMove(
                    preparedMoveRef.current,
                    destinationId
                  );
                }
                const input = buildNotesMoveNodeInput(
                  state.nodesById,
                  nodeId,
                  destinationId
                );
                if (input) {
                  runCommand(() => actions.moveNode(input, nodeId));
                  return { ok: true } as const;
                }
                return {
                  ok: false,
                  error: "That destination is no longer valid. Refresh Move To."
                } as const;
              }}
              onExpandAll={() => runCommand(() => actions.expandAll(nodeId))}
              onCollapseAll={() =>
                runCommand(() => actions.collapseAll(nodeId))
              }
              onSortAscending={
                movementProtected
                  ? undefined
                  : () =>
                      runCommand(() =>
                        actions.sortSubtreeAscending(nodeId)
                      )
              }
              onSortDescending={
                movementProtected
                  ? undefined
                  : () =>
                      runCommand(() =>
                        actions.sortSubtreeDescending(nodeId)
                      )
              }
              onRemoveNote={removeNote}
              onDuplicate={() =>
                runCommand(() => actions.duplicateNode(nodeId))
              }
              onExport={(format) =>
                exportController.startExport(
                  nodeId,
                  node.nodeKind === "image" ? label : titleValue,
                  format
                )
              }
              onDelete={() => {
                if (mode === "archive") {
                  if (actions.deleteNodes !== undefined) {
                    runCommand(() => actions.deleteNode(nodeId));
                    return;
                  }
                  setTrashConfirmReturnsToTitle(false);
                  setTrashConfirmOpen(true);
                  return;
                }
                runCommand(() => actions.deleteNode(nodeId));
              }}
              onRetrySave={() => runCommand(() => retryFailedDraft(nodeId))}
              onRestore={() => runCommand(() => actions.restoreNode(nodeId))}
              onUnarchive={() =>
                runCommand(() => actions.unarchiveNode(nodeId))
              }
            />
          </div>
          {node.nodeKind === "image" ? primaryImageAttachment ? (
            <div className="notes-page-primary">
              <h1
                className="notes-page-heading"
                aria-label={headingLabel}
              />
              <ImageAtomEditor
                ref={imageEditorRef}
                nodeId={nodeId}
                draft={{ title: titleValue, note: noteValue, imageOffsetUtf16 }}
                attachment={primaryImageAttachment}
                onDraftChange={updateImageDraft}
                registerFlushAdapter={actions.registerImageAtomFlushAdapter}
                registerActiveEditor={registerActiveImageAtomEditor}
                onFocusLeave={
                  contentProtected ? restoreProtectedDraft : undefined
                }
                onEnter={readOnly ? undefined : runImageAtomEnter}
                onAtomDelete={
                  readOnly || contentProtected
                    ? undefined
                    : runImageAtomKeyboardRemove
                }
                onUnhandledKeyDown={
                  readOnly ? undefined : handleImageKeyDown
                }
                onSupportingNote={
                  readOnly
                    ? undefined
                    : contentProtected
                      ? () => {
                          restoreProtectedDraft();
                          openAndFocusNote();
                        }
                      : openAndFocusNote
                }
                onUndo={readOnly ? undefined : () => void actions.undo?.()}
                onRedo={readOnly ? undefined : () => void actions.redo?.()}
                onImageAtomPaste={
                  readOnly
                    ? undefined
                    : contentProtected
                      ? (event) =>
                          event.clipboardData !== null &&
                          readNotesImageAtomPasteCandidate(
                            event.clipboardData
                          ).claimed
                      : handleImageAtomPaste
                }
                loadAttachmentBytes={
                  readOnly || disabled
                    ? undefined
                    : actions.loadAttachmentBytes
                }
                onAtomCut={
                  readOnly || contentProtected || disabled
                    ? undefined
                    : runImageAtomCut
                }
                onTagClick={(token) =>
                  void actions.toggleTagFilter({
                    prefix: token.prefix,
                    normalizedTag: token.normalized
                  })
                }
                onDateClick={readOnly || disabled ? undefined : (token, anchor) =>
                  datePicker.openExistingDate(
                    "title",
                    token,
                    anchor,
                    imageRef.current ?? undefined
                  )
                }
                onDateTrigger={readOnly || disabled ? undefined : (range, anchor, source) =>
                  datePicker.openTypedDate("title", range, anchor, source)
                }
                isTagActive={(token) =>
                  activeTagFilters.some(
                    (filter) =>
                      filter.prefix === token.prefix &&
                      filter.normalizedTag === token.normalized
                  )
                }
                today={datePicker.today}
                className="notes-page-primary-image"
                contentRef={imageRef}
                readOnly={readOnly}
                atomReadOnly={contentProtected}
                disabled={disabled}
                onRemoveImage={
                  readOnly || contentProtected
                    ? undefined
                    : runImageAtomMenuRemove
                }
              />
            </div>
          ) : (
            <div className="notes-page-primary">
              <h1 className="notes-page-heading" aria-label={headingLabel} />
              <NotesImageNodeContent
                nodeId={nodeId}
                attachment={attachments[0]}
                originalName={titleValue || node.title}
                className="notes-page-primary-image"
                style={{ minWidth: 0 }}
                contentRef={imageRef}
                onKeyDown={readOnly ? undefined : handleImageKeyDown}
                readOnly={readOnly}
                disabled={disabled}
              />
            </div>
          ) : (
            <h1
              className={
                contentProtected
                  ? "notes-page-heading notes-page-readonly-title-line"
                  : "notes-page-heading"
              }
              aria-label={label}
            >
              <NoteTextField
                slashCommands
                ref={titleRef}
                stablePresentation
                placeCaretFromPointer
                className="notes-page-title"
                containerClassName="notes-page-title-field"
                value={titleValue}
                aria-label="Edit page title"
                presentationAriaLabel={titlePresentationLabel}
                placeholder="Untitled page"
                rows={1}
                wrap="soft"
                disabled={disabled}
                readOnly={readOnly}
                today={datePicker.today}
                getToday={datePicker.getToday}
                onDateClick={
                  readOnly || disabled
                    ? undefined
                    : (token, anchor) =>
                        datePicker.openExistingDate("title", token, anchor)
                }
                onDateTrigger={
                  readOnly || disabled
                    ? undefined
                    : (range, anchor) =>
                        datePicker.openTypedDate("title", range, anchor)
                }
                onTagClick={(token) =>
                  void actions.toggleTagFilter({
                    prefix: token.prefix,
                    normalizedTag: token.normalized
                  })
                }
                isTagActive={(token) =>
                  activeTagFilters.some(
                    (filter) =>
                      filter.prefix === token.prefix &&
                      filter.normalizedTag === token.normalized
                  )
                }
                onKeyDown={readOnly ? undefined : handleTitleKeyDown}
                onSelect={(event) => {
                  titleSelectionRef.current = {
                    startUtf16: event.currentTarget.selectionStart,
                    endUtf16: event.currentTarget.selectionEnd
                  };
                  if (contentProtected) {
                    protectedFocusRef.current = {
                      field: "title",
                      startUtf16: event.currentTarget.selectionStart,
                      endUtf16: event.currentTarget.selectionEnd
                    };
                  }
                }}
                onFocus={
                  contentProtected
                    ? (event) => {
                        protectedFocusRef.current = {
                          field: "title",
                          startUtf16: event.currentTarget.selectionStart,
                          endUtf16: event.currentTarget.selectionEnd
                        };
                      }
                    : undefined
                }
                onChange={(event) => {
                  resizeTextarea(event.currentTarget);
                  if (contentProtected) {
                    setProtectedDraft((current) => ({
                      ...current,
                      title: event.target.value
                    }));
                    return;
                  }
                  actions.updateNodeDraft(
                    nodeId,
                    {
                      title: event.target.value,
                      note: noteValue,
                      imageOffsetUtf16
                    },
                    "title"
                  );
                }}
                onBlur={(event) => {
                  protectedFocusRef.current = null;
                  titleSelectionRef.current = {
                    startUtf16: event.currentTarget.selectionStart,
                    endUtf16: event.currentTarget.selectionEnd
                  };
                  if (!datePicker.shouldSuppressBlur()) {
                    if (contentProtected) {
                      restoreProtectedDraft();
                    } else {
                      void actions.flushNodeDraft(nodeId);
                    }
                  }
                }}
              />
              {contentProtected && (
                <span className="notes-node-inline-actions notes-page-readonly-actions">
                  <span
                    className="notes-node-lock"
                    role="img"
                    aria-label="읽기 전용"
                  >
                    <Lock size={12} aria-hidden="true" />
                  </span>
                </span>
              )}
            </h1>
          )}
        </div>
        {noteVisible && (
          <NoteTextField
            ref={noteRef}
            stablePresentation
            placeCaretFromPointer
            className="notes-page-note"
            containerClassName="notes-page-note-field"
            value={noteValue}
            aria-label={`Supporting note: ${label}`}
            placeholder="Add a supporting note"
            rows={1}
            disabled={disabled}
            readOnly={readOnly}
            today={datePicker.today}
            onDateClick={
              readOnly || disabled
                ? undefined
                : (token, anchor) =>
                    datePicker.openExistingDate("note", token, anchor)
            }
            onDateTrigger={
              readOnly || disabled
                ? undefined
                : (range, anchor) =>
                    datePicker.openTypedDate("note", range, anchor)
            }
            onTagClick={(token) =>
              void actions.toggleTagFilter({
                prefix: token.prefix,
                normalizedTag: token.normalized
              })
            }
            isTagActive={(token) =>
              activeTagFilters.some(
                (filter) =>
                  filter.prefix === token.prefix &&
                  filter.normalizedTag === token.normalized
              )
            }
            onKeyDown={
              readOnly
                ? undefined
                : (event) => {
                    if (
                      contentProtected &&
                      (event.nativeEvent.isComposing ||
                        event.nativeEvent.key === "Process")
                    ) {
                      return;
                    }
                    const historyShortcut = resolveNotesHistoryShortcut({
                      key: event.key,
                      altKey: event.altKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      shiftKey: event.shiftKey,
                      isComposing: event.nativeEvent.isComposing,
                      platform: detectOutlineShortcutPlatform()
                    });
                    if (historyShortcut) {
                      event.preventDefault();
                      void actions[historyShortcut]?.();
                      return;
                    }
                    if (
                      contentProtected &&
                      event.key === "Escape" &&
                      !event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      restoreProtectedDraft();
                      return;
                    }
                    const resolution = resolveSupportingNoteKey({
                      key: event.key,
                      altKey: event.altKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      shiftKey: event.shiftKey,
                      isComposing: event.nativeEvent.isComposing,
                      repeat: event.repeat,
                      selectionStart: event.currentTarget.selectionStart,
                      selectionEnd: event.currentTarget.selectionEnd,
                      value: event.currentTarget.value
                    });
                    if (!resolution) {
                      return;
                    }
                    event.preventDefault();
                    const focusTarget = supportingNoteFocusTarget(
                      resolution,
                      nodeId,
                      getVisibleNodeIds()
                    );
                    if (contentProtected) {
                      restoreProtectedDraft();
                      if (resolution === "nextTitleOrCreate") {
                        runCommand(() =>
                          actions.createNextTextSibling(nodeId)
                        );
                        return;
                      }
                      void actions.focusNode(focusTarget);
                      return;
                    }
                    actions.updateNodeDraft(
                      nodeId,
                      { title: titleValue, note: event.currentTarget.value, imageOffsetUtf16 },
                      "note"
                    );
                    if (
                      resolution === "nextTitleOrCreate" &&
                      focusTarget === nodeId
                    ) {
                      runCommand(() => actions.createChild(nodeId, "first"));
                      return;
                    }
                    void actions.flushNodeDraft(nodeId);
                    void actions.focusNode(focusTarget);
                  }
            }
            onFocus={() => {
              noteBlurredDuringCompositionRef.current = false;
              setRevealedNoteNodeId(nodeId);
              if (contentProtected && noteRef.current) {
                protectedFocusRef.current = {
                  field: "note",
                  startUtf16: noteRef.current.selectionStart,
                  endUtf16: noteRef.current.selectionEnd
                };
              }
            }}
            onSelect={(event) => {
              if (contentProtected) {
                protectedFocusRef.current = {
                  field: "note",
                  startUtf16: event.currentTarget.selectionStart,
                  endUtf16: event.currentTarget.selectionEnd
                };
              }
            }}
            onChange={(event) => {
              setRevealedNoteNodeId(nodeId);
              resizeTextarea(event.currentTarget);
              if (contentProtected) {
                setProtectedDraft((current) => ({
                  ...current,
                  note: event.target.value
                }));
                return;
              }
              actions.updateNodeDraft(nodeId, {
                title: titleValue,
                note: event.target.value,
                imageOffsetUtf16
              }, "note");
            }}
            onBlur={(event) => {
              protectedFocusRef.current = null;
              if (datePicker.shouldSuppressBlur()) {
                return;
              }
              if (noteComposingRef.current) {
                noteBlurredDuringCompositionRef.current = true;
                return;
              }
              settleNoteBlur(event.currentTarget.value);
            }}
            onCompositionStart={() => {
              noteComposingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              noteComposingRef.current = false;
              if (
                !noteBlurredDuringCompositionRef.current ||
                document.activeElement === event.currentTarget
              ) {
                return;
              }
              noteBlurredDuringCompositionRef.current = false;
              settleNoteBlur(event.currentTarget.value, true);
            }}
          />
        )}
        {node.nodeKind === "text" ? (
          <NotesAttachmentList
            nodeId={nodeId}
            attachments={attachments}
            uploadError={attachmentUploadErrorsByNodeId?.[nodeId]}
            uploadRetryAttemptId={
              attachmentUploadRetryAttemptIdsByNodeId?.[nodeId]
            }
            className="notes-page-attachments"
            readOnly={readOnly || contentProtected || disabled}
          />
        ) : (
          <NotesImageUploadStatus
            nodeId={nodeId}
            uploadError={attachmentUploadErrorsByNodeId?.[nodeId]}
            uploadRetryAttemptId={
              attachmentUploadRetryAttemptIdsByNodeId?.[nodeId]
            }
            readOnly={readOnly || contentProtected || disabled}
          />
        )}
        {imageDropEnabled && showDropPlaceholder && (
          <span
            className="notes-image-drop-position"
            data-testid="notes-image-drop-position"
            aria-hidden="true"
          />
        )}
      </header>
      {datePicker.picker}
      <ConfirmDialog
        open={trashConfirmOpen}
        onOpenChange={setTrashConfirmOpen}
        title="Move page to Trash?"
        description={`Move ${label} and all of its descendants to Trash?`}
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        danger
        finalFocus={trashConfirmReturnsToTitle ? titleRef : undefined}
        onConfirm={() => void actions.deleteNode(nodeId)}
      />
    </>
  );
}
