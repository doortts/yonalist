import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { NotesStore } from "./notesStore";
import { focusOutlineEditor } from "./outlineFocus";

export function NotesChildComposer({
  store, parentId, hasChildren
}: {
  readonly store: NotesStore;
  readonly parentId: string;
  readonly hasChildren: boolean;
}) {
  const creatingRef = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);

  const createChild = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const pending = store.beginCreateNode(parentId);
      const scope = composerRef.current?.closest<HTMLElement>(".notes-outline");
      if (scope) {
        requestAnimationFrame(() =>
          focusOutlineEditor(scope, pending.id, "start"));
      }
      await pending.committed;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div
      ref={composerRef}
      className="notes-child-composer"
      data-has-children={hasChildren ? "true" : "false"}
    >
      <button
        className="notes-child-composer-button"
        type="button"
        aria-label="Add child"
        aria-disabled={creating ? "true" : undefined}
        data-pending={creating ? "true" : undefined}
        onClick={() => void createChild()}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
