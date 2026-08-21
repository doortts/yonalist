import { useMemo, useState } from "react";
import { JournalFeed } from "../JournalFeed";
import { journalDays } from "../journal";
import type { NotesStore } from "../notesStore";
import { localDateIso } from "../outline/outlineSlash";
import type { NotesShellSnapshot } from "../store/storeSubscriptions";

/**
 * The days, newest first.
 *
 * The desktop's feed is reused whole. It already holds the rules this screen
 * needs and that nothing should decide twice: the newest day is the one being
 * edited and the rest are read, the window grows a week at a time, and each
 * day's bar offers to carry over what the days before it left unfinished.
 *
 * Today itself is left out. It has its own tab, and a feed that opened on the
 * day you are already looking at would waste the first screen.
 */
export function MobileJournals({
  store,
  shell,
  onOpenDay,
  onOpenPage
}: {
  readonly store: NotesStore;
  readonly shell: NotesShellSnapshot;
  readonly onOpenDay: (date: string) => void;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const [today] = useState(localDateIso);
  const [zoomRootId, setZoomRootId] = useState<string | null>(null);
  const days = useMemo(
    () => journalDays(shell.pages).filter((day) => day.date <= today),
    [shell.pages, today]
  );
  const page = shell.pages.find((candidate) => candidate.id === shell.activePageId);

  if (days.length === 0) {
    return <p className="mobile-empty">Nothing written on any day yet.</p>;
  }

  return (
    <JournalFeed
      store={store}
      status={shell.status}
      error={shell.error}
      pendingWrites={shell.pendingWrites}
      page={page && { id: page.id, title: page.title }}
      zoomRootId={zoomRootId}
      restoreRequest={null}
      days={days}
      onZoomRootChange={setZoomRootId}
      onHome={() => setZoomRootId(null)}
      onTagClick={() => {
        // Tag search belongs to the Search tab, which is not built yet.
      }}
      onDateClick={(date) => onOpenDay(date)}
      onOpenPage={onOpenPage}
      onOpenDay={onOpenDay}
      onCarryRows={async (pageId, rowIds) => {
        // The same two steps the desktop takes, without its navigation record:
        // the phone has no history to put a step on yet, and the reader has not
        // moved anyway — only the rows did.
        await store.flushAllDrafts();
        await store.moveNodes(
          rowIds.map((id) => ({ id, parentId: pageId, beforeId: null }))
        );
      }}
      onSelectionCountChange={() => {
        // The phone has no selection bar of its own yet; the feed still needs
        // somewhere to report to.
      }}
      today={today}
    />
  );
}
