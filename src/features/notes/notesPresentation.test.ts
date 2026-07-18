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
  it("uses the shared image label rule for navigation", () => {
    const diagram = node({
      id: "diagram",
      nodeKind: "image",
      title: "  AboveBelow  ",
      imageOffsetUtf16: 7
    });
    const photo = node({
      id: "photo",
      nodeKind: "image",
      title: ""
    });

    expect(noteNodePresentationLabel(diagram)).toBe("Image");
    expect(noteNodePresentationLabel(photo)).toBe("Image");
    expect(noteNodeNavigationLabel(diagram)).toBe("Above Below");
    expect(noteNodeNavigationLabel(photo, photo.title, "Untitled note", "photo.png")).toBe(
      "photo.png"
    );
  });

  it("uses server-computed image labels for result titles and parent trails", () => {
    const result = {
      nodeId: "image-result",
      nodeKind: "image",
      title: "AboveBelow",
      imageOffsetUtf16: 5,
      attachmentName: "diagram.png",
      displayLabel: "Above Below",
      parentTrail: ["reference.png", "Visible project"],
      parentTrailKinds: ["image", "text"],
      matchedField: "title"
    } satisfies NoteSearchResult;

    expect(noteSearchPresentation(result)).toEqual({
      title: "Above Below",
      parentTrail: ["reference.png", "Visible project"]
    });
  });

  it("uses the attachment fallback when an image result has no primary text", () => {
    const result = {
      nodeId: "image-result",
      nodeKind: "image",
      title: "  ",
      imageOffsetUtf16: 0,
      attachmentName: "fallback.png",
      displayLabel: "fallback.png",
      parentTrail: [""],
      parentTrailKinds: ["image"],
      matchedField: "title"
    } satisfies NoteSearchResult;

    expect(noteSearchPresentation(result)).toEqual({
      title: "fallback.png",
      parentTrail: ["Image"]
    });
  });

  it("retains a text result title when result kind metadata is valid", () => {
    const result = {
      nodeId: "text-result",
      nodeKind: "text",
      title: "Visible text result",
      imageOffsetUtf16: 0,
      attachmentName: null,
      displayLabel: "Visible text result",
      parentTrail: [],
      parentTrailKinds: [],
      matchedField: "title"
    } satisfies NoteSearchResult;

    expect(noteSearchPresentation(result)).toEqual({
      title: "Visible text result",
      parentTrail: []
    });
  });

  it("falls back by kind when valid server labels are empty", () => {
    const result = {
      nodeId: "empty-text-result",
      nodeKind: "text",
      title: "",
      imageOffsetUtf16: 0,
      attachmentName: null,
      displayLabel: "",
      parentTrail: ["", ""],
      parentTrailKinds: ["text", "image"],
      matchedField: "title"
    } satisfies NoteSearchResult;

    expect(noteSearchPresentation(result)).toEqual({
      title: "Untitled note",
      parentTrail: ["Untitled note", "Image"]
    });
  });

  it("fails closed for malformed result kind metadata", () => {
    const malformedResult = {
      nodeId: "reparented",
      title: "private-image-title.png",
      imageOffsetUtf16: 0,
      attachmentName: "private-image-title.png",
      displayLabel: "private-image-title.png",
      parentTrail: ["private-parent.png"],
      parentTrailKinds: ["canvas"],
      matchedField: "attachment"
    } as unknown as NoteSearchResult;

    expect(noteSearchPresentation(malformedResult)).toEqual({
      title: "Note",
      parentTrail: ["Note"]
    });
  });

});
