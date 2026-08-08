import { describe, expect, it } from "vitest";

import {
  OutlineMetadataTimeline,
  type OutlineLineMetadata,
  validateOutlineMetadata
} from "./metadata";

function line(
  nodeId: string,
  parentId: string,
  depth: number,
  overrides: Partial<OutlineLineMetadata> = {}
): OutlineLineMetadata {
  return {
    nodeId,
    parentId,
    depth,
    kind: "text",
    collapsed: false,
    completed: false,
    ...overrides
  };
}

describe("OutlineMetadataTimeline", () => {
  it("restores the same identities for an earlier alternative version", () => {
    const timeline = OutlineMetadataTimeline.hydrate(1, [
      line("first", "page", 0),
      line("second", "page", 0)
    ]);
    timeline.record(2, [
      line("first", "page", 0),
      line("inserted", "page", 0),
      line("second", "page", 0)
    ]);

    expect(timeline.restore(1).lines.map(({ nodeId }) => nodeId)).toEqual([
      "first",
      "second"
    ]);
    expect(timeline.restore(2).lines.map(({ nodeId }) => nodeId)).toEqual([
      "first",
      "inserted",
      "second"
    ]);
    expect(timeline.restore(2).titleLineByNodeId.get("inserted")).toBe(2);
  });

  it("shares immutable metadata bodies across text-only versions", () => {
    const timeline = OutlineMetadataTimeline.hydrate(1, [
      line("first", "page", 0),
      line("second", "page", 0)
    ]);
    const before = timeline.current();
    const textOnly = timeline.record(2, [
      line("first", "page", 0),
      line("second", "page", 0)
    ]);

    expect(textOnly.alternativeVersionId).toBe(2);
    expect(textOnly.lines).toBe(before.lines);
    expect(textOnly.titleLineByNodeId).toBe(before.titleLineByNodeId);
  });

  it("creates a new immutable body for structural and depth changes", () => {
    const timeline = OutlineMetadataTimeline.hydrate(1, [
      line("first", "page", 0),
      line("second", "page", 0)
    ]);
    const before = timeline.current();
    const structural = timeline.record(2, [
      line("first", "page", 0),
      line("second", "first", 1)
    ]);

    expect(structural.lines).not.toBe(before.lines);
    expect(structural.titleLineByNodeId).not.toBe(before.titleLineByNodeId);
    expect(structural.lines[1]).toMatchObject({
      nodeId: "second",
      parentId: "first",
      depth: 1
    });
  });

  it("replaces the active version without losing recorded branches", () => {
    const timeline = OutlineMetadataTimeline.hydrate(1, [
      line("first", "page", 0)
    ]);
    const inserted = timeline.record(2, [
      line("first", "page", 0),
      line("inserted", "page", 0)
    ]);

    timeline.replaceCurrent(timeline.restore(1));
    expect(timeline.current().alternativeVersionId).toBe(1);
    timeline.replaceCurrent(inserted);
    expect(timeline.current().lines.map(({ nodeId }) => nodeId)).toEqual([
      "first",
      "inserted"
    ]);
  });

  it("rejects duplicate identities and invalid preorder depth", () => {
    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0),
        line("first", "page", 0)
      ])
    ).toThrow("node IDs must be unique");

    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0),
        line("child", "first", 2)
      ])
    ).toThrow("depth may increase by at most one");

    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0),
        line("child", "wrong-parent", 1)
      ])
    ).toThrow("parent must match the visible preorder");
  });
});

describe("outline line kinds", () => {
  it("accepts a note run behind its title and rejects a stranded note", () => {
    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0),
        line("first", "page", 0, { kind: "note" }),
        line("first", "page", 0, { kind: "note" }),
        line("child", "first", 1),
        line("child", "first", 1, { kind: "note" })
      ])
    ).not.toThrow();

    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0),
        line("second", "page", 0, { kind: "note" }),
        line("second", "page", 0)
      ])
    ).toThrow("note line must follow its own title line");

    expect(() =>
      validateOutlineMetadata([
        line("picture", "page", 0, { kind: "image" }),
        line("picture", "page", 0, { kind: "note" })
      ])
    ).toThrow("note line must follow its own title line");
  });

  it("rejects a note line that drifts from its title metadata", () => {
    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0),
        line("child", "first", 1),
        line("child", "first", 2, { kind: "note" })
      ])
    ).toThrow("note line must copy its title line");

    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0),
        line("first", "page", 0, { kind: "note", completed: true })
      ])
    ).toThrow("note line must copy its title line");
  });

  it("rejects children under an image line", () => {
    expect(() =>
      validateOutlineMetadata([
        line("picture", "page", 0, { kind: "image" }),
        line("child", "picture", 1)
      ])
    ).toThrow("image line cannot have children");
  });

  it("indexes title lines and note runs separately", () => {
    const snapshot = OutlineMetadataTimeline.hydrate(1, [
      line("first", "page", 0),
      line("first", "page", 0, { kind: "note" }),
      line("first", "page", 0, { kind: "note" }),
      line("picture", "page", 0, { kind: "image" }),
      line("second", "page", 0)
    ]).current();

    expect([...snapshot.titleLineByNodeId]).toEqual([
      ["first", 1],
      ["picture", 4],
      ["second", 5]
    ]);
    expect(snapshot.noteRangeByNodeId.get("first")).toEqual([2, 3]);
    expect(snapshot.noteRangeByNodeId.has("picture")).toBe(false);
    expect(snapshot.noteRangeByNodeId.has("second")).toBe(false);
  });

  it("rejects a note line in the first position", () => {
    expect(() =>
      validateOutlineMetadata([
        line("first", "page", 0, { kind: "note" }),
        line("first", "page", 0)
      ])
    ).toThrow("first outline line must be a text or image line");
  });
});
