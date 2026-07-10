import { useSortable } from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  MessageSquareText,
  Trash2
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState
} from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import { createNoteId, type NoteId } from "../../domain/notes";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import { resolveOutlineKey } from "./outlineKeyboard";

interface OutlineNodeRowProps {
  nodeId: NoteId;
  depth: number;
  dragDisabled: boolean;
}

interface DraftField {
  value: string;
  dirty: boolean;
  pending: string | null;
}

function initialDraft(value: string): DraftField {
  return { value, dirty: false, pending: null };
}

function synchronizeDraft(
  draft: DraftField,
  authoritativeValue: string
): DraftField {
  if (draft.pending === authoritativeValue) {
    return {
      value: draft.value,
      dirty: draft.value !== authoritativeValue,
      pending: null
    };
  }
  if (draft.value === authoritativeValue) {
    return draft.dirty || draft.pending !== null
      ? initialDraft(authoritativeValue)
      : draft;
  }
  if (draft.dirty || draft.pending !== null) {
    return draft;
  }
  return initialDraft(authoritativeValue);
}

function controlLabel(title: string): string {
  return title.trim() || "Untitled node";
}

export function OutlineNodeRow({
  nodeId,
  depth,
  dragDisabled
}: OutlineNodeRowProps) {
  const { actions, state } = useNotesWorkspaceContext();
  const node = state.nodesById[nodeId];
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
    disabled: dragDisabled,
    attributes: {
      role: "button",
      roleDescription: "sortable note",
      tabIndex: 0
    }
  });
  const [titleDraft, setTitleDraft] = useState(() =>
    initialDraft(node?.title ?? "")
  );
  const [noteDraft, setNoteDraft] = useState(() =>
    initialDraft(node?.note ?? "")
  );
  const [noteOpen, setNoteOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const focusedPendingIdRef = useRef<NoteId | null>(null);
  const pendingSplitRef = useRef<{
    sourceTitle: string;
    prefix: string;
    succeeded: boolean;
  } | null>(null);
  const suppressedBlurPatchRef = useRef<{
    title: string;
    note: string;
  } | null>(null);

  useEffect(() => {
    if (!node) {
      return;
    }
    const pendingSplit = pendingSplitRef.current;
    setTitleDraft((draft) =>
      pendingSplit?.succeeded &&
      node.title === pendingSplit.prefix &&
      draft.value === pendingSplit.sourceTitle
        ? initialDraft(node.title)
        : synchronizeDraft(draft, node.title)
    );
    setNoteDraft((draft) => synchronizeDraft(draft, node.note));
    if (
      state.error !== null ||
      (pendingSplit?.succeeded && node.title === pendingSplit.prefix)
    ) {
      pendingSplitRef.current = null;
    }
  }, [node, state.error]);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId) {
      focusedPendingIdRef.current = null;
      return;
    }
    if (focusedPendingIdRef.current === nodeId) {
      return;
    }
    const titleInput = titleRef.current;
    if (!titleInput) {
      return;
    }
    titleInput.focus();
    if (document.activeElement !== titleInput) {
      return;
    }
    focusedPendingIdRef.current = nodeId;
    void actions.acknowledgeFocus(nodeId);
  }, [actions, nodeId, state.pendingFocusId]);

  if (!node) {
    return null;
  }

  const label = controlLabel(titleDraft.value || node.title);
  const hasChildren = (state.childIdsByParent[nodeId]?.length ?? 0) > 0;
  const completed = node.completedAt !== null;
  const rowStyle = {
    "--notes-indent": `min(${depth * 24}px, 20%)`,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition
  } as CSSProperties;

  const draftPatch = () => ({
    title: titleDraft.value,
    note: noteDraft.value
  });

  const draftToSave = (force = false) => {
    if (!force && !titleDraft.dirty && !noteDraft.dirty) {
      return undefined;
    }
    return draftPatch();
  };

  const markDraftPending = (patch: ReturnType<typeof draftPatch>) => {
    setTitleDraft((draft) => ({
      ...draft,
      pending: draft.value === patch.title ? patch.title : draft.pending
    }));
    setNoteDraft((draft) => ({
      ...draft,
      pending: draft.value === patch.note ? patch.note : draft.pending
    }));
  };

  const saveDrafts = (force = false) => {
    const patch = draftToSave(force);
    if (!patch) {
      return;
    }
    markDraftPending(patch);
    void actions.updateNode(nodeId, patch);
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

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
      title: titleDraft.value,
      note: noteDraft.value,
      nodeId,
      workspace: state
    });
    if (!resolution) {
      return;
    }

    event.preventDefault();
    switch (resolution.type) {
      case "split": {
        const patch = draftToSave();
        if (patch) {
          markDraftPending(patch);
        }
        const sourceTitle = titleDraft.value;
        const pendingSplit = {
          sourceTitle,
          prefix: resolution.prefix,
          succeeded: false
        };
        pendingSplitRef.current = pendingSplit;
        suppressHandledBlur();
        void actions.splitNode(
          nodeId,
          createNoteId(),
          resolution.prefix,
          resolution.suffix,
          {
            draft: patch,
            onSuccess: () => {
              if (pendingSplitRef.current === pendingSplit) {
                pendingSplit.succeeded = true;
              }
            }
          }
        );
        return;
      }
      case "move": {
        const patch = draftToSave();
        if (patch) {
          markDraftPending(patch);
        }
        suppressHandledBlur();
        void actions.moveNode(resolution.input, resolution.focusNodeId, {
          draft: patch,
          expandNodeId: resolution.expandNodeId
        });
        return;
      }
      case "focus":
        saveDrafts();
        suppressHandledBlur();
        void actions.focusNode(resolution.nodeId);
        return;
      case "toggleCollapsed":
        void actions.toggleCollapsed(nodeId);
        return;
      case "remove": {
        const patch = draftToSave(true)!;
        markDraftPending(patch);
        suppressHandledBlur();
        void actions.removeEmptyNode(nodeId, resolution.focusNodeId, {
          draft: patch
        });
      }
    }
  };

  return (
    <div
      ref={setNodeRef}
      className="notes-node"
      data-outline-id={nodeId}
      data-completed={completed ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      style={rowStyle}
    >
      <div className="notes-node-main">
        <IconTooltip label="Move">
          <button
            ref={setActivatorNodeRef}
            className="notes-row-icon-button notes-drag-handle"
            type="button"
            disabled={dragDisabled}
            {...attributes}
            {...listeners}
            aria-label={`Move ${label}`}
          >
            <GripVertical size={15} aria-hidden="true" />
          </button>
        </IconTooltip>

        <span className="notes-collapse-slot">
          {hasChildren && (
            <IconTooltip label={node.isCollapsed ? "Expand" : "Collapse"}>
              <button
                className="notes-row-icon-button notes-collapse-button"
                type="button"
                aria-label={`${node.isCollapsed ? "Expand" : "Collapse"} ${label}`}
                aria-expanded={!node.isCollapsed}
                onClick={() => void actions.toggleCollapsed(nodeId)}
              >
                {node.isCollapsed ? (
                  <ChevronRight size={15} aria-hidden="true" />
                ) : (
                  <ChevronDown size={15} aria-hidden="true" />
                )}
              </button>
            </IconTooltip>
          )}
        </span>

        <input
          className="notes-complete-checkbox"
          type="checkbox"
          checked={completed}
          aria-label={`Mark ${label} ${completed ? "incomplete" : "complete"}`}
          onChange={() => void actions.toggleComplete(nodeId)}
        />

        <input
          className="notes-node-title"
          ref={titleRef}
          value={titleDraft.value}
          aria-label={
            titleDraft.value.trim()
              ? `Edit node title: ${titleDraft.value}`
              : "Edit node title"
          }
          placeholder="Untitled"
          onChange={(event) =>
            setTitleDraft((draft) => ({
              ...draft,
              value: event.target.value,
              dirty:
                draft.pending !== null || event.target.value !== node.title
            }))
          }
          onKeyDown={handleTitleKeyDown}
          onBlur={commitDrafts}
          onDoubleClick={() => void actions.zoomTo(nodeId)}
        />

        <div className="notes-node-actions">
          <IconTooltip label={noteOpen ? "Hide note" : "Show note"}>
            <button
              className="notes-row-icon-button"
              type="button"
              aria-label={`${noteOpen ? "Hide" : "Show"} supporting note for ${label}`}
              aria-pressed={noteOpen}
              onClick={() => setNoteOpen((open) => !open)}
            >
              <MessageSquareText size={15} aria-hidden="true" />
            </button>
          </IconTooltip>
          <IconTooltip label="Duplicate">
            <button
              className="notes-row-icon-button"
              type="button"
              aria-label={`Duplicate ${label}`}
              onClick={() => void actions.duplicateNode(nodeId)}
            >
              <Copy size={15} aria-hidden="true" />
            </button>
          </IconTooltip>
          <IconTooltip label="Delete">
            <button
              className="notes-row-icon-button notes-delete-button"
              type="button"
              aria-label={`Delete ${label}`}
              onClick={() => void actions.deleteNode(nodeId)}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </IconTooltip>
        </div>
      </div>

      {noteOpen && (
        <textarea
          className="notes-node-note"
          value={noteDraft.value}
          aria-label={`Supporting note: ${label}`}
          rows={2}
          onChange={(event) =>
            setNoteDraft((draft) => ({
              ...draft,
              value: event.target.value,
              dirty:
                draft.pending !== null || event.target.value !== node.note
            }))
          }
          onBlur={commitDrafts}
        />
      )}
    </div>
  );
}
