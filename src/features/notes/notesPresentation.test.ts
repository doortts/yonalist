import { describe, expect, it } from "vitest";
import type { NoteNode, NoteSearchResult } from "../../domain/notes";
import {
  noteNodeNavigationLabel,
  noteNodePresentationLabel,
  noteSearchPresentation
} from "./notesPresentation";

const timestamp = "2026-07-15T00:00:00.000Z";

function node({
  id,
  title,
  ...overrides
}: Pick<NoteNode, "id" | "title"> & Partial<NoteNode>): NoteNode {
  return {
    id,
    nodeKind: "text",
    parentId: null,
    sortKey: 1,
    title,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides
  };
}

describe("noteSearchPresentation", () => {
  it("keeps image presentation labels neutral while navigation labels distinguish rows", () => {
    const diagram = node({
      id: "diagram",
      nodeKind: "image",
      title: "diagram.png"
    });
    const photo = node({
      id: "photo",
      nodeKind: "image",
      title: "photo.png"
    });

    expect(noteNodePresentationLabel(diagram)).toBe("Image");
    expect(noteNodePresentationLabel(photo)).toBe("Image");
    expect(noteNodeNavigationLabel(diagram)).toBe("diagram.png");
    expect(noteNodeNavigationLabel(photo)).toBe("photo.png");
  });

  it("uses stored image filenames for result titles and parent trails", () => {
    const result = {
      nodeId: "image-result",
      nodeKind: "image",
      title: "diagram.png",
      parentTrail: ["reference.png", "Visible project"],
      parentTrailKinds: ["image", "text"],
      matchedField: "title"
    } satisfies NoteSearchResult;

    expect(noteSearchPresentation(result)).toEqual({
      title: "diagram.png",
      parentTrail: ["reference.png", "Visible project"]
    });
  });

  it("falls back to Image for empty image filenames", () => {
    const result = {
      nodeId: "image-result",
      nodeKind: "image",
      title: "  ",
      parentTrail: [""],
      parentTrailKinds: ["image"],
      matchedField: "title"
    } satisfies NoteSearchResult;

    expect(noteSearchPresentation(result)).toEqual({
      title: "Image",
      parentTrail: ["Image"]
    });
  });

  it("does not expose a stale image title when result kind metadata is missing and the loaded node is text", () => {
    const staleResult = {
      nodeId: "reparented",
      title: "private-image-title.png",
      parentTrail: [],
      parentTrailKinds: [],
      matchedField: "title"
    } as unknown as NoteSearchResult;
    const nodesById = {
      reparented: node({
        id: "reparented",
        title: "Current text title"
      })
    };

    expect(noteSearchPresentation(staleResult, nodesById)).toEqual({
      title: "Note",
      parentTrail: []
    });
  });

  it("retains a text result title when result kind metadata is valid", () => {
    const result = {
      nodeId: "text-result",
      nodeKind: "text",
      title: "Visible text result",
      parentTrail: [],
      parentTrailKinds: [],
      matchedField: "title"
    } satisfies NoteSearchResult;

    expect(noteSearchPresentation(result)).toEqual({
      title: "Visible text result",
      parentTrail: []
    });
  });

  it("does not apply current text ancestry kinds to a stale image-parent trail", () => {
    const staleResult = {
      nodeId: "child",
      nodeKind: "text",
      title: "Visible child",
      parentTrail: ["private-image-parent.png"],
      matchedField: "title"
    } as unknown as NoteSearchResult;
    const nodesById = {
      child: node({
        id: "child",
        title: "Visible child",
        parentId: "current-text-parent"
      }),
      "current-text-parent": node({
        id: "current-text-parent",
        title: "Current text parent"
      }),
      "old-image-parent": node({
        id: "old-image-parent",
        nodeKind: "image",
        title: "private-image-parent.png"
      })
    };

    expect(noteSearchPresentation(staleResult, nodesById)).toEqual({
      title: "Visible child",
      parentTrail: ["Note"]
    });
  });
});
