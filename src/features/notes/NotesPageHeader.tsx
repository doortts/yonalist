import { RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NoteId } from "../../domain/notes";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";

interface NotesPageHeaderProps {
  nodeId: NoteId;
  disabled?: boolean;
}

function pageLabel(title: string): string {
  return title.trim() || "Untitled page";
}

function resizeNote(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function NotesPageHeader({
  nodeId,
  disabled = false
}: NotesPageHeaderProps) {
  const {
    actions,
    draftsByNodeId,
    retryFailedDraft,
    state
  } = useNotesWorkspaceContext();
  const node = state.nodesById[nodeId];
  const draft = draftsByNodeId[nodeId];
  const titleRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleValue = draft?.title ?? node?.title ?? "";
  const noteValue = draft?.note ?? node?.note ?? "";
  const label = pageLabel(titleValue || node?.title || "");

  useLayoutEffect(() => {
    resizeNote(noteRef.current);
  }, [noteValue]);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId || !titleRef.current) {
      return;
    }
    titleRef.current.focus();
    if (document.activeElement === titleRef.current) {
      void actions.acknowledgeFocus(nodeId);
    }
  }, [actions, nodeId, state.pendingFocusId]);

  if (!node) {
    return null;
  }

  return (
    <header className="notes-page-header">
      <div className="notes-page-title-row">
        <h1 className="notes-page-heading" aria-label={label}>
          <input
            ref={titleRef}
            className="notes-page-title"
            value={titleValue}
            aria-label="Edit page title"
            placeholder="Untitled page"
            disabled={disabled}
            onChange={(event) =>
              actions.updateNodeDraft(nodeId, {
                title: event.target.value,
                note: noteValue
              })
            }
            onBlur={() => void actions.flushNodeDraft(nodeId)}
          />
        </h1>
        {draft?.status === "failed" && (
          <IconTooltip label="Retry save">
            <button
              className="notes-row-icon-button notes-page-retry"
              type="button"
              aria-label="Retry save"
              disabled={disabled}
              onClick={() => void retryFailedDraft(nodeId)}
            >
              <RotateCcw size={15} aria-hidden="true" />
            </button>
          </IconTooltip>
        )}
      </div>
      <textarea
        ref={noteRef}
        className="notes-page-note"
        value={noteValue}
        aria-label={`Supporting note: ${label}`}
        placeholder="Add a supporting note"
        rows={1}
        disabled={disabled}
        onChange={(event) => {
          resizeNote(event.currentTarget);
          actions.updateNodeDraft(nodeId, {
            title: titleValue,
            note: event.target.value
          });
        }}
        onBlur={() => void actions.flushNodeDraft(nodeId)}
      />
    </header>
  );
}
