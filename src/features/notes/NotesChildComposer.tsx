import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NoteId } from "../../domain/notes";
import { useNotesActions } from "./NotesWorkspaceContext";

export interface NotesChildComposerProps {
  parentId: NoteId;
  disabled: boolean;
  hasChildren: boolean;
}

export function NotesChildComposer({
  parentId,
  disabled,
  hasChildren
}: NotesChildComposerProps) {
  const { actions } = useNotesActions();
  const createInFlightRef = useRef(false);
  const [creating, setCreating] = useState(false);

  const createChild = () => {
    if (disabled || createInFlightRef.current) {
      return;
    }
    createInFlightRef.current = true;
    setCreating(true);
    let completion: Promise<unknown>;
    try {
      completion = actions.createChild(parentId);
    } catch {
      createInFlightRef.current = false;
      setCreating(false);
      return;
    }
    const settle = () => {
      createInFlightRef.current = false;
      setCreating(false);
    };
    void completion.then(settle, settle);
  };

  return (
    <div
      className="notes-child-composer"
      data-has-children={hasChildren ? "true" : "false"}
    >
      <IconTooltip label="Add child">
        <button
          className="notes-child-composer-button"
          type="button"
          aria-label="Add child"
          aria-disabled={creating ? "true" : undefined}
          data-pending={creating ? "true" : undefined}
          disabled={disabled}
          onClick={createChild}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </IconTooltip>
    </div>
  );
}
