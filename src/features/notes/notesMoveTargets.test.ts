import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  hasValidNotesMoveDestination,
  protectedNotesMoveRootIds
} from "./notesMoveTargets";

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
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null
  };
}

describe("buildNotesMoveDestinations", () => {
  it("excludes every selected root and each complete selected subtree", () => {
    const nodes = [
      node({ id: "moving-a", sortKey: 1 }),
      node({ id: "moving-a-child", parentId: "moving-a", sortKey: 1 }),
      node({
        id: "moving-a-grandchild",
        parentId: "moving-a-child",
        sortKey: 1
      }),
      node({ id: "moving-b", sortKey: 2 }),
      node({ id: "moving-b-child", parentId: "moving-b", sortKey: 1 }),
      node({ id: "available", sortKey: 3, title: "Available" }),
      node({
        id: "available-child",
        parentId: "available",
        sortKey: 1,
        title: "Available child"
      })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(
      buildNotesMoveDestinations(nodesById, ["moving-a", "moving-b"])
    ).toEqual([
      { id: null, label: "Top level", depth: 0 },
      { id: "available", label: "Available", depth: 0 },
      { id: "available-child", label: "Available child", depth: 1 }
    ]);
  });

  it("preserves the existing single-root call shape", () => {
    const nodes = [
      node({ id: "moving", sortKey: 1 }),
      node({ id: "moving-child", parentId: "moving", sortKey: 1 }),
      node({ id: "available", sortKey: 2, title: "Available" })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(buildNotesMoveDestinations(nodesById, "moving")).toEqual([
      { id: null, label: "Top level", depth: 0 },
      { id: "available", label: "Available", depth: 0 }
    ]);
  });

  it("traverses provider-owned GN rows while offering only their user descendants", () => {
    const nodes = [
      node({ id: "moving", sortKey: 1 }),
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 2,
        pluginState: { collapsedGroups: [] }
      }),
      node({
        id: "date",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        pluginMeta: { kind: "date", dateKey: "2026.07.24" }
      }),
      node({
        id: "notification",
        parentId: "date",
        pluginMeta: {
          kind: "notification",
          notificationKey: "thread",
          notificationType: "PullRequest",
          url: "https://github.com/o/r/pull/1",
          updatedAt: "2026-07-24T00:00:00Z",
          unread: true
        }
      }),
      node({
        id: "user-child",
        parentId: "notification",
        title: "User child"
      })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    const destinations = buildNotesMoveDestinations(nodesById, "moving");
    expect(destinations.map((item) => item.id)).toContain("user-child");
    expect(destinations.map((item) => item.id)).not.toContain(
      GITHUB_NOTIFICATIONS_ROOT_ID
    );
    expect(destinations.map((item) => item.id)).not.toContain("date");
    expect(destinations.map((item) => item.id)).not.toContain("notification");
  });
});

describe("hasValidNotesMoveDestination", () => {
  it("blocks moving readonly roots and writable ancestors that contain them", () => {
    const nodes = [
      node({ id: "ancestor", sortKey: 1 }),
      node({
        id: "readonly-child",
        parentId: "ancestor",
        isReadonly: true
      }),
      node({ id: "destination", sortKey: 2 })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    for (const movingId of ["readonly-child", "ancestor"]) {
      expect(buildNotesMoveDestinations(nodesById, movingId)).toEqual([]);
      expect(hasValidNotesMoveDestination(nodesById, movingId)).toBe(false);
      expect(
        buildNotesMoveNodeInput(nodesById, movingId, "destination")
      ).toBeNull();
    }
  });

  it("allows writable bullets to move under readonly destinations", () => {
    const nodes = [
      node({ id: "moving", sortKey: 1 }),
      node({ id: "readonly", sortKey: 2, isReadonly: true })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(buildNotesMoveNodeInput(nodesById, "moving", "readonly")).toEqual({
      id: "moving",
      parentId: "readonly",
      afterId: null
    });
  });

  it("rejects plugin-owned move sources while preserving GN root top-level reorder", () => {
    const nodes = [
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        pluginState: { collapsedGroups: [] }
      }),
      node({
        id: "date",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        pluginMeta: { kind: "date", dateKey: "2026.07.24" }
      }),
      node({
        id: "readonly-user-child",
        parentId: "date",
        isReadonly: true
      }),
      node({ id: "ordinary", sortKey: 2 })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(buildNotesMoveNodeInput(nodesById, "date", null)).toBeNull();
    expect(
      buildNotesMoveNodeInput(
        nodesById,
        GITHUB_NOTIFICATIONS_ROOT_ID,
        null
      )
    ).toEqual({
      id: GITHUB_NOTIFICATIONS_ROOT_ID,
      parentId: null,
      afterId: "ordinary"
    });
    expect(
      buildNotesMoveNodeInput(
        nodesById,
        GITHUB_NOTIFICATIONS_ROOT_ID,
        "ordinary"
      )
    ).toBeNull();
  });

  it("rejects the no-op top-level destination for the sole selected subtree", () => {
    const nodes = [
      node({ id: "only", sortKey: 1 }),
      node({ id: "child", parentId: "only", sortKey: 1 })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(hasValidNotesMoveDestination(nodesById, "only")).toBe(false);
    expect(hasValidNotesMoveDestination(nodesById, ["only"])).toBe(false);
  });

  it("treats an already-last contiguous top-level block as a no-op", () => {
    const nodes = [
      node({ id: "a", sortKey: 1 }),
      node({ id: "b", sortKey: 2 })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(hasValidNotesMoveDestination(nodesById, ["a", "b"])).toBe(false);
  });

  it("accepts selections whose roots currently have mixed parents", () => {
    const nodes = [
      node({ id: "left-parent", sortKey: 1 }),
      node({ id: "left", parentId: "left-parent" }),
      node({ id: "right-parent", sortKey: 2 }),
      node({ id: "right", parentId: "right-parent" })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(hasValidNotesMoveDestination(nodesById, ["left", "right"])).toBe(
      true
    );
  });
});

describe("protectedNotesMoveRootIds", () => {
  it("propagates ordinary and GN-user protection without swallowing the fixed root", () => {
    const nodes = [
      node({ id: "ordinary-root" }),
      node({ id: "ordinary-branch", parentId: "ordinary-root" }),
      node({
        id: "ordinary-readonly",
        parentId: "ordinary-branch",
        isReadonly: true
      }),
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 2,
        pluginState: { collapsedGroups: [] }
      }),
      node({
        id: "date",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        pluginMeta: { kind: "date", dateKey: "2026.07.24" }
      }),
      node({ id: "gn-user", parentId: "date", isReadonly: true }),
      node({
        id: "archived",
        archivedAt: "2026-07-24T00:00:00Z",
        isReadonly: true
      }),
      node({
        id: "deleted",
        deletedAt: "2026-07-24T00:00:00Z",
        isReadonly: true
      })
    ];
    const protectedIds = protectedNotesMoveRootIds(
      Object.fromEntries(nodes.map((item) => [item.id, item]))
    );

    expect([...protectedIds].sort()).toEqual([
      "date",
      "gn-user",
      "ordinary-branch",
      "ordinary-readonly",
      "ordinary-root"
    ]);
    expect(protectedIds.has(GITHUB_NOTIFICATIONS_ROOT_ID)).toBe(false);
  });

  it("keeps ancestor propagation linear for dense overlapping readonly chains", () => {
    const measuredReads = (count: number) => {
      const entries = Array.from({ length: count }, (_, index) => {
        const id = `node-${index}`;
        return [
          id,
          node({
            id,
            parentId: index === 0 ? null : `node-${index - 1}`,
            sortKey: index,
            isReadonly: true
          })
        ] as const;
      });
      let ownKeys = 0;
      let reads = 0;
      const target = Object.fromEntries(entries);
      const proxy = new Proxy(target, {
        ownKeys(value) {
          ownKeys += 1;
          return Reflect.ownKeys(value);
        },
        get(value, key, receiver) {
          if (typeof key === "string" && key.startsWith("node-")) {
            reads += 1;
          }
          return Reflect.get(value, key, receiver);
        }
      });
      const protectedIds = protectedNotesMoveRootIds(proxy);
      expect(protectedIds.size).toBe(count);
      expect(ownKeys).toBeLessThanOrEqual(2);
      expect(reads).toBeLessThanOrEqual(6 * count);
      return reads;
    };

    const reads400 = measuredReads(400);
    const reads800 = measuredReads(800);
    expect(reads800).toBeLessThanOrEqual(reads400 * 2.2);
  });
});
