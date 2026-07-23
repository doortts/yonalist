import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  defaultNotesSplitLayout,
  loadNotesSplitLayout,
  NOTES_SPLIT_LAYOUT_STORAGE_KEY,
  reconcilePersistedSplitLayout,
  saveNotesSplitLayout,
  type NotesSplitLayoutStateV1
} from "./notesSplitLayoutStore";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function layout(
  overrides: Partial<NotesSplitLayoutStateV1> = {}
): NotesSplitLayoutStateV1 {
  return {
    splitOpen: false,
    splitRatio: 0.5,
    activePaneId: "primary",
    panes: {
      primary: {
        zoomRootId: null,
        expandedNodeIds: [],
        scrollAnchorId: null,
        scrollOffset: 0
      },
      secondary: {
        zoomRootId: null,
        expandedNodeIds: [],
        scrollAnchorId: null,
        scrollOffset: 0
      }
    },
    ...overrides
  };
}

function node(id: string): NoteNode {
  return {
    id,
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    markerKind: "bullet",
    markdownImageWidth: null
  };
}

describe("notes split layout store", () => {
  it("stores independent layouts in one versioned Vault map", () => {
    const storage = new MemoryStorage();
    const a = layout({ splitOpen: true, splitRatio: 0.4 });
    const b = layout({ splitOpen: true, splitRatio: 0.7 });

    saveNotesSplitLayout(storage, "/vault/a", a);
    saveNotesSplitLayout(storage, "/vault/b", b);

    expect(loadNotesSplitLayout(storage, "/vault/a")).toEqual(a);
    expect(loadNotesSplitLayout(storage, "/vault/b")).toEqual(b);
    expect([...storage.values.keys()]).toEqual([
      NOTES_SPLIT_LAYOUT_STORAGE_KEY
    ]);
  });

  it("clamps ratios and recovers malformed data to defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      NOTES_SPLIT_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        vaults: {
          "/vault": layout({ splitRatio: 9 })
        }
      })
    );
    expect(loadNotesSplitLayout(storage, "/vault").splitRatio).toBe(0.75);

    storage.setItem(NOTES_SPLIT_LAYOUT_STORAGE_KEY, "{broken");
    expect(loadNotesSplitLayout(storage, "/vault")).toEqual(
      defaultNotesSplitLayout()
    );
  });

  it("drops only invalid persisted node references", () => {
    const workspace = normalizeWorkspace({
      nodes: [node("primary-page"), node("expanded"), node("anchor")]
    });
    const restored = layout({
      splitOpen: true,
      panes: {
        primary: {
          zoomRootId: "primary-page",
          expandedNodeIds: ["expanded", "missing"],
          scrollAnchorId: "anchor",
          scrollOffset: 12
        },
        secondary: {
          zoomRootId: "missing",
          expandedNodeIds: ["missing"],
          scrollAnchorId: "missing",
          scrollOffset: 99
        }
      }
    });

    expect(reconcilePersistedSplitLayout(restored, workspace)).toEqual(
      layout({
        splitOpen: true,
        panes: {
          primary: {
            zoomRootId: "primary-page",
            expandedNodeIds: ["expanded"],
            scrollAnchorId: "anchor",
            scrollOffset: 12
          },
          secondary: {
            zoomRootId: null,
            expandedNodeIds: [],
            scrollAnchorId: null,
            scrollOffset: 0
          }
        }
      })
    );
  });

  it("does not throw when storage access is unavailable", () => {
    const unavailable = {
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem(): void {
        throw new Error("blocked");
      }
    };

    expect(loadNotesSplitLayout(unavailable, "/vault")).toEqual(
      defaultNotesSplitLayout()
    );
    expect(() =>
      saveNotesSplitLayout(unavailable, "/vault", layout())
    ).not.toThrow();
  });
});
