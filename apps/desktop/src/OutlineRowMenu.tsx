import {
  Check, Circle, Copy, ImagePlus, MessageSquareText, SquareCheckBig, Star,
  Trash2
} from "lucide-react";
import type { CSSProperties } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import { RowMenuItem } from "./outlineSupport";

/**
 * The per-row action menu. It is only ever reached by clicking a row's
 * trigger, so it loads on demand and stays out of the editable first-paint
 * bundle — the same arrangement the slash-command menu already uses.
 */
export function OutlineRowMenu({
  node, store, hasNote, onClose, onAddNote, onDuplicate, onPickImage
}: {
  readonly node: NoteView;
  readonly store: NotesStore;
  readonly hasNote: boolean;
  readonly onClose: () => void;
  readonly onAddNote: () => void;
  readonly onDuplicate: () => void;
  readonly onPickImage: () => void;
}) {
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div
      className="notes-bullet-menu"
      role="menu"
      style={{
        "--available-height": "420px",
        position: "absolute",
        insetInlineStart: 0,
        insetBlockStart: 28
      } as CSSProperties}
    >
      <RowMenuItem
        icon={<MessageSquareText size={14} aria-hidden="true" />}
        label={hasNote ? "Edit note" : "Add note"}
        onClick={run(onAddNote)}
      />
      <RowMenuItem
        icon={node.marker === "todo"
          ? <Circle size={14} aria-hidden="true" />
          : <SquareCheckBig size={14} aria-hidden="true" />}
        label={node.marker === "todo" ? "Change to bullet" : "To-do"}
        onClick={run(() => void store.setMarker(
          node.id,
          node.marker === "todo" ? "bullet" : "todo"
        ))}
      />
      <RowMenuItem
        icon={<Copy size={14} aria-hidden="true" />}
        label="Duplicate"
        onClick={run(onDuplicate)}
      />
      <RowMenuItem
        icon={<ImagePlus size={14} aria-hidden="true" />}
        label="Upload image"
        onClick={run(onPickImage)}
      />
      <RowMenuItem
        icon={<Check size={14} aria-hidden="true" />}
        label={node.completed ? "Mark incomplete" : "Complete"}
        onClick={run(() => void store.setCompleted(node.id, !node.completed))}
      />
      <RowMenuItem
        icon={<Star size={14} aria-hidden="true" />}
        label={node.starred ? "Unstar" : "Star"}
        onClick={run(() => void store.setStarred(node.id, !node.starred))}
      />
      <RowMenuItem
        danger
        icon={<Trash2 size={14} aria-hidden="true" />}
        label="Move to Trash"
        onClick={run(() => void store.deleteSubtree(node.id))}
      />
    </div>
  );
}
