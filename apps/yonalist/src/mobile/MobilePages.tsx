import type { PageSummary } from "../../../../packages/contracts/generated/PageSummary";
import { journalDateOf } from "../journal";

/**
 * Every page that is not a day.
 *
 * Days are left out for the same reason the desktop leaves them out of its own
 * page list: a year of them would bury everything else, and the Journals tab is
 * where they are read. Which pages are days is derived from the title, as it is
 * everywhere else, rather than stored.
 */
export function MobilePages({
  pages,
  onOpenPage
}: {
  readonly pages: readonly PageSummary[];
  readonly onOpenPage: (pageId: string) => void;
}) {
  const listed = pages.filter((page) => journalDateOf(page.title) === null);

  if (listed.length === 0) {
    return <p className="mobile-empty">No pages yet.</p>;
  }

  return (
    <ul className="mobile-list" role="list">
      {listed.map((page) => (
        <li key={page.id}>
          <button
            className="mobile-list-row"
            type="button"
            onClick={() => onOpenPage(page.id)}
          >
            {page.title || "Untitled page"}
          </button>
        </li>
      ))}
    </ul>
  );
}
