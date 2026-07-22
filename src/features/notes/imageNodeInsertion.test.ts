import { describe, expect, it, vi } from "vitest";
import type { NoteNode, PendingImageNodeByteItem } from "../../domain/notes";
import {
  createImageNodeIdPairs,
  imageNodeByteItems,
  imageNodeInsertionAnchor,
  imageNodePathItems
} from "./imageNodeInsertion";
import { normalizeWorkspace } from "./notesWorkspaceReducer";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-14T00:00:00Z",
    updatedAt: "2026-07-14T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet"
  };
}

describe("image node insertion", () => {
  it("places a normal row target after the row as a sibling", () => {
    const state = normalizeWorkspace({
      nodes: [
        node({ id: "parent" }),
        node({ id: "target", parentId: "parent", sortKey: 2048 })
      ]
    });

    expect(imageNodeInsertionAnchor(state, "target")).toEqual({
      parentId: "parent",
      afterId: "target"
    });
  });

  it("places a zoomed page header target as the page's first child", () => {
    const state = normalizeWorkspace({
      nodes: [node({ id: "page" }), node({ id: "child", parentId: "page" })]
    });
    state.zoomRootId = "page";

    expect(imageNodeInsertionAnchor(state, "page")).toEqual({
      parentId: "page",
      afterId: null
    });
  });

  it("rejects missing, deleted, and archived targets", () => {
    const state = normalizeWorkspace({
      nodes: [
        node({ id: "active" }),
        node({ id: "deleted", deletedAt: "2026-07-14T01:00:00Z" }),
        node({ id: "archived", archivedAt: "2026-07-14T02:00:00Z" })
      ]
    });

    expect(imageNodeInsertionAnchor(state, "missing")).toBeNull();
    expect(imageNodeInsertionAnchor(state, "deleted")).toBeNull();
    expect(imageNodeInsertionAnchor(state, "archived")).toBeNull();
  });

  it("generates stable node and attachment IDs once and preserves source order across retries", () => {
    const nextId = vi
      .fn()
      .mockReturnValueOnce("node-a")
      .mockReturnValueOnce("attachment-a")
      .mockReturnValueOnce("node-b")
      .mockReturnValueOnce("attachment-b");
    const pairs = createImageNodeIdPairs(2, nextId);
    const paths = ["/incoming/first.png", "/incoming/second.webp"];

    const firstPathItems = imageNodePathItems(paths, pairs);
    const retryPathItems = imageNodePathItems(paths, pairs);

    expect(firstPathItems).toEqual([
      {
        nodeId: "node-a",
        attachmentId: "attachment-a",
        sourcePath: "/incoming/first.png"
      },
      {
        nodeId: "node-b",
        attachmentId: "attachment-b",
        sourcePath: "/incoming/second.webp"
      }
    ]);
    expect(retryPathItems).toEqual(firstPathItems);
    expect(nextId).toHaveBeenCalledTimes(4);

    const firstBlob = new Blob(["first"], { type: "image/png" });
    const secondBlob = new Blob(["second"], { type: "image/webp" });
    const byteSources: readonly PendingImageNodeByteItem[] = [
      { originalName: "first.png", mimeType: "image/png", blob: firstBlob },
      { originalName: "second.webp", mimeType: "image/webp", blob: secondBlob }
    ];

    const firstByteItems = imageNodeByteItems(byteSources, pairs);
    const retryByteItems = imageNodeByteItems(byteSources, pairs);

    expect(firstByteItems).toEqual([
      {
        nodeId: "node-a",
        attachmentId: "attachment-a",
        originalName: "first.png",
        mimeType: "image/png",
        blob: firstBlob
      },
      {
        nodeId: "node-b",
        attachmentId: "attachment-b",
        originalName: "second.webp",
        mimeType: "image/webp",
        blob: secondBlob
      }
    ]);
    expect(retryByteItems).toEqual(firstByteItems);
    expect(firstByteItems[0]?.blob).toBe(firstBlob);
    expect(firstByteItems[1]?.blob).toBe(secondBlob);
    expect(nextId).toHaveBeenCalledTimes(4);
  });

  it("copies only clipboard source fields after generated identities", () => {
    const blob = new Blob(["clipboard"], { type: "image/png" });
    const untrustedItem = {
      originalName: "clipboard.png",
      mimeType: "image/png",
      blob,
      nodeId: "caller-node-id",
      attachmentId: "caller-attachment-id",
      sourcePath: "/caller/path.png"
    } as PendingImageNodeByteItem & {
      nodeId: string;
      attachmentId: string;
      sourcePath: string;
    };

    const [item] = imageNodeByteItems(
      [untrustedItem],
      [{ nodeId: "generated-node-id", attachmentId: "generated-attachment-id" }]
    );

    expect(item).toEqual({
      nodeId: "generated-node-id",
      attachmentId: "generated-attachment-id",
      originalName: "clipboard.png",
      mimeType: "image/png",
      blob
    });
    expect(item).not.toHaveProperty("sourcePath");
  });
});
