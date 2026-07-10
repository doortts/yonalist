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

function controlLabel(title: string): string {
  return title.trim() || "Untitled node";
}

export function OutlineNodeRow({ nodeId, depth }: OutlineNodeRowProps) {
  const { actions, state } = useNotesWorkspaceContext();
  const node = state.nodesById[nodeId];
  const [titleDraft, setTitleDraft] = useState(node?.title ?? "");
  const [noteDraft, setNoteDraft] = useState(node?.note ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const focusedPendingIdRef = useRef<NoteId | null>(null);

  useEffect(() => {
    if (!node) {
      return;
    }
    setTitleDraft(node.title);
    setNoteDraft(node.note);
  }, [node?.note, node?.title]);

  useEffect(() => {
    if (
      state.pendingFocusId !== nodeId ||
      focusedPendingIdRef.current === nodeId
    ) {
      return;
    }
    focusedPendingIdRef.current = nodeId;
    titleRef.current?.focus();
  }, [nodeId, state.pendingFocusId]);

  if (!node) {
    return null;
  }

  const label = controlLabel(titleDraft || node.title);
  const hasChildren = (state.childIdsByParent[nodeId]?.length ?? 0) > 0;
  const completed = node.completedAt !== null;
  const rowStyle = { "--notes-indent": `${depth * 24}px` } as CSSProperties;

  const commitDrafts = () => {
    if (titleDraft === node.title && noteDraft === node.note) {
      return;
    }
    void actions.updateNode(nodeId, {
      title: titleDraft,
      note: noteDraft
    });
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
          value={titleDraft}
          aria-label={
            titleDraft.trim()
              ? `Edit node title: ${titleDraft}`
              : "Edit node title"
          }
          placeholder="Untitled"
          onChange={(event) => setTitleDraft(event.target.value)}
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
          value={noteDraft}
          aria-label={`Supporting note: ${label}`}
          rows={2}
          onChange={(event) => setNoteDraft(event.target.value)}
          onBlur={commitDrafts}
        />
      )}
    </div>
  );
}
