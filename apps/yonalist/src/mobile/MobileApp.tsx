import { useMemo, useState } from "react";
import { tauriNotesApi, type NotesApi } from "../api";
import { NotesStore } from "../notesStore";
import { MobileIcon, type MobileIconName } from "./MobileIcon";
import { MobileToday } from "./MobileToday";
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

  return (
    <div className="mobile-app">
      <main className="mobile-screen" id={`mobile-panel-${open.id}`} role="tabpanel">
        {section === "today" ? (
          <MobileToday store={store} />
        ) : (
          <h1 className="mobile-screen-title">{open.label}</h1>
        )}
      </main>
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
