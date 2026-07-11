import { useSortable } from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronRight
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import {
  createNoteId,
  type NoteId
} from "../../domain/notes";
import { NotesAttachmentList } from "./NotesAttachmentList";
import { NotesBulletMenu } from "./NotesBulletMenu";
import { useNotesDatePickerIntegration } from "./NotesDatePickerIntegration";
import { useNotesExportController } from "./NotesExportController";
import { NoteTextField } from "./NoteTextField";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import { resizeTextarea, useAutoGrowTextarea } from "./autoGrowTextarea";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey
} from "./outlineKeyboard";

interface OutlineNodeRowProps {
  nodeId: NoteId;
  depth: number;
  ancestorGuideDepths: readonly number[];
  visibleDescendantEndId: NoteId | null;
  visibleNodeIds: readonly NoteId[];
  dragDisabled: boolean;
  disabled?: boolean;
  readOnlyMode?: "archive" | "trash";
  locallyExpanded?: boolean;
}

function controlLabel(title: string): string {
  return title.trim() || "Untitled node";
}

export function OutlineNodeRow({
  nodeId,
  depth,
  ancestorGuideDepths,
  visibleDescendantEndId,
  visibleNodeIds,
  dragDisabled,
  disabled = false,
  readOnlyMode,
  locallyExpanded = false
}: OutlineNodeRowProps) {
  const {
    actions,
    activeTagFilters,
    attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId,
    draftsByNodeId,
    retryFailedDraft,
    state
  } = useNotesWorkspaceContext();
  const exportController = useNotesExportController();
  const node = state.nodesById[nodeId];
  const draft = draftsByNodeId[nodeId];
  const readOnly = readOnlyMode !== undefined;
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: nodeId,
    disabled: disabled || dragDisabled || readOnly,
    attributes: {
      role: "button",
      roleDescription: "sortable note",
      tabIndex: 0
    }
  });
  const [noteOpen, setNoteOpen] = useState(() =>
    Boolean((draft?.note ?? node?.note ?? "").trim())
  );
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleSelectionRef = useRef<{
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const focusedPendingIdRef = useRef<NoteId | null>(null);
  const focusNoteOnOpenRef = useRef(false);
  const structuralCommandInFlightRef = useRef(false);
  const suppressedBlurPatchRef = useRef<{
    title: string;
    note: string;
  } | null>(null);
  const titleValue = draft?.title ?? node?.title ?? "";
  const noteValue = draft?.note ?? node?.note ?? "";
  const attachments = state.attachmentsByNodeId?.[nodeId] ?? [];
  const attachmentUploadError = attachmentUploadErrorsByNodeId?.[nodeId];
  const attachmentUploadRetryAttemptId =
    attachmentUploadRetryAttemptIdsByNodeId?.[nodeId];
  const datePicker = useNotesDatePickerIntegration({
    values: { title: titleValue, note: noteValue },
    refs: { title: titleRef, note: noteRef },
    onCommit: (field, value) => {
      actions.updateNodeDraft(
        nodeId,
        field === "title"
          ? { title: value, note: noteValue }
          : { title: titleValue, note: value },
        field
      );
      void actions.flushNodeDraft(nodeId);
    }
  });

  useAutoGrowTextarea(titleRef, titleValue);
  useAutoGrowTextarea(noteRef, noteValue, noteOpen);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId) {
      focusedPendingIdRef.current = null;
      return;
    }
    if (focusedPendingIdRef.current === nodeId) {
      return;
    }
    if (state.pendingFocusField === "note" && !noteOpen) {
      setNoteOpen(true);
      return;
    }
    const target =
      state.pendingFocusField === "note" ? noteRef.current : titleRef.current;
    if (!target) {
      return;
    }
    target.focus();
    if (document.activeElement !== target) {
      return;
    }
    focusedPendingIdRef.current = nodeId;
    void actions.acknowledgeFocus(nodeId);
  }, [actions, nodeId, noteOpen, state.pendingFocusField, state.pendingFocusId]);

  useLayoutEffect(() => {
    if (!noteOpen || !noteRef.current) {
      return;
    }
    if (focusNoteOnOpenRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  }, [noteOpen]);

  if (!node) {
    return null;
  }

  const label = controlLabel(titleValue || node.title);
  const hasChildren = (state.childIdsByParent[nodeId]?.length ?? 0) > 0;
  const completed = node.completedAt !== null;
  const isCollapsed = node.isCollapsed && !locallyExpanded;
  const dragEnabled = !disabled && !dragDisabled && !readOnly;
  const rowStyle = {
    "--notes-depth": depth,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition
  } as CSSProperties;
  const guides = ancestorGuideDepths.length > 0 && (
    <span
      className="notes-node-guides"
      aria-hidden="true"
      style={
        {
          "--notes-guide-count": ancestorGuideDepths.length
        } as CSSProperties
      }
    >
      {ancestorGuideDepths.map((guideDepth) => (
        <span
          className="notes-node-guide"
          aria-hidden="true"
          key={guideDepth}
        />
      ))}
    </span>
  );

  if (readOnly) {
    return (
      <div
        ref={setNodeRef}
        className="notes-node notes-node-readonly"
        data-outline-id={nodeId}
        data-guide-end-id={visibleDescendantEndId ?? undefined}
        data-selected={state.selectedId === nodeId ? "true" : undefined}
        style={rowStyle}
      >
        {guides}
        <div className="notes-node-main notes-node-main-readonly">
          <div className="notes-node-menu-slot">
            {readOnlyMode === "trash" && (
              <NotesBulletMenu
                mode="trash"
                label={label}
                disabled={disabled}
                onRestore={() => void actions.restoreNode(nodeId)}
              />
            )}
          </div>
          <span className="notes-node-readonly-title">{label}</span>
        </div>
        {node.note.trim() && (
          <p className="notes-node-readonly-note">{node.note}</p>
        )}
        <NotesAttachmentList
          nodeId={nodeId}
          attachments={attachments}
          className="notes-node-attachments notes-node-attachments-readonly"
          readOnly
        />
      </div>
    );
  }

  const draftPatch = () => ({
    title: titleValue,
    note: noteValue
  });

  const draftToSave = (force = false) => {
    if (!force && !draft) {
      return undefined;
    }
    return draftPatch();
  };

  const saveDrafts = () => {
    if (!draft) {
      return;
    }
    void actions.flushNodeDraft(nodeId);
  };

  const suppressHandledBlur = () => {
    suppressedBlurPatchRef.current = draftPatch();
  };

  const commitDrafts = () => {
    const suppressedPatch = suppressedBlurPatchRef.current;
    suppressedBlurPatchRef.current = null;
    const patch = draftPatch();
    if (
      suppressedPatch?.title === patch.title &&
      suppressedPatch.note === patch.note
    ) {
      return;
    }
    saveDrafts();
  };

  const runStructuralCommand = (command: () => Promise<void>) => {
    if (structuralCommandInFlightRef.current) {
      return;
    }
    structuralCommandInFlightRef.current = true;
    let completion: Promise<void>;
    try {
      completion = command();
    } catch {
      structuralCommandInFlightRef.current = false;
      return;
    }
    const settle = () => {
      structuralCommandInFlightRef.current = false;
    };
    void completion.then(settle, settle);
  };

  const openAndFocusNote = () => {
    focusNoteOnOpenRef.current = true;
    setNoteOpen(true);
    if (noteOpen && noteRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  };

  const removeNote = () => {
    setNoteOpen(false);
    actions.updateNodeDraft(nodeId, { title: titleValue, note: "" }, "note");
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
      visibleNodeIds
    });
    if (!resolution) {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    if (
      resolution.type !== "focus" &&
      structuralCommandInFlightRef.current
    ) {
      return;
    }
    switch (resolution.type) {
      case "split": {
        let newNodeId: NoteId;
        try {
          newNodeId = createNoteId();
        } catch {
          return;
        }
        runStructuralCommand(() => {
          const patch = draftToSave();
          suppressHandledBlur();
          return actions.splitNode(
            nodeId,
            newNodeId,
            resolution.prefix,
            resolution.suffix,
            {
              draft: patch
            }
          );
        });
        return;
      }
      case "move": {
        runStructuralCommand(() => {
          const patch = draftToSave();
          suppressHandledBlur();
          return actions.moveNode(resolution.input, resolution.focusNodeId, {
            draft: patch,
            expandNodeId: resolution.expandNodeId
          });
        });
        return;
      }
      case "focus":
        saveDrafts();
        suppressHandledBlur();
        void actions.focusNode(resolution.nodeId);
        return;
      case "focusNote":
        openAndFocusNote();
        return;
      case "toggleComplete":
        runStructuralCommand(() => actions.toggleComplete(nodeId));
        return;
      case "duplicate":
        runStructuralCommand(() => actions.duplicateNode(nodeId));
        return;
      case "delete":
        runStructuralCommand(() => actions.deleteNode(nodeId));
        return;
      case "toggleCollapsed":
        runStructuralCommand(() => actions.toggleCollapsed(nodeId));
        return;
      case "remove": {
        runStructuralCommand(() => {
          const patch = draftToSave(true)!;
          suppressHandledBlur();
          return actions.removeEmptyNode(nodeId, resolution.focusNodeId, {
            draft: patch
          });
        });
      }
    }
  };

  const handleImageDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleImageDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    void actions.importDroppedImages?.(
      nodeId,
      Array.from(event.dataTransfer.files)
    );
  };

  return (
    <div
      ref={setNodeRef}
      className="notes-node"
      data-outline-id={nodeId}
      data-completed={completed ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      data-guide-end-id={visibleDescendantEndId ?? undefined}
      data-selected={state.selectedId === nodeId ? "true" : undefined}
      style={rowStyle}
      onDragOver={handleImageDragOver}
      onDrop={handleImageDrop}
    >
      {guides}
      <div className="notes-node-main">
        <div className="notes-node-menu-slot">
          <NotesBulletMenu
            label={label}
            completed={completed}
            starred={node.isStarred}
            hasNote={Boolean(noteValue.trim())}
            saveFailed={draft?.status === "failed"}
            disabled={disabled}
            exportDisabled={exportController.unavailable || exportController.busy}
            onToggleComplete={() =>
              runStructuralCommand(() => actions.toggleComplete(nodeId))
            }
            onToggleStar={() =>
              runStructuralCommand(() => actions.toggleStar(nodeId))
            }
            onOpenNote={openAndFocusNote}
            onAddDate={() => {
              datePicker.openTitleDate(titleSelectionRef.current ?? undefined);
              titleSelectionRef.current = null;
            }}
            onUploadImage={
              actions.uploadImage
                ? () => void actions.uploadImage?.(nodeId)
                : undefined
            }
            onRemoveNote={removeNote}
            onDuplicate={() =>
              runStructuralCommand(() => actions.duplicateNode(nodeId))
            }
            onExport={(format) =>
              exportController.startExport(nodeId, titleValue, format)
            }
            onDelete={() =>
              runStructuralCommand(() => actions.deleteNode(nodeId))
            }
            onRetrySave={() =>
              runStructuralCommand(() => retryFailedDraft(nodeId))
            }
          />
        </div>

        <span className="notes-node-arrow-slot">
          {hasChildren && (
            <IconTooltip label={isCollapsed ? "Expand" : "Collapse"}>
              <button
                className="notes-row-icon-button notes-collapse-button"
                type="button"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
                aria-expanded={!isCollapsed}
                disabled={disabled}
                onClick={() =>
                  runStructuralCommand(() => actions.toggleCollapsed(nodeId))
                }
              >
                {isCollapsed ? (
                  <ChevronRight size={12} aria-hidden="true" />
                ) : (
                  <ChevronDown size={12} aria-hidden="true" />
                )}
              </button>
            </IconTooltip>
          )}
        </span>

        <button
          ref={setActivatorNodeRef}
          className="notes-node-bullet"
          type="button"
          {...(dragEnabled ? attributes : {})}
          {...(dragEnabled ? listeners : {})}
          aria-label={`Zoom into ${label}`}
          disabled={disabled}
          data-collapsed={hasChildren && isCollapsed ? "true" : undefined}
          data-sortable-activator={dragEnabled ? "true" : undefined}
          onClick={() => void actions.zoomTo(nodeId)}
        >
          <span className="notes-node-bullet-dot" aria-hidden="true" />
        </button>

        <NoteTextField
          className="notes-node-title"
          containerClassName="notes-node-title-field"
          ref={titleRef}
          value={titleValue}
          aria-label="Edit node title"
          placeholder="Untitled"
          rows={1}
          wrap="soft"
          disabled={disabled}
          today={datePicker.today}
          onDateClick={
            disabled
              ? undefined
              : (token, anchor) =>
                  datePicker.openExistingDate("title", token, anchor)
          }
          onDateTrigger={
            disabled
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
          onChange={(event) => {
            resizeTextarea(event.currentTarget);
            actions.updateNodeDraft(nodeId, {
              title: event.target.value,
              note: noteValue
            }, "title")
          }}
          onKeyDown={handleTitleKeyDown}
          onSelect={(event) => {
            titleSelectionRef.current = {
              startUtf16: event.currentTarget.selectionStart,
              endUtf16: event.currentTarget.selectionEnd
            };
          }}
          onBlur={(event) => {
            titleSelectionRef.current = {
              startUtf16: event.currentTarget.selectionStart,
              endUtf16: event.currentTarget.selectionEnd
            };
            if (!datePicker.shouldSuppressBlur()) {
              commitDrafts();
            }
          }}
        />
      </div>

      {noteOpen && (
        <NoteTextField
          ref={noteRef}
          className="notes-node-note"
          containerClassName="notes-node-note-field"
          value={noteValue}
          aria-label={`Supporting note: ${label}`}
          rows={2}
          disabled={disabled}
          today={datePicker.today}
          onDateClick={
            disabled
              ? undefined
              : (token, anchor) =>
                  datePicker.openExistingDate("note", token, anchor)
          }
          onDateTrigger={
            disabled
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
          onKeyDown={(event) => {
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
            }
          }}
          onChange={(event) => {
            resizeTextarea(event.currentTarget);
            actions.updateNodeDraft(nodeId, {
              title: titleValue,
              note: event.target.value
            }, "note");
          }}
          onBlur={() => {
            if (!datePicker.shouldSuppressBlur()) {
              commitDrafts();
            }
          }}
        />
      )}
      <NotesAttachmentList
        nodeId={nodeId}
        attachments={attachments}
        uploadError={attachmentUploadError}
        uploadRetryAttemptId={attachmentUploadRetryAttemptId}
        className="notes-node-attachments"
        readOnly={disabled}
      />
      {datePicker.picker}
    </div>
  );
}
