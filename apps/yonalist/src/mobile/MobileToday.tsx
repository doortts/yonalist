import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { NotesStore } from "../notesStore";
import { localDateIso } from "../outline/outlineSlash";
import { MobileDayHeader } from "./MobileDayHeader";
import { MobileOutline } from "./MobileOutline";

/**
 * One day's page, opened by date.
 *
 * The day is the state here, not the page: a day nobody has written in has no
 * page yet, and asking the store to open one by date is what decides whether
 * there is anything to open. That is the desktop's own rule, reached through
 * the same `openJournal`, so what a first keystroke does — mint the page and
 * title it — is not decided twice.
 *
 * Today is read once per mount rather than watched. A phone that is open at
 * midnight is not the case worth carrying a timer for; the next launch is
 * already right, and so is stepping to the day either side.
 */
export function MobileToday({ store }: { readonly store: NotesStore }) {
  const [today] = useState(localDateIso);
  const [day, setDay] = useState(today);
  const shell = useSyncExternalStore(
    store.subscribeShell,
    store.getShellSnapshot,
    store.getShellSnapshot
  );

  useEffect(() => {
    // The store refuses a second bootstrap while one is in flight, so a
    // remount during startup costs nothing.
    void store.bootstrap();
  }, [store]);

  useEffect(() => {
    if (shell.status !== "ready") return;
    void store.openJournal(day);
  }, [day, shell.status, store]);

  const openDay = useCallback((date: string) => setDay(date), []);

  return (
    <>
      <MobileDayHeader date={day} today={today} onOpenDay={openDay} />
      <MobileOutline store={store} shell={shell} />
    </>
  );
}
