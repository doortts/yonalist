import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileJournals } from "./MobileJournals";
import { NotesStore } from "../notesStore";
import { appApi } from "../test/appApiFixture";
import type { NotesShellSnapshot } from "../store/storeSubscriptions";

function shell(pages: NotesShellSnapshot["pages"]): NotesShellSnapshot {
  return {
    status: "ready", sessionId: "s", revision: 1, pages, activePageId: null,
    provisionalPageId: null, canUndo: false, canRedo: false, undoDepth: 0,
    redoDepth: 0, beforeCursor: null, afterCursor: null, error: null,
    pendingWrites: 0
  };
}

function feed(pages: NotesShellSnapshot["pages"]) {
  render(
    <MobileJournals
      store={new NotesStore(appApi())}
      shell={shell(pages)}
      onOpenDay={vi.fn()}
      onOpenPage={vi.fn()}
    />
  );
}

describe("MobileJournals", () => {
  it("says so plainly when no day has been written in", () => {
    feed([{ id: "p1", title: "Reading list", sortKey: 1 }]);

    expect(screen.getByText(/nothing written on any day yet/i)).toBeInTheDocument();
  });

  it("counts only days, not ordinary pages", () => {
    feed([
      { id: "p1", title: "Reading list", sortKey: 1 },
      { id: "j1", title: "2026-08-19", sortKey: 2 }
    ]);

    expect(screen.queryByText(/nothing written on any day yet/i)).not.toBeInTheDocument();
  });
});
