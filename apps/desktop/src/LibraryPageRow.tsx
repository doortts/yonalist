import { FileText, MoreHorizontal, Trash2 } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";
import type { NotesStore } from "./notesStore";
import { useNotesNode } from "./useNotesNode";

export function LibraryPageRow({
  page,
  active,
  store,
  onOpen,
  onDelete
}: {
  readonly page: PageSummary;
  readonly active: boolean;
  readonly store: NotesStore;
  readonly onOpen: () => void;
  readonly onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { title } = useNotesNode(store, page.id);
  return (
    <div
      className="notes-library-page-row"
      data-active={active ? "true" : undefined}
      style={{ position: "relative" }}
    >
      <button
        className="notes-library-page"
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onOpen}
      >
        <FileText size={16} aria-hidden="true" />
        <span>{title || "Untitled page"}</span>
      </button>
      <button
        className="notes-library-page-menu-trigger"
        type="button"
        aria-label={`Page actions for ${title || "Untitled page"}`}
        data-popup-open={menuOpen ? "true" : undefined}
        onClick={() => setMenuOpen((value) => !value)}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div
          className="notes-library-page-menu"
          role="menu"
          style={{
            position: "absolute",
            insetInlineEnd: 0,
            insetBlockStart: 34
          } as CSSProperties}
        >
          <button
            className="notes-library-page-menu-item"
            type="button"
            role="menuitem"
            data-danger="true"
            style={{ width: "100%", border: 0, background: "transparent" }}
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>Move page to Trash</span>
          </button>
        </div>
      )}
    </div>
  );
}
