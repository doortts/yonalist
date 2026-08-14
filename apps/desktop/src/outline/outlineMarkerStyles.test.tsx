import { readFileSync } from "node:fs";
import { act, render } from "@testing-library/react";
import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "../api";
import { NotesOutline } from "../NotesOutline";
import { NotesStore } from "../notesStore";
import { rule } from "../test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");

function bullet(id: string, parentId: string, sortKey: number): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

// One chain four levels deep: the fourth row is what proves a depth past the
// configured levels keeps the last level's marker instead of losing one.
const nodes = [
  bullet("one", "page-1", 1_024),
  bullet("two", "one", 1_024),
  bullet("three", "two", 1_024),
  bullet("four", "three", 1_024),
  { ...bullet("five", "page-1", 2_048), marker: { ordered: { start: 5 } } },
  { ...bullet("six", "page-1", 3_072), marker: { ordered: { start: 5 } } }
] as const;

function bootSnapshot(): BootSnapshot {
  return {
    sessionId: "marker-session",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Today", sortKey: 1_024 }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [...nodes]
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
}

async function outline() {
  const api = {
    bootstrap: vi.fn().mockResolvedValue(bootSnapshot()),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1, nodes: [...nodes], complete: true
    }),
    execute: vi.fn(),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    exportNotes: vi.fn(),
    closeSession: vi.fn()
  } as unknown as NotesApi;
  const store = new NotesStore(api);
  await store.bootstrap();
  const view = render(
    <NotesOutline
      store={store}
      status="ready"
      error={null}
      pendingWrites={0}
      page={{ id: "page-1", title: "Today" }}
      zoomRootId={null}
      onZoomRootChange={() => undefined}
      onHome={() => undefined}
      onTagClick={() => undefined}
      paneId="primary"
      restoreRequest={null}
    />
  );
  await act(async () => undefined);
  return view;
}

function levelOf(container: HTMLElement, id: string): string | null {
  return container
    .querySelector(`[data-outline-id='${id}']`)
    ?.getAttribute("data-marker-level") ?? null;
}

describe("outline marker styles", () => {
  it("stamps the marker level a row's depth falls in", async () => {
    const { container } = await outline();

    expect(levelOf(container, "one")).toBe("0");
    expect(levelOf(container, "two")).toBe("1");
    expect(levelOf(container, "three")).toBe("2");
    expect(levelOf(container, "four")).toBe("2");
  });

  // The number is the marker, so it stands where the shaped bullet would and
  // the row reports the kind by name rather than as the marker's own value.
  it("draws a numbered row's number in place of its bullet", async () => {
    const { container } = await outline();
    const row = (id: string) =>
      container.querySelector(`[data-outline-id='${id}']`);

    expect(row("five")?.getAttribute("data-marker-kind")).toBe("ordered");
    expect(row("five")?.querySelector(".notes-node-bullet-number")?.textContent)
      .toBe("5.");
    expect(row("six")?.querySelector(".notes-node-bullet-number")?.textContent)
      .toBe("6.");
    expect(row("one")?.querySelector(".notes-node-bullet-number")).toBeNull();
    expect(row("one")?.querySelector(".notes-node-bullet-dot")).not.toBeNull();
  });

  // The variables carry the whole shape, so a level that nobody configured
  // still has to fall back to the dot the rows drew before the setting existed.
  it("reads each level's shape off its own variables, dot by default", () => {
    for (const level of [0, 1, 2]) {
      const declarations = rule(
        notesStyles,
        `.notes-node[data-marker-level="${level}"] .notes-node-bullet-dot`
      );
      expect(declarations).toContain(`width: var(--notes-marker-${level}-w, 7px);`);
      expect(declarations).toContain(
        `border-radius: var(--notes-marker-${level}-r, 50%);`
      );
      expect(declarations).toContain(
        `background: var(--notes-marker-${level}-bg, currentColor);`
      );
      expect(rule(
        notesStyles,
        `.notes-node[data-marker-level="${level}"] .notes-node-bullet-dot::after`
      )).toContain(`content: var(--notes-marker-${level}-char, "");`);
    }
  });
});
