import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { NotesStore } from "./notesStore";

export function NotesChildComposer({
  store, parentId, hasChildren
}: {
  readonly store: NotesStore;
  readonly parentId: string;
  readonly hasChildren: boolean;
}) {
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);

  const createChild = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const id = await store.createNode(parentId);
      requestAnimationFrame(() => {
        [...document.querySelectorAll<HTMLTextAreaElement>("[data-node-id]")]
          .find((editor) => editor.dataset.nodeId === id)
          ?.focus();
      });
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div
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
