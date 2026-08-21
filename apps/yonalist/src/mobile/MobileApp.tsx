import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties
} from "react";
import { tauriNotesApi, type NotesApi } from "../api";
import { NotesStore } from "../notesStore";
import { useTheme } from "../useTheme";
import { MobileIcon, type MobileIconName } from "./MobileIcon";
import { MobileJournals } from "./MobileJournals";
import { MobilePage } from "./MobilePage";
import { MobilePages } from "./MobilePages";
import { MobileSearch } from "./MobileSearch";
import { MobileToday } from "./MobileToday";
import { MobileAccessoryBar } from "./MobileAccessoryBar";
import { useDragAutoscroll } from "./useDragAutoscroll";
import { useKeyboardInset } from "./useKeyboardInset";
import "./mobile.css";

/**
 * The four places the phone can be. The desktop reaches all of these from one
 * sidebar; a phone has no room for a sidebar and no pointer to hover it with,
 * so they become a tab bar under the thumb.
 */
const sections = [
  { id: "today", label: "Today", icon: "calendar-event" },
  { id: "journals", label: "Journals", icon: "notebook" },
  { id: "pages", label: "Pages", icon: "file-text" },
  { id: "search", label: "Search", icon: "search" }
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileIconName;
}[];

export type MobileSection = (typeof sections)[number]["id"];

export function MobileApp({ api = tauriNotesApi }: { readonly api?: NotesApi }) {
  // Today, because writing today down is what the app is for; every other
  // section is somewhere you go on purpose.
  const [section, setSection] = useState<MobileSection>("today");
  const open = sections.find((candidate) => candidate.id === section) ?? sections[0];
  // One store for the whole shell: the sections are views of the same notes,
  // and a store per tab would give each its own revision to argue with.
  const store = useMemo(() => new NotesStore(api), [api]);
  // Which page a section opened, if any. Held here so switching tabs and
  // coming back finds the page still open, the way a phone's tabs behave.
  const [openPageId, setOpenPageId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(true);
  const shell = useSyncExternalStore(
    store.subscribeShell,
    store.getShellSnapshot,
    store.getShellSnapshot
  );
  useEffect(() => {
    void store.bootstrap();
  }, [store]);
  const openPage = (pageId: string) => {
    setOpenPageId(pageId);
    void store.openPage(pageId);
  };
  // The theme writes itself onto the document, so calling it is all the phone
  // has to do to follow the system between light and dark.
  useTheme();
  const keyboard = useKeyboardInset();
  const screen = useRef<HTMLElement>(null);
  useDragAutoscroll(screen);

  return (
    <div
      className="mobile-app"
      data-keyboard={keyboard > 0 ? "up" : undefined}
      style={{ "--mobile-keyboard": `${keyboard}px` } as CSSProperties}
    >
      <main ref={screen} className="mobile-screen" id={`mobile-panel-${open.id}`} role="tabpanel">
        {section === "today" && <MobileToday store={store} />}
        {section === "journals" && (
          <MobileJournals
            store={store}
            shell={shell}
            onOpenDay={() => setSection("today")}
            onOpenPage={openPage}
          />
        )}
        {section === "pages" && (openPageId
          ? (
            <MobilePage
              store={store}
              shell={shell}
              title={
                shell.pages.find((page) => page.id === openPageId)?.title ?? ""
              }
              showCompleted={showCompleted}
              onShowCompletedChange={setShowCompleted}
              onBack={() => setOpenPageId(null)}
            />
          )
          : <MobilePages pages={shell.pages} onOpenPage={openPage} />)}
        {section === "search" && (
          <MobileSearch store={store} onOpenPage={openPage} />
        )}
      </main>
      {keyboard > 0 && <MobileAccessoryBar store={store} />}
      <nav className="mobile-tabs" aria-label="Sections" role="tablist">
        {sections.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            className="mobile-tab"
            aria-selected={candidate.id === section}
            aria-controls={`mobile-panel-${candidate.id}`}
            onClick={() => setSection(candidate.id)}
          >
            <MobileIcon name={candidate.icon} size={22} />
            <span className="mobile-tab-label">{candidate.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
