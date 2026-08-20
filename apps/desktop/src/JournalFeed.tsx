import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import { NotesOutline, type PaneRestoreRequest } from "./NotesOutline";
import { JournalReferences } from "./JournalReferences";
import { useJournalDate } from "./useJournalDate";
import type { JournalDay } from "./journal";
import { weekdayOf } from "./journal";
import { parseOutlinePresentation } from "./outline/outlinePresentation";
import type { OutlineTagToken } from "./outline/OutlineTextField";
import type { NotesShellSnapshot } from "./store/storeSubscriptions";

/** How many days the feed draws before asking whether to draw more. */
const DAYS_PER_STEP = 7;

interface FeedRow {
  readonly node: NoteView;
  readonly depth: number;
}

/**
 * The rows under one day, in reading order, each with how deep it sits. The
 * forest arrives flat, so the order the reader expects has to be walked out of
 * the parent links rather than read off the array.
 */
function rowsOfDay(nodes: readonly NoteView[], dayId: string): readonly FeedRow[] {
  const children = new Map<string, NoteView[]>();
  for (const node of nodes) {
    if (node.deleted || node.parentId === null) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.sortKey - right.sortKey);
  }
  const rows: FeedRow[] = [];
  const walk = (parentId: string, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      rows.push({ node, depth });
      // A collapsed row keeps its children to itself here too: the feed is
      // showing the day as its writer left it.
      if (!node.collapsed) walk(node.id, depth + 1);
    }
  };
  walk(dayId, 0);
  return rows;
}

/**
 * A row's text with its tags and dates drawn as the outline draws them. The
 * editable field's own renderer cannot be borrowed -- every token there is a
 * control, and nothing in this list is one -- so the same parse is drawn flat.
 */
function JournalRowText({ text }: { readonly text: string }) {
  const parsed = useMemo(() => parseOutlinePresentation(text), [text]);
  return (
    <>
      {parsed.tokens.map((token) => {
        if (token.kind === "tag") {
          return (
            <span className="notes-tag-token" key={token.start}>
              {token.display}
            </span>
          );
        }
        if (token.kind === "date") {
          return (
            <span className="notes-date-token" key={token.start}>
              {token.display}
            </span>
          );
        }
        return <Fragment key={token.start}>{token.display}</Fragment>;
      })}
    </>
  );
}

function JournalEarlierDays({
  store,
  days,
  onOpenDay
}: {
  readonly store: NotesStore;
  readonly days: readonly JournalDay[];
  readonly onOpenDay: (date: string) => void;
}) {
  const [shown, setShown] = useState(DAYS_PER_STEP);
  const visible = useMemo(() => days.slice(0, shown), [days, shown]);
  const [nodes, setNodes] = useState<readonly NoteView[]>([]);
  // Only the days on screen are read. A vault with four hundred of them would
  // otherwise spend its first paint on days nobody has scrolled to.
  const visibleIds = visible.map((day) => day.id).join(" ");
  useEffect(() => {
    let active = true;
    const ids = visibleIds.length === 0 ? [] : visibleIds.split(" ");
    if (ids.length === 0) {
      setNodes([]);
      return () => undefined;
    }
    void store.queryForest(ids).then(
      (forest) => {
        if (active) setNodes(forest.nodes);
      },
      () => {
        // The days stay, with their rows missing: a day whose rows could not be
        // read is still a day the reader can open.
        if (active) setNodes([]);
      }
    );
    return () => {
      active = false;
    };
  }, [store, visibleIds]);

  return (
    <section className="notes-journal-earlier" aria-label="Earlier days">
      {visible.map((day) => (
        <article className="notes-journal-day" key={day.id}>
          <h3 className="notes-journal-day-heading">
            <button
              className="notes-journal-day-open"
              type="button"
              onClick={() => onOpenDay(day.date)}
            >
              <span className="notes-journal-day-date">{day.date}</span>
              <span className="notes-journal-day-weekday">
                {weekdayOf(day.date)}
              </span>
            </button>
          </h3>
          <div className="notes-journal-day-rows">
            {rowsOfDay(nodes, day.id).map((row) => (
              <div
                className="notes-journal-day-row"
                key={row.node.id}
                style={{ "--journal-row-depth": row.depth } as CSSProperties}
              >
                <span
                  className="notes-journal-day-bullet"
                  data-marker={row.node.marker === "todo" ? "todo" : "bullet"}
                  data-completed={row.node.completed ? "true" : undefined}
                  aria-hidden="true"
                />
                <span
                  className="notes-journal-day-text"
                  data-completed={row.node.completed ? "true" : undefined}
                >
                  <JournalRowText text={row.node.text} />
                </span>
              </div>
            ))}
          </div>
        </article>
      ))}
      {days.length > shown && (
        <button
          className="text-button notes-journal-more"
          type="button"
          onClick={() => setShown((current) => current + DAYS_PER_STEP)}
        >
          Show earlier days
        </button>
      )}
    </section>
  );
}

/**
 * The days, newest first, in one sheet. The top day is the live outline -- the
 * one a reader is here to write in -- and the days under it are read: an
 * editable pane per day would mean a selection, a drag and an undo registry per
 * day, which is a price this screen has no reason to pay. Pressing a day's
 * heading opens it as its own page, where it is editable like any other.
 */
export function JournalFeed({
  store,
  status,
  error,
  pendingWrites,
  page,
  zoomRootId,
  restoreRequest,
  days,
  onZoomRootChange,
  onHome,
  onTagClick,
  onDateClick,
  onOpenPage,
  onOpenDay,
  onSelectionCountChange
}: {
  readonly store: NotesStore;
  readonly status: NotesShellSnapshot["status"];
  readonly error: string | null;
  readonly pendingWrites: number;
  readonly page: { readonly id: string; readonly title: string } | undefined;
  readonly zoomRootId: string | null;
  readonly restoreRequest: PaneRestoreRequest | null;
  readonly days: readonly JournalDay[];
  readonly onZoomRootChange: (nodeId: string | null) => void;
  readonly onHome: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onDateClick: (date: string, anchor: DOMRect) => void;
  readonly onOpenPage: (pageId: string) => void;
  readonly onOpenDay: (date: string) => void;
  readonly onSelectionCountChange: (
    paneId: "primary" | "secondary",
    count: number
  ) => void;
}) {
  const journalDate = useJournalDate(store, page?.id);
  return (
    <section className="detail-pane notes-journal-feed" aria-label="Journals">
      <div className="pane-titlebar-spacer" />
      <div className="detail-scroll">
        <div
          className="notes-detail-pane"
          data-journal={journalDate ? "true" : undefined}
        >
          <NotesOutline
            store={store}
            status={status}
            error={error}
            pendingWrites={pendingWrites}
            page={page}
            zoomRootId={zoomRootId}
            onZoomRootChange={onZoomRootChange}
            onHome={onHome}
            onTagClick={onTagClick}
            onDateClick={onDateClick}
            paneId="primary"
            restoreRequest={restoreRequest}
            onSelectionCountChange={onSelectionCountChange}
          />
          {page && journalDate && (
            <JournalReferences
              store={store}
              pageId={page.id}
              date={journalDate}
              onOpenPage={onOpenPage}
            />
          )}
        </div>
        <JournalEarlierDays
          store={store}
          days={days}
          onOpenDay={onOpenDay}
        />
      </div>
    </section>
  );
}
