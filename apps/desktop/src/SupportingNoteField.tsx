import type { Ref } from "react";
import { focusOutlineEditor, type OutlineFocusEdge } from "./outlineFocus";
import type { NotesStore } from "./notesStore";
import { resolveSupportingNoteKey } from "./outlineKeyboard";
import {
  OutlineTextField, type OutlineTagToken
} from "./OutlineTextField";

export interface SupportingNoteTargets {
  /** The row Down out of the note lands on, or null when there is none. */
  readonly nextRowId: string | null;
  /** Where Down lands with no next row; null stays in the note. */
  readonly fallbackFocusId: string | null;
  /** Parent of the row Shift+Enter starts when there is no next row. */
  readonly createParentId: string;
}

/**
 * The note under a title, wherever the title hangs: an outline row or the page
 * heading. The two differ only in where the keyboard leaves the field, and
 * they resolve that at event time -- a memoized row has no current view of the
 * outline while it renders.
 */
export function SupportingNoteField({
  store,
  nodeId,
  value,
  ariaLabel,
  className,
  containerClassName,
  targets,
  onTagClick,
  onAutoHide,
  ref
}: {
  readonly store: NotesStore;
  readonly nodeId: string;
  readonly value: string;
  readonly ariaLabel: string;
  readonly className: string;
  readonly containerClassName: string;
  readonly targets: () => SupportingNoteTargets;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onAutoHide: () => void;
  readonly ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <OutlineTextField
      ref={ref}
      className={className}
      containerClassName={containerClassName}
      data-node-id={nodeId}
      data-outline-field="note"
      aria-label={ariaLabel}
      rows={1}
      value={value}
      placeholder="Add a supporting note"
      onTagClick={onTagClick}
      onChange={(event) => store.setNoteDraft(nodeId, event.target.value)}
      onKeyDown={(event) => {
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
        if (!resolution) return;
        event.preventDefault();
        const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
        if (!scope) return;
        const focusAfterFlush = (
          id: string,
          edge: OutlineFocusEdge = "preserve"
        ): void => {
          void store.flushNoteDraft(nodeId).then(() => requestAnimationFrame(
            () => focusOutlineEditor(scope, id, edge)
          ));
        };
        if (resolution === "currentTitle") {
          focusAfterFlush(nodeId);
          return;
        }
        if (resolution === "removeEmptyNote") {
          // The field goes now rather than after the round trip; the flush it
          // leaves behind still commits the erase.
          onAutoHide();
          focusAfterFlush(nodeId, "end");
          return;
        }
        const { nextRowId, fallbackFocusId, createParentId } = targets();
        if (nextRowId) {
          focusAfterFlush(nextRowId);
          return;
        }
        if (resolution === "nextTitleOrCreate") {
          void store.flushNoteDraft(nodeId)
            .then(() => store.createNode(createParentId))
            .then((id) => requestAnimationFrame(
              () => focusOutlineEditor(scope, id, "start")
            ));
          return;
        }
        if (fallbackFocusId) focusAfterFlush(fallbackFocusId);
      }}
      onBlur={(event) => {
        const submittedNote = event.currentTarget.value;
        void store.flushNoteDraft(nodeId).then(() => {
          if (submittedNote.trim().length === 0) onAutoHide();
        });
      }}
    />
  );
}
