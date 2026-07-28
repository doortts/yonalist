import { FileText, MoreHorizontal, Trash2 } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";
import type { NotesStore } from "./notesStore";

export function LibraryPageRow({
  page,
  active,
  draft,
  store,
  onOpen
}: {
  readonly page: PageSummary;
  readonly active: boolean;
  readonly draft: string | undefined;
  readonly store: NotesStore;
  readonly onOpen: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
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
        <span>{(draft ?? page.title) || "Untitled page"}</span>
      </button>
      <button
        className="notes-library-page-menu-trigger"
        type="button"
        aria-label={`Page actions for ${page.title}`}
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
              void store.deleteSubtree(page.id);
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
