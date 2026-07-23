import { describe, expect, it } from "vitest";
import type { FlattenedOutlineRow } from "./outlineTree";
import { retainOutlineRowProjection } from "./outlineRowProjection";

const OUTLINE_ROW_FIELDS = [
  "id",
  "parentId",
  "depth",
  "isCollapsed",
  "ancestorIds",
  "ancestorGuideDepths",
  "visibleDescendantEndId"
] as const satisfies readonly (keyof FlattenedOutlineRow)[];
const ALL_ROW_FIELDS_LISTED: Exclude<
  keyof FlattenedOutlineRow,
  (typeof OUTLINE_ROW_FIELDS)[number]
> extends never
  ? true
  : never = true;
void ALL_ROW_FIELDS_LISTED;

function row(
  id: string,
  overrides: Partial<FlattenedOutlineRow> = {}
): FlattenedOutlineRow {
  return {
    id,
    parentId: null,
    depth: 0,
    isCollapsed: false,
    ancestorIds: [],
    ancestorGuideDepths: [],
    visibleDescendantEndId: null,
    ...overrides
  };
}

describe("retainOutlineRowProjection", () => {
  it("reuses equal row objects by id when their order shifts", () => {
    const previous = [
      row("a"),
      row("b", { parentId: "a", depth: 1, ancestorIds: ["a"] }),
      row("c")
    ];
    const next = [
      { ...previous[2], ancestorIds: [], ancestorGuideDepths: [] },
      {
        ...previous[1],
        ancestorIds: ["a"],
        ancestorGuideDepths: []
      },
      { ...previous[0], ancestorIds: [], ancestorGuideDepths: [] }
    ];

    const retained = retainOutlineRowProjection(previous, next);

    expect(retained).not.toBe(previous);
    expect(retained.map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect(retained[0]).toBe(previous[2]);
    expect(retained[1]).toBe(previous[1]);
    expect(retained[2]).toBe(previous[0]);
  });

  it("reuses the previous array when order and all row metadata are equal", () => {
    const previous = [
      row("root", { visibleDescendantEndId: "child" }),
      row("child", {
        parentId: "root",
        depth: 1,
        ancestorIds: ["root"],
        ancestorGuideDepths: [0]
      })
    ];
    const next = previous.map((item) => ({
      ...item,
      ancestorIds: [...item.ancestorIds],
      ancestorGuideDepths: [...item.ancestorGuideDepths]
    }));

    expect(retainOutlineRowProjection(previous, next)).toBe(previous);
  });

  it("creates a new row for every parent, depth, collapse, guide, or descendant metadata change", () => {
    const previousRow = row("node", {
      parentId: "parent",
      depth: 2,
      isCollapsed: false,
      ancestorIds: ["root", "parent"],
      ancestorGuideDepths: [0, 1],
      visibleDescendantEndId: "descendant"
    });
    const changes: ReadonlyArray<
      readonly [
        Exclude<keyof FlattenedOutlineRow, "id">,
        FlattenedOutlineRow[keyof FlattenedOutlineRow]
      ]
    > = [
      ["parentId", "other-parent"],
      ["depth", 3],
      ["isCollapsed", true],
      ["ancestorIds", ["root", "other-parent"]],
      ["ancestorGuideDepths", [0, 2]],
      ["visibleDescendantEndId", "other-descendant"]
    ];

    for (const [field, value] of changes) {
      const nextRow = {
        ...previousRow,
        [field]: value
      } as FlattenedOutlineRow;
      expect(
        retainOutlineRowProjection([previousRow], [nextRow])[0],
        field
      ).toBe(nextRow);
    }

    const renamed = { ...previousRow, id: "renamed" };
    expect(retainOutlineRowProjection([previousRow], [renamed])[0]).toBe(
      renamed
    );
  });

  it("requires exact ancestor and guide array length, order, and values", () => {
    const previousRow = row("node", {
      parentId: "parent",
      depth: 2,
      ancestorIds: ["root", "parent"],
      ancestorGuideDepths: [0, 1]
    });
    const equal = {
      ...previousRow,
      ancestorIds: ["root", "parent"],
      ancestorGuideDepths: [0, 1]
    };
    const longer = {
      ...previousRow,
      ancestorIds: ["root", "parent", "extra"]
    };
    const reordered = {
      ...previousRow,
      ancestorGuideDepths: [1, 0]
    };

    expect(retainOutlineRowProjection([previousRow], [equal])[0]).toBe(
      previousRow
    );
    expect(retainOutlineRowProjection([previousRow], [longer])[0]).toBe(
      longer
    );
    expect(retainOutlineRowProjection([previousRow], [reordered])[0]).toBe(
      reordered
    );
  });
});
