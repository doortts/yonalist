import {
  ChevronDown,
  ChevronRight,
  Copy,
  MessageSquareText,
  Trash2
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NoteId } from "../../domain/notes";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";

interface OutlineNodeRowProps {
  nodeId: NoteId;
  depth: number;
}

interface DraftField {
  value: string;
  dirty: boolean;
  submitted: string | null;
}

function initialDraft(value: string): DraftField {
  return { value, dirty: false, submitted: null };
}

function synchronizeDraft(
  draft: DraftField,
  authoritativeValue: string
): DraftField {
  if (draft.submitted === authoritativeValue) {
    return {
      value: draft.value,
      dirty: draft.value !== authoritativeValue,
      submitted: null
    };
  }
  if (draft.dirty || draft.submitted !== null) {
    return draft;
  }
  return draft.value === authoritativeValue
    ? draft
    : initialDraft(authoritativeValue);
}

function controlLabel(title: string): string {
  return title.trim() || "Untitled node";
}

export function OutlineNodeRow({ nodeId, depth }: OutlineNodeRowProps) {
  const { actions, state } = useNotesWorkspaceContext();
  const node = state.nodesById[nodeId];
  const [titleDraft, setTitleDraft] = useState(() =>
    initialDraft(node?.title ?? "")
  );
  const [noteDraft, setNoteDraft] = useState(() =>
    initialDraft(node?.note ?? "")
  );
  const [noteOpen, setNoteOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const focusedPendingIdRef = useRef<NoteId | null>(null);

  useEffect(() => {
    if (!node) {
      return;
    }
    setTitleDraft((draft) => synchronizeDraft(draft, node.title));
    setNoteDraft((draft) => synchronizeDraft(draft, node.note));
  }, [node]);

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
    "--notes-indent": `min(${depth * 24}px, 20%)`
  } as CSSProperties;

  const commitDrafts = () => {
    const patch = {
      title: titleDraft.value,
      note: noteDraft.value
    };
    if (patch.title === node.title && patch.note === node.note) {
      setTitleDraft(initialDraft(node.title));
      setNoteDraft(initialDraft(node.note));
      return;
    }
    setTitleDraft((draft) => ({
      ...draft,
      dirty: false,
      submitted: patch.title
    }));
    setNoteDraft((draft) => ({
      ...draft,
      dirty: false,
      submitted: patch.note
    }));
    void actions.updateNode(nodeId, patch);
  };

  return (
    <div
      className="notes-node"
      data-completed={completed ? "true" : undefined}
      style={rowStyle}
    >
      <div className="notes-node-main">
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
                event.target.value !== (draft.submitted ?? node.title)
            }))
          }
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
              dirty: event.target.value !== (draft.submitted ?? node.note)
            }))
          }
          onBlur={commitDrafts}
        />
      )}
    </div>
  );
}
