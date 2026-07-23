import { describe, expect, it } from "vitest";
import type { NoteAttachment, NoteNode } from "../../domain/notes";
import {
  normalizeWorkspace,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";
import { retainNormalizedWorkspaceIdentity } from "./notesWorkspaceIdentity";

const NOTE_NODE_FIELDS = [
  "id",
  "nodeKind",
  "markerKind",
  "parentId",
  "sortKey",
  "title",
  "note",
  "imageOffsetUtf16",
  "markdownImageWidth",
  "layoutMode",
  "isCollapsed",
  "isStarred",
  "completedAt",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "archivedAt",
  "archiveRootId"
] as const satisfies readonly (keyof NoteNode)[];
const NOTE_ATTACHMENT_FIELDS = [
  "id",
  "nodeId",
  "sortKey",
  "relativePath",
  "contentHash",
  "originalName",
  "mimeType",
  "byteSize",
  "intrinsicWidth",
  "intrinsicHeight",
  "displayWidth",
  "createdAt",
  "updatedAt"
] as const satisfies readonly (keyof NoteAttachment)[];
const ALL_NODE_FIELDS_LISTED: Exclude<
  keyof NoteNode,
  (typeof NOTE_NODE_FIELDS)[number]
> extends never
  ? true
  : never = true;
const ALL_ATTACHMENT_FIELDS_LISTED: Exclude<
  keyof NoteAttachment,
  (typeof NOTE_ATTACHMENT_FIELDS)[number]
> extends never
  ? true
  : never = true;
void ALL_NODE_FIELDS_LISTED;
void ALL_ATTACHMENT_FIELDS_LISTED;

function node(
  overrides: Partial<NoteNode> & Pick<NoteNode, "id">
): NoteNode {
  return {
    nodeKind: "text",
    markerKind: "bullet",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    imageOffsetUtf16: 0,
    markdownImageWidth: null,
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function attachment(
  overrides: Partial<NoteAttachment> & Pick<NoteAttachment, "id" | "nodeId">
): NoteAttachment {
  return {
    sortKey: 1024,
    relativePath: `assets/${overrides.id}.png`,
    contentHash: overrides.id,
    originalName: `${overrides.id}.png`,
    mimeType: "image/png",
    byteSize: 4,
    intrinsicWidth: 640,
    intrinsicHeight: 320,
    displayWidth: 320,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides
  };
}

function withUi(
  workspace: NormalizedNotesWorkspace,
  overrides: Partial<NormalizedNotesWorkspace>
): NormalizedNotesWorkspace {
  return { ...workspace, ...overrides };
}

describe("retainNormalizedWorkspaceIdentity", () => {
  it("retains 49 equal nodes while leaving the changed source and new node fresh", () => {
    const previousNodes = Array.from({ length: 50 }, (_, index) =>
      node({ id: `node-${index}`, sortKey: index + 1 })
    );
    const previous = normalizeWorkspace({ nodes: previousNodes });
    const nextNodes = previousNodes.map((item, index) =>
      index === 0
        ? { ...item, title: "changed source" }
        : { ...item }
    );
    const created = node({ id: "expected", sortKey: 51 });
    const next = normalizeWorkspace({ nodes: [...nextNodes, created] });

    const retained = retainNormalizedWorkspaceIdentity(previous, next);

    for (let index = 1; index < 50; index += 1) {
      expect(retained.nodesById[`node-${index}`]).toBe(
        previous.nodesById[`node-${index}`]
      );
    }
    expect(retained.nodesById["node-0"]).toBe(next.nodesById["node-0"]);
    expect(retained.nodesById["node-0"]).not.toBe(
      previous.nodesById["node-0"]
    );
    expect(retained.nodesById.expected).toBe(created);
  });

  it("compares every NoteNode field before retaining the previous object", () => {
    const base = node({ id: "node" });
    const changes: ReadonlyArray<
      readonly [Exclude<keyof NoteNode, "id">, NoteNode[keyof NoteNode]]
    > = [
      ["nodeKind", "image"],
      ["markerKind", "todo"],
      ["parentId", "parent"],
      ["sortKey", 2048],
      ["title", "changed"],
      ["note", "changed note"],
      ["imageOffsetUtf16", 2],
      ["markdownImageWidth", 480],
      ["layoutMode", "unexpected-layout"],
      ["isCollapsed", true],
      ["isStarred", true],
      ["completedAt", "2026-07-13T00:00:00Z"],
      ["createdAt", "2026-07-09T00:00:00Z"],
      ["updatedAt", "2026-07-13T00:00:00Z"],
      ["deletedAt", "2026-07-13T00:00:00Z"],
      ["archivedAt", "2026-07-13T00:00:00Z"],
      ["archiveRootId", "archive-root"]
    ];
    const previous = normalizeWorkspace({ nodes: [base] });

    for (const [field, value] of changes) {
      const changed = { ...base, [field]: value } as NoteNode;
      const next = normalizeWorkspace({ nodes: [changed] });
      expect(
        retainNormalizedWorkspaceIdentity(previous, next).nodesById.node,
        field
      ).toBe(changed);
    }

    const renamed = node({ ...base, id: "renamed" });
    const renamedWorkspace = normalizeWorkspace({ nodes: [renamed] });
    expect(
      retainNormalizedWorkspaceIdentity(previous, renamedWorkspace).nodesById
        .renamed
    ).toBe(renamed);
  });

  it("retains exact root, child, and attachment arrays plus equal attachments", () => {
    const root = node({ id: "root", sortKey: 1 });
    const child = node({ id: "child", parentId: root.id, sortKey: 1 });
    const otherRoot = node({ id: "other-root", sortKey: 2 });
    const otherChild = node({
      id: "other-child",
      parentId: otherRoot.id,
      sortKey: 1
    });
    const first = attachment({ id: "first", nodeId: child.id, sortKey: 1 });
    const second = attachment({ id: "second", nodeId: child.id, sortKey: 2 });
    const previous = normalizeWorkspace({
      nodes: [root, child, otherRoot, otherChild],
      attachmentsByNodeId: { [child.id]: [first, second] }
    });
    const next = normalizeWorkspace({
      nodes: [
        { ...root },
        { ...child },
        { ...otherRoot },
        { ...otherChild }
      ],
      attachmentsByNodeId: {
        [child.id]: [{ ...first }, { ...second }]
      }
    });

    const retained = retainNormalizedWorkspaceIdentity(previous, next);

    expect(retained.rootIds).toBe(previous.rootIds);
    expect(retained.childIdsByParent.root).toBe(
      previous.childIdsByParent.root
    );
    expect(retained.childIdsByParent["other-root"]).toBe(
      previous.childIdsByParent["other-root"]
    );
    expect(retained.attachmentsByNodeId.child).toBe(
      previous.attachmentsByNodeId.child
    );
    expect(retained.attachmentsByNodeId.child[0]).toBe(first);
    expect(retained.attachmentsByNodeId.child[1]).toBe(second);
    expect(retained.nodesById).toBe(previous.nodesById);
    expect(retained.childIdsByParent).toBe(previous.childIdsByParent);
    expect(retained.attachmentsByNodeId).toBe(
      previous.attachmentsByNodeId
    );
  });

  it("creates new arrays when ids, order, or attachment values differ", () => {
    const root = node({ id: "root", sortKey: 1 });
    const otherRoot = node({ id: "other-root", sortKey: 2 });
    const childA = node({ id: "a", parentId: root.id, sortKey: 1 });
    const childB = node({ id: "b", parentId: root.id, sortKey: 2 });
    const first = attachment({ id: "first", nodeId: childA.id, sortKey: 1 });
    const second = attachment({ id: "second", nodeId: childA.id, sortKey: 2 });
    const previous = normalizeWorkspace({
      nodes: [root, otherRoot, childA, childB],
      attachmentsByNodeId: { [childA.id]: [first, second] }
    });
    const reorderedRoot = { ...otherRoot, sortKey: 0 };
    const reorderedChildB = { ...childB, sortKey: 0 };
    const changedSecond = { ...second, displayWidth: 480 };
    const next = normalizeWorkspace({
      nodes: [
        { ...root },
        reorderedRoot,
        { ...childA },
        reorderedChildB
      ],
      attachmentsByNodeId: {
        [childA.id]: [{ ...first }, changedSecond]
      }
    });

    const retained = retainNormalizedWorkspaceIdentity(previous, next);

    expect(retained.rootIds).toBe(next.rootIds);
    expect(retained.rootIds).not.toBe(previous.rootIds);
    expect(retained.childIdsByParent.root).toBe(
      next.childIdsByParent.root
    );
    expect(retained.childIdsByParent.root).not.toBe(
      previous.childIdsByParent.root
    );
    expect(retained.attachmentsByNodeId.a).not.toBe(
      previous.attachmentsByNodeId.a
    );
    expect(retained.attachmentsByNodeId.a[0]).toBe(first);
    expect(retained.attachmentsByNodeId.a[1]).toBe(changedSecond);
  });

  it("compares every NoteAttachment field before retaining the previous object", () => {
    const root = node({ id: "root" });
    const base = attachment({ id: "attachment", nodeId: root.id });
    const changes: ReadonlyArray<
      readonly [
        Exclude<keyof NoteAttachment, "id">,
        NoteAttachment[keyof NoteAttachment]
      ]
    > = [
      ["nodeId", "other-node"],
      ["sortKey", 2048],
      ["relativePath", "assets/changed.png"],
      ["contentHash", "changed-hash"],
      ["originalName", "changed.png"],
      ["mimeType", "image/webp"],
      ["byteSize", 8],
      ["intrinsicWidth", 800],
      ["intrinsicHeight", 600],
      ["displayWidth", 480],
      ["createdAt", "2026-07-11T00:00:00Z"],
      ["updatedAt", "2026-07-13T00:00:00Z"]
    ];
    const previous = normalizeWorkspace({
      nodes: [root],
      attachmentsByNodeId: { [root.id]: [base] }
    });

    for (const [field, value] of changes) {
      const changed = { ...base, [field]: value } as NoteAttachment;
      const next = normalizeWorkspace({
        nodes: [{ ...root }],
        attachmentsByNodeId: { [root.id]: [changed] }
      });
      expect(
        retainNormalizedWorkspaceIdentity(previous, next)
          .attachmentsByNodeId.root[0],
        field
      ).toBe(changed);
    }

    const renamed = { ...base, id: "renamed" };
    const renamedWorkspace = normalizeWorkspace({
      nodes: [{ ...root }],
      attachmentsByNodeId: { [root.id]: [renamed] }
    });
    expect(
      retainNormalizedWorkspaceIdentity(previous, renamedWorkspace)
        .attachmentsByNodeId.root[0]
    ).toBe(renamed);
  });

  it("keeps next UI and status scalars and only reuses the whole workspace when all fields match", () => {
    const base = normalizeWorkspace({ nodes: [node({ id: "root" })] });
    const previous = withUi(base, {
      selectedId: "root",
      status: "loading",
      error: "old"
    });
    const next = withUi(normalizeWorkspace({ nodes: [node({ id: "root" })] }), {
      selectedId: null,
      status: "ready",
      error: null
    });

    const retained = retainNormalizedWorkspaceIdentity(previous, next);

    expect(retained.nodesById).toBe(previous.nodesById);
    expect(retained.selectedId).toBeNull();
    expect(retained.status).toBe("ready");
    expect(retained.error).toBeNull();
    expect(retainNormalizedWorkspaceIdentity(retained, { ...retained })).toBe(
      retained
    );
  });
});
