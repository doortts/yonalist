import type { NotesStore } from "../notesStore";
import type { NotesShellSnapshot } from "../store/storeSubscriptions";
import { MobileIcon } from "./MobileIcon";
import { MobileOutline } from "./MobileOutline";

/**
 * One page, opened from the list.
 *
 * The way back is a button rather than the outline's breadcrumb: on a phone
 * there is one page open at a time and one place to go back to, so a trail of
 * crumbs would be a trail of one.
 */
export function MobilePage({
  store,
  shell,
  title,
  showCompleted,
  onShowCompletedChange,
  onBack
}: {
  readonly store: NotesStore;
  readonly shell: NotesShellSnapshot;
  readonly title: string;
  readonly showCompleted: boolean;
  readonly onShowCompletedChange: (visible: boolean) => void;
  readonly onBack: () => void;
}) {
  return (
    <>
      <header className="mobile-day-header">
        <button
          className="mobile-day-step"
          type="button"
          aria-label="Back to pages"
          onClick={onBack}
        >
          <MobileIcon name="chevron-left" size={18} />
        </button>
        <div className="mobile-day-names">
          <h1 className="mobile-day-date">{title || "Untitled page"}</h1>
        </div>
      </header>
      <MobileOutline
        store={store}
        shell={shell}
        showCompleted={showCompleted}
        onShowCompletedChange={onShowCompletedChange}
      />
    </>
  );
}
