import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  handleImageNodeKeyDown,
  resolveSupportingNoteKey,
  resolveOutlineKey,
  supportingNoteFocusTarget,
  type OutlineKeyInput,
  type SupportingNoteKeyInput
} from "./outlineKeyboard";

function node(
  id: string,
  parentId: string,
  text = id,
  sortKey = 1_024
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet", image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function picture(id: string, parentId: string, sortKey = 1_024): NoteView {
  return {
    ...node(id, parentId, "shot.png", sortKey),
    kind: "image",
    image: {
      contentHash: "a".repeat(64),
      originalName: "shot.png",
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 640,
      pixelHeight: 480,
      displayWidth: 320
    }
  };
}

const visibleNodes = [
  node("parent", "page", "Parent", 1_024),
  node("child", "parent", "Child", 1_024),
  node("next", "page", "Next", 2_048)
] as const;

function input(overrides: Partial<OutlineKeyInput> = {}): OutlineKeyInput {
  return {
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    nodeId: "next",
    pageId: "page",
    value: "alphaXYZomega",
    selectionStart: 5,
    selectionEnd: 8,
    firstVisualLine: true,
    lastVisualLine: true,
    visibleNodes,
    target: "row",
    platform: "other",
    ...overrides
  };
}

describe("v2 outline keyboard intent resolver", () => {
  it("maps image primary-content keys without inventing a text caret", () => {
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      repeat: true
    }))).toEqual({
      kind: "createSibling",
      parentId: "page",
      beforeId: null
    });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Enter",
      shiftKey: true
    }))).toEqual({ kind: "focusNote" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Tab"
    }))).toEqual({ kind: "indent", previousSiblingId: "parent" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowUp"
    }))).toEqual({ kind: "focus", nodeId: "child", edge: "start" });
  });

  it("splits the selected title range into one atomic sibling gesture", () => {
    expect(resolveOutlineKey(input())).toEqual({
      kind: "split",
      prefix: "alpha",
      suffix: "omega",
      parentId: "page",
      beforeId: null
    });
  });

  it("aims a split of a row with children at its own first child slot", () => {
    expect(resolveOutlineKey(input({
      nodeId: "parent",
      value: "AAA BBB",
      selectionStart: 4,
      selectionEnd: 4
    }))).toEqual({
      kind: "split",
      prefix: "AAA ",
      suffix: "BBB",
      parentId: "parent",
      beforeId: "child"
    });
  });

  // Terminal Enter on a row with children is the same rule with an empty half
  // after the caret, so it resolves to the same intent rather than its own kind.
  it("makes terminal Enter on a row with children an empty first child", () => {
    expect(resolveOutlineKey(input({
      nodeId: "parent",
      value: "Parent",
      selectionStart: 6,
      selectionEnd: 6
    }))).toEqual({
      kind: "split",
      prefix: "Parent",
      suffix: "",
      parentId: "parent",
      beforeId: "child"
    });

    expect(resolveOutlineKey(input({
      nodeId: "next",
      value: "Next",
      selectionStart: 4,
      selectionEnd: 4,
      repeat: true
    }))).toEqual({
      kind: "split",
      prefix: "Next",
      suffix: "",
      parentId: "page",
      beforeId: null
    });
  });

  it("maps page-title Enter to the first page child", () => {
    expect(resolveOutlineKey(input({
      target: "page",
      nodeId: "page",
      value: "Page",
      selectionStart: 4,
      selectionEnd: 4
    }))).toEqual({ kind: "createFirstChild", parentId: "page" });
  });

  it("opens a supporting note with one-shot Shift+Enter", () => {
    expect(resolveOutlineKey(input({
      key: "Enter",
      shiftKey: true
    }))).toEqual({ kind: "focusNote" });
    expect(resolveOutlineKey(input({
      key: "Enter",
      shiftKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
    // The page (or zoom root) is a node with a note of its own, so the title
    // takes the same gesture instead of letting Enter reach the textarea.
    expect(resolveOutlineKey(input({
      key: "Enter",
      shiftKey: true,
      target: "page",
      nodeId: "page"
    }))).toEqual({ kind: "focusNote" });
    expect(resolveOutlineKey(input({
      key: "Enter",
      shiftKey: true,
      target: "page",
      nodeId: "page",
      repeat: true
    }))).toEqual({ kind: "consume" });
  });

  it("indents below the previous visible sibling and outdents after the parent", () => {
    expect(resolveOutlineKey(input({
      key: "Tab",
      nodeId: "next",
      value: "Next",
      selectionStart: 2,
      selectionEnd: 2
    }))).toEqual({ kind: "indent", previousSiblingId: "parent" });

    expect(resolveOutlineKey(input({
      key: "Tab",
      shiftKey: true,
      nodeId: "child",
      value: "Child",
      selectionStart: 2,
      selectionEnd: 2
    }))).toEqual({
      kind: "outdent",
      parentId: "page",
      beforeId: "next"
    });
  });

  it("consumes unavailable and repeated Tab without moving a row", () => {
    expect(resolveOutlineKey(input({
      key: "Tab",
      nodeId: "parent",
      value: "Parent"
    }))).toEqual({ kind: "consume" });
    expect(resolveOutlineKey(input({
      key: "Tab",
      nodeId: "next",
      value: "Next",
      repeat: true
    }))).toEqual({ kind: "consume" });
  });

  it("moves Up and Down through visible rows and the page-title boundary", () => {
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      nodeId: "child",
      value: "Child"
    }))).toEqual({ kind: "focus", nodeId: "parent", edge: "start" });
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      nodeId: "parent",
      value: "Parent"
    }))).toEqual({ kind: "focus", nodeId: "page", edge: "start" });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      target: "page",
      nodeId: "page",
      value: "Page"
    }))).toEqual({ kind: "focus", nodeId: "parent", edge: "start" });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      nodeId: "next",
      value: "Next"
    }))).toBeNull();
  });

  it("leaves Up and Down native while the caret has another visual line", () => {
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      nodeId: "child",
      value: "wrapped title",
      firstVisualLine: false,
      lastVisualLine: false
    }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      nodeId: "child",
      value: "wrapped title",
      firstVisualLine: false,
      lastVisualLine: false,
      repeat: true
    }))).toBeNull();
  });

  it("extends a keyboard range from its live head and clears it with Escape", () => {
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      nodeId: "parent"
    }))).toEqual({ kind: "extendSelection", headId: "child" });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      nodeId: "parent",
      selectionHeadId: "child",
      hasSelection: true
    }))).toEqual({ kind: "extendSelection", headId: "next" });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      selectionHeadId: "next",
      hasSelection: true
    }))).toEqual({ kind: "consume" });
    expect(resolveOutlineKey(input({
      key: "Escape",
      hasSelection: true
    }))).toEqual({ kind: "clearSelection" });
    expect(resolveOutlineKey(input({
      key: "Escape",
      hasSelection: false
    }))).toBeNull();
  });

  it("crosses rows with Left and Right only at a collapsed caret boundary", () => {
    expect(resolveOutlineKey(input({
      key: "ArrowLeft",
      nodeId: "child",
      value: "Child",
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({ kind: "focus", nodeId: "parent", edge: "end" });
    expect(resolveOutlineKey(input({
      key: "ArrowRight",
      nodeId: "child",
      value: "Child",
      selectionStart: 5,
      selectionEnd: 5
    }))).toEqual({ kind: "focus", nodeId: "next", edge: "start" });
    expect(resolveOutlineKey(input({
      key: "ArrowRight",
      nodeId: "child",
      value: "Child",
      selectionStart: 4,
      selectionEnd: 4
    }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "ArrowLeft",
      nodeId: "child",
      value: "Child",
      selectionStart: 0,
      selectionEnd: 0,
      repeat: true
    }))).toEqual({ kind: "focus", nodeId: "parent", edge: "end" });
  });

  it("removes only a whitespace-empty row at a plain start caret", () => {
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "parent",
      value: " \t",
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({ kind: "removeEmpty", focusId: "child" });
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "child",
      value: "",
      selectionStart: 1,
      selectionEnd: 1
    }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "child",
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      ctrlKey: true
    }))).toBeNull();
  });

  // A picture row is focusable but has no caret to give, so a caret sent there
  // leaves the typist with focus and nothing to type into.
  it("sends the emptied row's caret past rows that cannot hold one", () => {
    const withPicture = [
      node("above", "page", "Above", 1_024),
      picture("shot", "page", 2_048),
      node("blank", "page", "", 3_072),
      node("kid", "blank", "Kid", 1_024)
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "blank",
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: withPicture,
      structureNodes: withPicture
    }))).toEqual({ kind: "removeEmpty", focusId: "above" });
  });

  it("looks below the emptied row when nothing above can hold the caret", () => {
    const leading = [
      node("blank", "page", "", 1_024),
      picture("shot", "page", 2_048),
      node("below", "page", "Below", 3_072)
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "blank",
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: leading,
      structureNodes: leading
    }))).toEqual({ kind: "removeEmpty", focusId: "below" });
  });

  it("falls back to the page title when no row can hold the caret", () => {
    const pictureOnly = [
      node("blank", "page", "", 1_024),
      picture("shot", "page", 2_048)
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "blank",
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: pictureOnly,
      structureNodes: pictureOnly
    }))).toEqual({ kind: "removeEmpty", focusId: "page" });
  });

  it("merges a title backward only into an eligible previous sibling leaf", () => {
    const flatNodes = [
      node("first", "page", "alpha", 1_024),
      node("second", "page", "beta", 2_048)
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "second",
      value: "beta",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: flatNodes,
      structureNodes: flatNodes
    }))).toEqual({
      kind: "mergeBackward",
      previousId: "first",
      joinOffset: 5
    });

    const notedPrevious = [
      { ...flatNodes[0], note: "supporting note" },
      flatNodes[1]
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "second",
      value: "beta",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: notedPrevious,
      structureNodes: notedPrevious
    }))).toBeNull();

    const parentWithChild = [
      flatNodes[0],
      node("child-of-first", "first", "child", 1_024),
      flatNodes[1]
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "second",
      value: "beta",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: parentWithChild,
      structureNodes: parentWithChild
    }))).toBeNull();
  });

  it("merges a first child into the parent row above it", () => {
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "child",
      value: "Child",
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({ kind: "mergeIntoParent", parentId: "parent" });

    // the merge drops the row, so its note would go with it
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "child",
      value: "Child",
      selectionStart: 0,
      selectionEnd: 0,
      supportingNote: "supporting note"
    }))).toBeNull();

    const notedChild = [
      visibleNodes[0],
      { ...visibleNodes[1], note: "supporting note" },
      visibleNodes[2]
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "child",
      value: "Child",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: notedChild,
      structureNodes: notedChild
    }))).toBeNull();

    // an image row's filename can never take the child's text
    const imageParent = [
      { ...visibleNodes[0], kind: "image" as const },
      visibleNodes[1]
    ];
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "child",
      value: "Child",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: imageParent,
      structureNodes: imageParent
    }))).toBeNull();

    // the first visible row has nothing above it to merge into
    expect(resolveOutlineKey(input({
      key: "Backspace",
      nodeId: "parent",
      value: "Parent",
      selectionStart: 0,
      selectionEnd: 0
    }))).toBeNull();
  });

  // ⌃⌘M is the one binding here that wants BOTH control and meta on a mac,
  // which is exactly what `primaryModifier` refuses, so it carries its own
  // predicate and this test is what keeps the two apart.
  it("opens the move chooser on the platform's Move To combination", () => {
    expect(resolveOutlineKey(input({
      key: "m",
      ctrlKey: true,
      metaKey: true,
      platform: "mac"
    }))).toEqual({ kind: "moveTo" });
    expect(resolveOutlineKey(input({
      key: "M",
      ctrlKey: true,
      altKey: true
    }))).toEqual({ kind: "moveTo" });
  });

  it("swallows a held Move To combination after the first press", () => {
    expect(resolveOutlineKey(input({
      key: "m",
      ctrlKey: true,
      altKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
  });

  it("ignores the other platform's Move To combination and either half", () => {
    for (const platform of ["mac", "other"] as const) {
      // The combination the other platform uses.
      expect(resolveOutlineKey(input({
        key: "m",
        ctrlKey: platform === "mac",
        altKey: platform === "mac",
        metaKey: platform !== "mac",
        platform
      })), platform).toBeNull();
      // One modifier short on either side.
      expect(resolveOutlineKey(input({ key: "m", ctrlKey: true, platform })))
        .toBeNull();
      expect(resolveOutlineKey(input({ key: "m", metaKey: true, platform })))
        .toBeNull();
      expect(resolveOutlineKey(input({ key: "m", altKey: true, platform })))
        .toBeNull();
    }
  });

  it("maps existing single-row shortcuts per platform", () => {
    expect(resolveOutlineKey(input({
      key: "Enter",
      ctrlKey: true
    }))).toEqual({ kind: "toggleComplete" });
    expect(resolveOutlineKey(input({
      key: "D",
      altKey: true,
      shiftKey: true
    }))).toEqual({ kind: "duplicate" });
    expect(resolveOutlineKey(input({
      key: "Backspace",
      ctrlKey: true,
      shiftKey: true
    }))).toEqual({ kind: "trash" });
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      altKey: true,
      shiftKey: true
    }))).toEqual({ kind: "move", direction: "up" });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      ctrlKey: true,
      shiftKey: true,
      platform: "mac"
    }))).toEqual({ kind: "move", direction: "down" });
  });

  it("maps Workflowy zoom shortcuts and consumes their repeats", () => {
    expect(resolveOutlineKey(input({
      key: ".",
      altKey: true
    }))).toEqual({ kind: "zoom", direction: "in" });
    expect(resolveOutlineKey(input({
      key: ",",
      altKey: true,
      target: "page"
    }))).toEqual({ kind: "zoom", direction: "out" });
    expect(resolveOutlineKey(input({
      key: ".",
      metaKey: true,
      platform: "mac"
    }))).toEqual({ kind: "zoom", direction: "in" });
    expect(resolveOutlineKey(input({
      key: ".",
      altKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
    expect(resolveOutlineKey(input({
      key: ".",
      metaKey: true
    }))).toBeNull();
  });

  it("consumes repeated structural shortcuts", () => {
    expect(resolveOutlineKey(input({
      key: "Enter",
      ctrlKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
    expect(resolveOutlineKey(input({
      key: "D",
      altKey: true,
      shiftKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      altKey: true,
      shiftKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
  });

  it("leaves IME and Process events native", () => {
    expect(resolveOutlineKey(input({ isComposing: true }))).toBeNull();
    expect(resolveOutlineKey(input({ key: "Process" }))).toBeNull();
  });
});

describe("v2 supporting-note keyboard resolver", () => {
  const noteInput = (
    overrides: Partial<SupportingNoteKeyInput> = {}
  ): SupportingNoteKeyInput => ({
    key: "Escape",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    selectionStart: 2,
    selectionEnd: 2,
    value: "note",
    ...overrides
  });

  it("moves across title boundaries without stealing native mid-note arrows", () => {
    expect(resolveSupportingNoteKey(noteInput())).toBe("currentTitle");
    expect(resolveSupportingNoteKey(noteInput({
      ...noteInput(),
      key: "ArrowUp",
      selectionStart: 0
    }))).toBe("currentTitle");
    expect(resolveSupportingNoteKey(noteInput({
      ...noteInput(),
      key: "ArrowDown",
      selectionEnd: 4
    }))).toBe("nextTitle");
    expect(resolveSupportingNoteKey(noteInput({
      ...noteInput(),
      key: "ArrowUp"
    }))).toBeNull();
  });

  it("closes an emptied note with Backspace without running into the title", () => {
    expect(resolveSupportingNoteKey(noteInput({
      key: "Backspace",
      selectionStart: 0,
      selectionEnd: 0,
      value: ""
    }))).toBe("removeEmptyNote");
    // Text still in the note keeps Backspace native, caret at the start or not.
    expect(resolveSupportingNoteKey(noteInput({
      key: "Backspace",
      selectionStart: 0,
      selectionEnd: 0
    }))).toBeNull();
    // A held key stops at the empty note instead of eating the title's text.
    expect(resolveSupportingNoteKey(noteInput({
      key: "Backspace",
      selectionStart: 0,
      selectionEnd: 0,
      value: "",
      repeat: true
    }))).toBeNull();
  });

  it("uses one-shot Shift+Enter to move or create outside IME", () => {
    expect(resolveSupportingNoteKey(noteInput({
      ...noteInput(),
      key: "Enter",
      shiftKey: true
    }))).toBe("nextTitleOrCreate");
    expect(resolveSupportingNoteKey(noteInput({
      ...noteInput(),
      key: "Enter",
      shiftKey: true,
      repeat: true
    }))).toBeNull();
    expect(resolveSupportingNoteKey(noteInput({
      ...noteInput(),
      key: "Enter",
      shiftKey: true,
      isComposing: true
    }))).toBeNull();
  });

  it("resolves the next visible title with current-row fallback", () => {
    expect(supportingNoteFocusTarget("nextTitle", "b", ["a", "b", "c"])).toBe("c");
    expect(supportingNoteFocusTarget("nextTitleOrCreate", "c", ["a", "b", "c"])).toBe("c");
    expect(supportingNoteFocusTarget("currentTitle", "b", ["a", "b", "c"])).toBe("b");
  });
});
