import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { shouldSeedMonacoOutline } from "./monacoOutlineSeed";

describe("Monaco empty-outline seed", () => {
  it("creates one root bullet only when the projection and store are empty", () => {
    expect(shouldSeedMonacoOutline(0, [], "page")).toBe(true);
    expect(shouldSeedMonacoOutline(1, [], "page")).toBe(false);
    expect(shouldSeedMonacoOutline(0, [node("child", "page")], "page"))
      .toBe(false);
    expect(shouldSeedMonacoOutline(0, [node("other", "other-page")], "page"))
      .toBe(true);
  });
});

function node(id: string, parentId: string): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
    kind: "bullet",
    image: null,
    text: "",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}
