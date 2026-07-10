import { useSortable } from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  MessageSquareText,
  RotateCcw,
  Star,
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
  readOnly?: boolean;
  locallyExpanded?: boolean;
}

function controlLabel(title: string): string {
  return title.trim() || "Untitled node";
}

export function OutlineNodeRow({
  nodeId,
  depth,
  dragDisabled,
  readOnly = false,
  locallyExpanded = false
}: OutlineNodeRowProps) {
  const {
    actions,
    draftsByNodeId,
    retryFailedDraft,
    state
  } = useNotesWorkspaceContext();
  const node = state.nodesById[nodeId];
  const draft = draftsByNodeId[nodeId];
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
    disabled: dragDisabled || readOnly,
    attributes: {
      role: "button",
      roleDescription: "sortable note",
      tabIndex: 0
    }
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const focusedPendingIdRef = useRef<NoteId | null>(null);
  const structuralCommandInFlightRef = useRef(false);
  const suppressedBlurPatchRef = useRef<{
    title: string;
    note: string;
  } | null>(null);

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

  const titleValue = draft?.title ?? node.title;
  const noteValue = draft?.note ?? node.note;
  const label = controlLabel(titleValue || node.title);
  const hasChildren = (state.childIdsByParent[nodeId]?.length ?? 0) > 0;
  const completed = node.completedAt !== null;
  const isCollapsed = node.isCollapsed && !locallyExpanded;
  const rowStyle = {
    "--notes-indent": `min(${depth * 24}px, 20%)`,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition
  } as CSSProperties;

  if (readOnly) {
    return (
      <div
        ref={setNodeRef}
        className="notes-node notes-node-readonly"
        data-outline-id={nodeId}
        style={rowStyle}
      >
        <div className="notes-node-main notes-node-main-readonly">
          <span className="notes-node-readonly-title">{label}</span>
          <div className="notes-node-actions">
            <IconTooltip label="Restore">
              <button
                className="notes-row-icon-button"
                type="button"
                aria-label={`Restore ${label}`}
                onClick={() => void actions.restoreNode(nodeId)}
              >
                <RotateCcw size={15} aria-hidden="true" />
              </button>
            </IconTooltip>
          </div>
        </div>
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
      title: titleValue,
      note: noteValue,
      nodeId,
      workspace: state
    });
    if (!resolution) {
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
            <IconTooltip label={isCollapsed ? "Expand" : "Collapse"}>
              <button
                className="notes-row-icon-button notes-collapse-button"
                type="button"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
                aria-expanded={!isCollapsed}
                onClick={() =>
                  runStructuralCommand(() => actions.toggleCollapsed(nodeId))
                }
              >
                {isCollapsed ? (
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
          value={titleValue}
          aria-label="Edit node title"
          placeholder="Untitled"
          onChange={(event) =>
            actions.updateNodeDraft(nodeId, {
              title: event.target.value,
              note: noteValue
            })
          }
          onKeyDown={handleTitleKeyDown}
          onBlur={commitDrafts}
          onDoubleClick={() => void actions.zoomTo(nodeId)}
        />

        <div className="notes-node-actions">
          {draft?.status === "failed" && (
            <IconTooltip label="Retry save">
              <button
                className="notes-row-icon-button"
                type="button"
                aria-label="Retry save"
                onClick={() => void retryFailedDraft(nodeId)}
              >
                <RotateCcw size={15} aria-hidden="true" />
              </button>
            </IconTooltip>
          )}
          <IconTooltip label={node.isStarred ? "Unstar" : "Star"}>
            <button
              className="notes-row-icon-button"
              type="button"
              aria-label={`${node.isStarred ? "Unstar" : "Star"} ${label}`}
              aria-pressed={node.isStarred}
              onClick={() => void actions.toggleStar(nodeId)}
            >
              <Star
                size={15}
                fill={node.isStarred ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
          </IconTooltip>
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
          value={noteValue}
          aria-label={`Supporting note: ${label}`}
          rows={2}
          onChange={(event) =>
            actions.updateNodeDraft(nodeId, {
              title: titleValue,
              note: event.target.value
            })
          }
          onBlur={commitDrafts}
        />
      )}
    </div>
  );
}
