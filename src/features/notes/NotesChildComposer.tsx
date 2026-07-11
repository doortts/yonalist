import { Plus } from "lucide-react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NoteId } from "../../domain/notes";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";

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
  const { actions } = useNotesWorkspaceContext();

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
          disabled={disabled}
          onClick={() => void actions.createChild(parentId)}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </IconTooltip>
    </div>
  );
}
