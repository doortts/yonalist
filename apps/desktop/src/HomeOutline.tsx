import { House } from "lucide-react";
import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";
import type { NotesStore } from "./notesStore";
import type { NotesShellSnapshot } from "./storeSubscriptions";
import { useNotesNode } from "./useNotesNode";

/**
 * Every page as a top-level bullet. Read-only on purpose: pages are created
 * from the sidebar, and a page opens by clicking its row.
 */
export function HomeOutline({
  pages,
  store,
  onOpenPage,
  status
}: {
  readonly pages: readonly PageSummary[];
  readonly store: NotesStore;
  readonly onOpenPage: (pageId: string) => void;
  readonly status: NotesShellSnapshot["status"];
}) {
  return (
    <section className="detail-pane" aria-label="Detail">
      <div className="pane-titlebar-spacer" />
      <div className="detail-scroll">
        <section className="notes-outline" aria-label="Home outline">
          <div className="notes-outline-toolbar">
            <button
              className="notes-breadcrumb-button notes-breadcrumb-home"
              type="button"
              aria-label="All pages"
              disabled
            >
              <House size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="notes-outline-rows">
            <div className="notes-outline-content">
              {pages.length === 0 && (
                <p className="notes-pane-state">
                  {status === "loading" ? "Loading notes..." : "No pages yet."}
                </p>
              )}
              {pages.map((page) => (
                <HomeRow
                  key={page.id}
                  page={page}
                  store={store}
                  onOpen={() => onOpenPage(page.id)}
                />
              ))}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

function HomeRow({
  page,
  store,
  onOpen
}: {
  readonly page: PageSummary;
  readonly store: NotesStore;
  readonly onOpen: () => void;
}) {
  const { title } = useNotesNode(store, page.id);
  const label = title || "Untitled page";
  return (
    <div className="notes-node-main notes-home-row">
      <button
        className="notes-node-bullet"
        type="button"
        aria-label={`Open ${label}`}
        onClick={onOpen}
      >
        <span className="notes-node-bullet-dot" />
      </button>
      <button className="notes-home-row-title" type="button" onClick={onOpen}>
        {label}
      </button>
    </div>
  );
}
