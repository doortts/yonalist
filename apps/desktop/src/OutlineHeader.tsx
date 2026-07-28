import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { handlePageKeyDown } from "./outlineSupport";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  OutlineTextField, type OutlineTagToken
} from "./OutlineTextField";

export function OutlineHeader({
  store,
  target,
  nodes,
  visibleNodes,
  index,
  visibleIndex,
  pageTitle,
  zoomed,
  showCompleted,
  error,
  onToggleCompleted,
  onBack,
  onTagClick,
  onClose,
  selectionToolbar
}: {
  readonly store: NotesStore;
  readonly target: { readonly id: string; readonly text: string };
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly index: OutlineIndex;
  readonly visibleIndex: OutlineIndex;
  readonly pageTitle: string;
  readonly zoomed: boolean;
  readonly showCompleted: boolean;
  readonly error: string | null;
  readonly onToggleCompleted: () => void;
  readonly onBack: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onClose?: () => void;
  readonly selectionToolbar?: ReactNode;
}) {
  const state = store.getSnapshot();
  return (
    <>
      {selectionToolbar ?? <div className="notes-outline-toolbar">
        {zoomed ? (
          <button className="text-button" type="button" onClick={onBack}>
            {pageTitle}
          </button>
        ) : <span className="eyebrow">Notes</span>}
        <button
          className="notes-completed-toggle"
          type="button"
          aria-label="Completed items"
          aria-pressed={showCompleted}
          onClick={onToggleCompleted}
        >
          <Check size={16} aria-hidden="true" />
        </button>
        {onClose && (
          <button className="notes-completed-toggle" type="button" aria-label="Close split" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>}
      {error && <div className="notes-inline-error" role="alert">{error}</div>}
      <header className="notes-page-header">
        <div className="notes-page-title-row">
          <span className="notes-page-menu-slot" />
          <div className="notes-page-primary">
            <h2 className="notes-page-heading">
              <OutlineTextField
                markdown
                className="notes-page-title"
                containerClassName="notes-page-title-field"
                data-node-id={target.id}
                data-outline-field="title"
                aria-label="Page title"
                rows={1}
                value={state.drafts[target.id] ?? target.text}
                placeholder="Untitled page"
                onTagClick={onTagClick}
                onChange={(event) => store.setDraft(target.id, event.target.value)}
                onKeyDown={(event) => handlePageKeyDown(
                  event,
                  store,
                  target.id,
                  nodes,
                  visibleNodes,
                  index,
                  visibleIndex,
                  onBack
                )}
                onKeyUp={(event) => {
                  if (event.key === "Backspace") store.endBackspaceGesture();
                }}
                onBlur={() => void store.flushDraft(target.id)}
              />
            </h2>
          </div>
        </div>
      </header>
    </>
  );
}
