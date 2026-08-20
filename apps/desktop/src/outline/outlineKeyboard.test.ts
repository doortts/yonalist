import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { OutlineIndex } from "./outlineIndex";
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

/** A parent with three children and a following sibling, band already live. */
const bandNodes = [
  node("parent", "page", "Parent", 1_024),
  node("kid-one", "parent", "kid one", 1_024),
  node("kid-two", "parent", "kid two", 2_048),
  node("kid-three", "parent", "kid three", 3_072),
  node("after", "page", "After", 2_048)
] as const;

function bandInput(overrides: Partial<OutlineKeyInput> = {}): OutlineKeyInput {
  return input({
    key: "ArrowDown",
    shiftKey: true,
    nodeId: "parent",
    value: "Parent",
    hasSelection: true,
    visibleNodes: bandNodes,
    visibleIndex: new OutlineIndex(bandNodes),
    ...overrides
  });
}

describe("v2 outline keyboard intent resolver", () => {
  it("takes copy and cut off a caret-only bullet row", () => {
    const caret = { selectionStart: 5, selectionEnd: 5 };
    expect(resolveOutlineKey(input({
      key: "c", ctrlKey: true, ...caret
    }))).toEqual({ kind: "copyRow" });
    expect(resolveOutlineKey(input({
      key: "x", ctrlKey: true, ...caret
    }))).toEqual({ kind: "cutRow" });
    expect(resolveOutlineKey(input({
      key: "c", metaKey: true, platform: "mac", ...caret
    }))).toEqual({ kind: "copyRow" });
    // A held chord runs once and never leaks to the native copy underneath.
    expect(resolveOutlineKey(input({
      key: "x", ctrlKey: true, repeat: true, ...caret
    }))).toEqual({ kind: "consume" });
    // Swept text, a live band, the shifted or alted chord, the other
    // platform's modifier and the page title all leave the chord alone.
    expect(resolveOutlineKey(input({ key: "c", ctrlKey: true }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "c", ctrlKey: true, hasSelection: true, ...caret
    }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "c", ctrlKey: true, shiftKey: true, ...caret
    }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "c", ctrlKey: true, altKey: true, ...caret
    }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "c", metaKey: true, ...caret
    }))).toBeNull();
    expect(resolveOutlineKey(input({
      key: "c", ctrlKey: true, target: "page", ...caret
    }))).toBeNull();
  });

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

  // The shifted arrow sweeps the image the way it sweeps a letter, so it only
  // takes it when the image is the thing the caret would move over.
  it("selects the image only when the shifted arrow sweeps toward it", () => {
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowRight",
      shiftKey: true,
      imageEdge: "before"
    }))).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: "end"
    });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowLeft",
      shiftKey: true,
      imageEdge: "after"
    }))).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: "start"
    });
    // Away from the image there is nothing beside the caret to take.
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowRight",
      shiftKey: true,
      imageEdge: "after"
    }))).toBeNull();
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowLeft",
      shiftKey: true,
      imageEdge: "before"
    }))).toBeNull();
  });

  it("selects the image itself when the station takes a shifted arrow", () => {
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      expect(handleImageNodeKeyDown(input({
        nodeId: "next",
        key,
        shiftKey: true
      }))).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: key === "ArrowUp" || key === "ArrowLeft" ? "start" : "end"
    });
      expect(handleImageNodeKeyDown(input({
        nodeId: "next",
        key,
        shiftKey: true,
        metaKey: true
      }))).toBeNull();
      expect(handleImageNodeKeyDown(input({
        nodeId: "next",
        key,
        shiftKey: true,
        altKey: true
      }))).toBeNull();
    }
  });

  // WebKit fires no clipboard event for a focused div, so the image's copy and
  // cut have to be read off the keydown itself.
  it("takes copy and cut off the station's own primary chord", () => {
    for (const [key, kind] of [["c", "copyImage"], ["x", "cutImage"]]) {
      expect(handleImageNodeKeyDown(input({ key, ctrlKey: true })))
        .toEqual({ kind });
      expect(handleImageNodeKeyDown(input({
        key,
        metaKey: true,
        platform: "mac"
      }))).toEqual({ kind });
      expect(handleImageNodeKeyDown(input({
        key,
        ctrlKey: true,
        repeat: true
      }))).toEqual({ kind: "consume" });
      // The other platform's modifier, and either one wearing shift or alt,
      // belong to somebody else.
      expect(handleImageNodeKeyDown(input({ key, metaKey: true }))).toBeNull();
      expect(handleImageNodeKeyDown(input({
        key,
        ctrlKey: true,
        shiftKey: true
      }))).toBeNull();
      expect(handleImageNodeKeyDown(input({
        key,
        ctrlKey: true,
        altKey: true
      }))).toBeNull();
    }
  });

  // Caret, image, caret: the image is a stop of its own between its two
  // stations, so a plain arrow takes three presses to cross the row.
  it("steps the caret onto the image and off its far side", () => {
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowRight",
      imageEdge: "before"
    }))).toEqual({ kind: "focusImage", nodeId: "next" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowRight"
    }))).toEqual({ kind: "focus", nodeId: "next", edge: "end" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowLeft",
      imageEdge: "after"
    }))).toEqual({ kind: "focusImage", nodeId: "next" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowLeft"
    }))).toEqual({ kind: "focus", nodeId: "next", edge: "start" });
    // The outer sides keep the row-boundary moves they always made.
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "ArrowLeft",
      imageEdge: "before"
    }))).toEqual({ kind: "focus", nodeId: "child", edge: "end" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "child",
      key: "ArrowRight",
      imageEdge: "after"
    }))).toEqual({ kind: "focus", nodeId: "next", edge: "start" });
  });
  // Backspace takes what stands behind the caret. Behind the station past the
  // picture, and behind the caret standing on the picture itself, that is the
  // picture. Behind the station before it stands the previous row, and a bullet
  // there is nobody's to take from a neighbour's station.
  it("deletes the picture behind the caret, never the one ahead", () => {
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Backspace",
      imageEdge: "after"
    }))).toEqual({ kind: "trash" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Backspace"
    }))).toEqual({ kind: "trash" });
    // A held key takes the one picture, not one per repeat.
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Backspace",
      imageEdge: "after",
      repeat: true
    }))).toEqual({ kind: "consume" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Backspace",
      imageEdge: "before"
    }))).toBeNull();
    // A band answers the delete keys with itself wherever the caret parks, the
    // far station included: the key falls through to the one rule that owns it.
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Backspace",
      imageEdge: "before",
      hasSelection: true
    }))).toEqual({ kind: "trash" });
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Backspace",
      imageEdge: "before",
      hasSelection: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
    // A modifier makes it somebody else's key -- ⌘⌫ deletes to the head of a
    // line, which is no picture leaving -- and the trash chord still reaches the
    // row rules underneath. Deleting forward is nobody's ask here either: the
    // picture stands behind this caret, not ahead of it.
    for (const overrides of [
      { altKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { metaKey: true, platform: "mac" as const }
    ]) {
      expect(handleImageNodeKeyDown(input({
        nodeId: "next",
        key: "Backspace",
        imageEdge: "after",
        ...overrides
      }))).toBeNull();
    }
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Delete",
      imageEdge: "after"
    }))).toBeNull();
    expect(handleImageNodeKeyDown(input({
      nodeId: "next",
      key: "Backspace",
      imageEdge: "after",
      ctrlKey: true,
      shiftKey: true
    }))).toEqual({ kind: "trash" });
  });

  // From the before station the row behind the caret is the previous visible
  // row, and a picture of the same parent is taken there the way the after
  // station takes its own -- the same act, one row boundary back. A picture at
  // another depth, the caret's own parent, and a bullet all stay: the
  // head-of-line merge draws those same lines, so the two backward keys read as
  // one caret.
  it("takes the image sibling standing behind the before station", () => {
    const stacked = [
      node("first", "page", "First", 1_024),
      picture("upper", "page", 2_048),
      picture("lower", "page", 3_072)
    ];
    // Production always hands the resolver both indexes, so the fixtures carry
    // them: without one, every assertion here would walk the fallback scan and
    // leave the lookup production uses untested.
    const before = (
      nodes: readonly NoteView[],
      nodeId: string,
      structure: readonly NoteView[] = nodes
    ) => input({
      nodeId,
      key: "Backspace",
      imageEdge: "before",
      visibleNodes: nodes,
      structureNodes: structure,
      visibleIndex: new OutlineIndex(nodes),
      structureIndex: new OutlineIndex(structure)
    });
    // A collapsed row hiding a child puts the structure's positions ahead of
    // the screen's, which is what says the row behind the caret has to be
    // counted in the list the caret is standing in.
    const collapsed = [
      stacked[0]!,
      node("tucked", "first", "Tucked", 1_024),
      stacked[1]!,
      stacked[2]!
    ];

    expect(handleImageNodeKeyDown(before(stacked, "lower", collapsed)))
      .toEqual({ kind: "trash", nodeId: "upper" });
    // A text row behind the caret is the commonest thing there, and it is not
    // this key's to take: the sibling above `upper` is a bullet.
    expect(handleImageNodeKeyDown(before(stacked, "upper"))).toBeNull();
    // A held key takes one picture off the stack, not the whole stack.
    expect(handleImageNodeKeyDown({
      ...before(stacked, "lower"),
      repeat: true
    })).toEqual({ kind: "consume" });

    const aunt = [
      node("parent", "page", "Parent", 1_024),
      picture("aunt", "parent", 1_024),
      picture("lower", "page", 2_048)
    ];
    expect(handleImageNodeKeyDown(before(aunt, "lower"))).toBeNull();

    const nested = [picture("upper", "page", 1_024), picture("lower", "upper", 1_024)];
    expect(handleImageNodeKeyDown(before(nested, "lower"))).toBeNull();

    const captioned = [
      picture("upper", "page", 1_024),
      node("cap", "upper", "Cap", 1_024),
      picture("lower", "page", 2_048)
    ];
    expect(handleImageNodeKeyDown(before(captioned, "lower"))).toBeNull();

    expect(handleImageNodeKeyDown(before([picture("solo", "page")], "solo")))
      .toBeNull();
    // The caret's own row missing from the rows on screen: with no row to
    // stand on there is no row behind it either, and the lookup that reads
    // both off the one list says so without asking the structure for a second
    // opinion.
    expect(handleImageNodeKeyDown(before(stacked, "ghost"))).toBeNull();
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

  // Enter at the head of the text is not a split at all: the row keeps what it
  // has and a blank sibling goes in above it. Splitting here would hand the text
  // to the new row -- inside the source, on a row with children, which demotes
  // the parent into its own first child.
  it("opens a blank sibling above when the caret sits at the head", () => {
    expect(resolveOutlineKey(input({
      nodeId: "parent",
      value: "Parent",
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({
      kind: "createSibling",
      parentId: "page",
      beforeId: "parent"
    });
    // Childless rows take the same rule, so the row that owns the text keeps
    // owning it -- along with its note and its tick.
    expect(resolveOutlineKey(input({
      nodeId: "child",
      value: "Child",
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({
      kind: "createSibling",
      parentId: "parent",
      beforeId: "child"
    });
    // A swept span starting at the head is a real split: the sweep goes away and
    // the half after it moves.
    expect(resolveOutlineKey(input({
      nodeId: "next",
      value: "alphaomega",
      selectionStart: 0,
      selectionEnd: 5
    }))).toEqual({
      kind: "split",
      prefix: "",
      suffix: "omega",
      parentId: "page",
      beforeId: null
    });
    // An empty row has no text to keep, so Enter stays the split it was.
    expect(resolveOutlineKey(input({
      nodeId: "parent",
      value: "",
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({
      kind: "split",
      prefix: "",
      suffix: "",
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
      nodeId: "parent",
      selectionHeadId: "parent",
      hasSelection: true
    }))).toEqual({
      kind: "extendSelection",
      headId: "child",
      edge: "end"
    });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      nodeId: "parent",
      selectionHeadId: "child",
      hasSelection: true
    }))).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: "end"
    });
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

  // Taking a parent takes its subtree, so a head walking one visible row at a
  // time spends a press per child without changing what is selected.
  it("steps the growing head past the rows the band already holds", () => {
    expect(resolveOutlineKey(bandInput({
      selectionHeadId: "parent",
      selectionAnchorId: "parent"
    }))).toEqual({
      kind: "extendSelection",
      headId: "after",
      edge: "end"
    });
    // A grandchild is inside the subtree too, wherever it sits in the order.
    const deep = [
      node("parent", "page", "Parent", 1_024),
      node("kid-one", "parent", "kid one", 1_024),
      node("grandkid", "kid-one", "grandkid", 1_024),
      node("after", "page", "After", 2_048)
    ];
    expect(resolveOutlineKey(bandInput({
      visibleNodes: deep,
      visibleIndex: new OutlineIndex(deep),
      selectionHeadId: "parent",
      selectionAnchorId: "parent"
    }))).toEqual({
      kind: "extendSelection",
      headId: "after",
      edge: "end"
    });
    // A collapsed parent shows no children, so there is nothing to step past.
    const collapsed = [
      { ...node("parent", "page", "Parent", 1_024), collapsed: true },
      node("after", "page", "After", 2_048)
    ];
    expect(resolveOutlineKey(bandInput({
      visibleNodes: collapsed,
      visibleIndex: new OutlineIndex(collapsed),
      selectionHeadId: "parent",
      selectionAnchorId: "parent"
    }))).toEqual({
      kind: "extendSelection",
      headId: "after",
      edge: "end"
    });
    // Nothing below the subtree: the band is already everything there is.
    expect(resolveOutlineKey(bandInput({
      selectionHeadId: "after",
      selectionAnchorId: "parent"
    }))).toEqual({ kind: "consume" });
  });

  it("gives back only the rows a shrinking band really holds", () => {
    // The anchor below the head means Down is giving rows back. `parent` leaves
    // the band with it, so that press changes what is selected.
    expect(resolveOutlineKey(bandInput({
      selectionHeadId: "parent",
      selectionAnchorId: "after"
    }))).toEqual({
      kind: "extendSelection",
      headId: "kid-one",
      edge: "end"
    });
    // Anchored on the parent with the head below its subtree: the sibling comes
    // out of the band on the first press. Every row between it and the anchor is
    // inside the anchor's subtree, so the next press has nowhere to put the head
    // but the anchor itself, and a further one has nothing left to give.
    expect(resolveOutlineKey(bandInput({
      key: "ArrowUp",
      selectionHeadId: "after",
      selectionAnchorId: "parent"
    }))).toEqual({
      kind: "extendSelection",
      headId: "kid-three",
      edge: "start"
    });
    expect(resolveOutlineKey(bandInput({
      key: "ArrowUp",
      selectionHeadId: "kid-three",
      selectionAnchorId: "parent"
    }))).toEqual({
      kind: "extendSelection",
      headId: "parent",
      edge: "start"
    });
    expect(resolveOutlineKey(bandInput({
      key: "ArrowUp",
      selectionHeadId: "parent",
      selectionAnchorId: "parent"
    }))).toEqual({ kind: "consume" });
    // Growing again from a head left inside the subtree wastes no press either.
    expect(resolveOutlineKey(bandInput({
      selectionHeadId: "kid-two",
      selectionAnchorId: "parent"
    }))).toEqual({
      kind: "extendSelection",
      headId: "after",
      edge: "end"
    });
  });

  it("steps one row when the band has no anchor to measure against", () => {
    expect(resolveOutlineKey(bandInput({
      selectionHeadId: "parent"
    }))).toEqual({
      kind: "extendSelection",
      headId: "kid-one",
      edge: "end"
    });
    expect(resolveOutlineKey(bandInput({
      selectionHeadId: "parent",
      selectionAnchorId: "gone"
    }))).toEqual({
      kind: "extendSelection",
      headId: "kid-one",
      edge: "end"
    });
    // A head at the anchor going the other way starts a band upward, and the
    // row above is outside the subtree it is about to take.
    expect(resolveOutlineKey(bandInput({
      key: "ArrowUp",
      selectionHeadId: "after",
      selectionAnchorId: "after"
    }))).toEqual({
      kind: "extendSelection",
      headId: "kid-three",
      edge: "start"
    });
  });

  // Text first, then the row, then its neighbours: each stage starts where the
  // one before it left the caret, so the same chord climbs them in order.
  it("sweeps a row's own text before it takes the row", () => {
    // Mid-row, so the sweep only reaches the edge the arrow points at.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 5,
      selectionEnd: 5
    }))).toEqual({
      kind: "selectTextEdge", start: 0, end: 5, direction: "backward"
    });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      selectionStart: 5,
      selectionEnd: 5
    }))).toEqual({
      kind: "selectTextEdge", start: 5, end: 13, direction: "forward"
    });
    // The caret standing on the edge the arrow points at has no text left to
    // sweep, so the next one takes the row itself.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: "start"
    });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      selectionStart: 13,
      selectionEnd: 13
    }))).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: "end"
    });
    // From the row's near edge the sweep runs the whole way across it.
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({
      kind: "selectTextEdge", start: 0, end: 13, direction: "forward"
    });
  });

  it("leaves the anchor of a swept span where it stands", () => {
    // Swept rightwards from 5: the caret is the far end, the anchor stays at 5.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 5,
      selectionEnd: 8,
      selectionDirection: "forward"
    }))).toEqual({
      kind: "selectTextEdge", start: 0, end: 5, direction: "backward"
    });
    // Swept leftwards to 5: the anchor is the 8 end, and the caret carries on.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 5,
      selectionEnd: 8,
      selectionDirection: "backward"
    }))).toEqual({
      kind: "selectTextEdge", start: 0, end: 8, direction: "backward"
    });
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      shiftKey: true,
      selectionStart: 5,
      selectionEnd: 8,
      selectionDirection: "backward"
    }))).toEqual({
      kind: "selectTextEdge", start: 8, end: 13, direction: "forward"
    });
    // A span already touching the edge the arrow points at takes the row.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 0,
      selectionEnd: 8,
      selectionDirection: "backward"
    }))).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: "start"
    });
    // A forward span whose anchor already sits on the start has nowhere left to
    // carry the caret, so the press collapses it. Native does the same; the row
    // comes on the press after.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 0,
      selectionEnd: 8,
      selectionDirection: "forward"
    }))).toEqual({
      kind: "selectTextEdge", start: 0, end: 0, direction: "backward"
    });
    // The caret on the row's far end sweeps back to its start.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 13,
      selectionEnd: 13
    }))).toEqual({
      kind: "selectTextEdge", start: 0, end: 13, direction: "backward"
    });
  });

  // WKWebView reports no direction for a span the mouse drew, and guessing its
  // caret end wrong would drop the far half of it. An undirected span keeps both
  // ends: the anchor is the end the arrow points away from.
  it("only grows a span whose direction the engine never gave", () => {
    for (const selectionDirection of ["none", undefined] as const) {
      expect(resolveOutlineKey(input({
        key: "ArrowUp",
        shiftKey: true,
        selectionStart: 5,
        selectionEnd: 8,
        selectionDirection
      })), `${selectionDirection} up`).toEqual({
        kind: "selectTextEdge", start: 0, end: 8, direction: "backward"
      });
      expect(resolveOutlineKey(input({
        key: "ArrowDown",
        shiftKey: true,
        selectionStart: 5,
        selectionEnd: 8,
        selectionDirection
      })), `${selectionDirection} down`).toEqual({
        kind: "selectTextEdge", start: 5, end: 13, direction: "forward"
      });
      // An undirected span already spanning the row takes the row either way.
      for (const key of ["ArrowUp", "ArrowDown"]) {
        expect(resolveOutlineKey(input({
          key,
          shiftKey: true,
          selectionStart: 0,
          selectionEnd: 13,
          selectionDirection
        })), `${selectionDirection} ${key}`)
          .toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: key === "ArrowUp" || key === "ArrowLeft" ? "start" : "end"
    });
      }
    }
  });

  // Nothing to sweep means the row is the only thing the chord can take.
  it("takes the whole row when it holds no text to sweep", () => {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(resolveOutlineKey(input({
        key,
        shiftKey: true,
        value: "",
        selectionStart: 0,
        selectionEnd: 0
      })), key).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: key === "ArrowUp" || key === "ArrowLeft" ? "start" : "end"
    });
      expect(handleImageNodeKeyDown(input({
        key,
        shiftKey: true,
        nodeId: "next"
      })), key).toEqual({
      kind: "extendSelection",
      headId: "next",
      edge: key === "ArrowUp" || key === "ArrowLeft" ? "start" : "end"
    });
    }
  });

  // A wrapped row is still one row: the sweep runs to its edge in one press
  // rather than climbing its visual lines.
  it("sweeps past a wrapped row's visual lines in one press", () => {
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      shiftKey: true,
      selectionStart: 5,
      selectionEnd: 5,
      firstVisualLine: false,
      lastVisualLine: false
    }))).toEqual({
      kind: "selectTextEdge", start: 0, end: 5, direction: "backward"
    });
  });

  // Primary fold/expand shortcuts: Cmd+Up / Cmd+Down (or Ctrl+Up / Ctrl+Down)
  // Alias fold/expand shortcuts: Cmd+Option+[ / Cmd+Option+] (or Ctrl+Alt+[ / Ctrl+Alt+])
  it("resolves primary and alias fold/expand shortcuts on a row", () => {
    // Primary collapse on mac (Cmd+ArrowUp)
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      metaKey: true,
      platform: "mac"
    }))).toEqual({ kind: "setCollapsed", collapsed: true });

    // Primary expand on mac (Cmd+ArrowDown)
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      metaKey: true,
      platform: "mac"
    }))).toEqual({ kind: "setCollapsed", collapsed: false });

    // Primary collapse on non-mac (Ctrl+ArrowUp)
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      ctrlKey: true,
      platform: "other"
    }))).toEqual({ kind: "setCollapsed", collapsed: true });

    // Primary expand on non-mac (Ctrl+ArrowDown)
    expect(resolveOutlineKey(input({
      key: "ArrowDown",
      ctrlKey: true,
      platform: "other"
    }))).toEqual({ kind: "setCollapsed", collapsed: false });

    // Alias collapse on mac (Cmd+Option+[)
    expect(resolveOutlineKey(input({
      key: "[",
      metaKey: true,
      altKey: true,
      platform: "mac"
    }))).toEqual({ kind: "setCollapsed", collapsed: true });

    // Alias expand on mac (Cmd+Option+])
    expect(resolveOutlineKey(input({
      key: "]",
      metaKey: true,
      altKey: true,
      platform: "mac"
    }))).toEqual({ kind: "setCollapsed", collapsed: false });

    // Alias collapse on non-mac (Ctrl+Alt+[)
    expect(resolveOutlineKey(input({
      key: "[",
      ctrlKey: true,
      altKey: true,
      platform: "other"
    }))).toEqual({ kind: "setCollapsed", collapsed: true });

    // Alias expand on non-mac (Ctrl+Alt+])
    expect(resolveOutlineKey(input({
      key: "]",
      ctrlKey: true,
      altKey: true,
      platform: "other"
    }))).toEqual({ kind: "setCollapsed", collapsed: false });

    // Repeated shortcut consumes without extra dispatch
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      metaKey: true,
      platform: "mac",
      repeat: true
    }))).toEqual({ kind: "consume" });

    expect(resolveOutlineKey(input({
      key: "]",
      ctrlKey: true,
      altKey: true,
      platform: "other",
      repeat: true
    }))).toEqual({ kind: "consume" });

    // Page title target consumes fold/expand chords
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      metaKey: true,
      target: "page",
      platform: "mac"
    }))).toEqual({ kind: "consume" });

    expect(resolveOutlineKey(input({
      key: "[",
      metaKey: true,
      altKey: true,
      target: "page",
      platform: "mac"
    }))).toEqual({ kind: "consume" });

    // Shift with the modifier is the row-moving binding, not this one
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      ctrlKey: true,
      shiftKey: true,
      nodeId: "next",
      platform: "mac",
      metaKey: false
    }))).toEqual({ kind: "move", direction: "up" });
  });

  // The row's own text first; every rung after it is the band's to widen.
  it("takes the row's text before it widens the band", () => {
    expect(resolveOutlineKey(input({
      key: "a",
      ctrlKey: true
    }))).toEqual({
      kind: "selectTextEdge",
      start: 0,
      end: "alphaXYZomega".length,
      direction: "forward"
    });
    // The whole row already swept: the next press widens the band.
    expect(resolveOutlineKey(input({
      key: "a",
      ctrlKey: true,
      selectionStart: 0,
      selectionEnd: "alphaXYZomega".length
    }))).toEqual({ kind: "widenSelection" });
    // A row with no text to take -- an empty bullet, an image -- has only the
    // band to widen.
    expect(resolveOutlineKey(input({
      key: "a",
      ctrlKey: true,
      value: "",
      selectionStart: 0,
      selectionEnd: 0
    }))).toEqual({ kind: "widenSelection" });
    // With a band already up the text rung has nothing to say.
    expect(resolveOutlineKey(input({
      key: "a",
      ctrlKey: true,
      hasSelection: true
    }))).toEqual({ kind: "widenSelection" });
    // On a mac it rides Cmd, and a held chord stops where it got to.
    expect(resolveOutlineKey(input({
      key: "A",
      metaKey: true,
      platform: "mac",
      selectionStart: 0,
      selectionEnd: "alphaXYZomega".length
    }))).toEqual({ kind: "widenSelection" });
    expect(resolveOutlineKey(input({
      key: "a",
      ctrlKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
    // Shift or Alt with it is nobody's binding here.
    expect(resolveOutlineKey(input({
      key: "a",
      ctrlKey: true,
      shiftKey: true
    }))).toBeNull();
  });

  it("collapses a row band to the edge a bare arrow points at", () => {
    for (const key of ["ArrowUp", "ArrowLeft"]) {
      expect(resolveOutlineKey(input({
        key,
        hasSelection: true,
        selectionHeadId: "parent"
      })), key).toEqual({
        kind: "clearSelection",
        collapse: "start",
        step: key === "ArrowUp"
      });
    }
    for (const key of ["ArrowDown", "ArrowRight"]) {
      expect(resolveOutlineKey(input({
        key,
        hasSelection: true,
        selectionHeadId: "parent"
      })), key).toEqual({
        kind: "clearSelection",
        collapse: "end",
        step: key === "ArrowDown"
      });
    }
    // Escape drops the band and leaves the caret where it already stands.
    expect(resolveOutlineKey(input({
      key: "Escape",
      hasSelection: true
    }))).toEqual({ kind: "clearSelection" });
    // With no band the arrows keep crossing rows as they always have.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      nodeId: "child",
      value: "Child"
    }))).toEqual({ kind: "focus", nodeId: "parent", edge: "start" });
    // A modified arrow is somebody else's binding, band or no band.
    expect(resolveOutlineKey(input({
      key: "ArrowUp",
      altKey: true,
      shiftKey: true,
      hasSelection: true
    }))).toEqual({ kind: "move", direction: "up" });
  });

  // An image row drops a band on the same keys a bullet does. Its own caret-hop
  // bindings would otherwise walk the caret out from under a live band.
  it("drops a band off an image row before hopping its caret stations", () => {
    for (const imageEdge of ["before", "after", undefined] as const) {
      expect(handleImageNodeKeyDown(input({
        key: "ArrowLeft",
        nodeId: "next",
        hasSelection: true,
        selectionHeadId: "next",
        imageEdge
      })), `left ${imageEdge}`)
        .toEqual({ kind: "clearSelection", collapse: "start", step: false });
      expect(handleImageNodeKeyDown(input({
        key: "ArrowRight",
        nodeId: "next",
        hasSelection: true,
        selectionHeadId: "next",
        imageEdge
      })), `right ${imageEdge}`)
        .toEqual({ kind: "clearSelection", collapse: "end", step: false });
    }
    // With no band the stations keep hopping as they always have.
    expect(handleImageNodeKeyDown(input({
      key: "ArrowRight",
      nodeId: "next",
      imageEdge: "before"
    }))).toEqual({ kind: "focusImage", nodeId: "next" });
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

  // The box is the first thing Backspace takes off an empty checklist row; the
  // row itself only goes on the press after that.
  it("drops an empty Todo's box before it removes the row", () => {
    const checklist = [
      node("above", "page", "Above", 1_024),
      { ...node("task", "page", "", 2_048), marker: "todo" as const }
    ];
    const atStart = {
      key: "Backspace",
      nodeId: "task",
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      visibleNodes: checklist,
      structureNodes: checklist
    };

    expect(resolveOutlineKey(input(atStart)))
      .toEqual({ kind: "clearMarker" });
    // Once the box is gone the row is an ordinary empty bullet again.
    expect(resolveOutlineKey(input({
      ...atStart,
      visibleNodes: [checklist[0]!, node("task", "page", "", 2_048)],
      structureNodes: [checklist[0]!, node("task", "page", "", 2_048)]
    }))).toEqual({ kind: "removeEmpty", focusId: "above" });
    // A row with text keeps Backspace's ordinary meaning.
    expect(resolveOutlineKey(input({
      ...atStart,
      value: "Task"
    }))).not.toEqual({ kind: "clearMarker" });
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

  it("adds a sibling below the row on the sibling chord", () => {
    for (const platform of ["mac", "other"] as const) {
      const modifier = platform === "mac"
        ? { metaKey: true }
        : { ctrlKey: true };
      // Mid-text, and the row has a child. Neither matters: the row keeps its
      // text and its children, and the blank lands beside it.
      expect(resolveOutlineKey(input({
        key: "Enter",
        shiftKey: true,
        nodeId: "parent",
        value: "Parent",
        selectionStart: 3,
        selectionEnd: 3,
        platform,
        ...modifier
      }))).toEqual({
        kind: "createSibling",
        parentId: "page",
        beforeId: "next"
      });
    }
  });

  it("adds the sibling at the end of the siblings when the row is the last", () => {
    expect(resolveOutlineKey(input({
      key: "Enter",
      ctrlKey: true,
      shiftKey: true,
      nodeId: "next"
    }))).toEqual({
      kind: "createSibling",
      parentId: "page",
      beforeId: null
    });
  });

  it("holds the sibling chord to one row", () => {
    expect(resolveOutlineKey(input({
      key: "Enter",
      ctrlKey: true,
      shiftKey: true,
      repeat: true
    }))).toEqual({ kind: "consume" });
  });

  it("leaves the sibling chord to the rows, not the page title", () => {
    expect(resolveOutlineKey(input({
      key: "Enter",
      ctrlKey: true,
      shiftKey: true,
      target: "page",
      nodeId: "page"
    }))).toBeNull();
  });

  it("adds a sibling below an image row on the sibling chord", () => {
    expect(handleImageNodeKeyDown(input({
      key: "Enter",
      ctrlKey: true,
      shiftKey: true,
      nodeId: "shot",
      visibleNodes: [...visibleNodes, picture("shot", "page", 3_072)]
    }))).toEqual({
      kind: "createSibling",
      parentId: "page",
      beforeId: null
    });
  });

  it("holds the sibling chord to one row on a picture too", () => {
    const withPicture = [...visibleNodes, picture("shot", "page", 3_072)];
    expect(handleImageNodeKeyDown(input({
      key: "Enter",
      ctrlKey: true,
      shiftKey: true,
      nodeId: "shot",
      repeat: true,
      visibleNodes: withPicture
    }))).toEqual({ kind: "consume" });
    // A held plain Enter still stacks blanks off a picture, as it always has.
    expect(handleImageNodeKeyDown(input({
      key: "Enter",
      nodeId: "shot",
      repeat: true,
      visibleNodes: withPicture
    }))).toEqual({
      kind: "createSibling",
      parentId: "page",
      beforeId: null
    });
  });

  it("maps existing single-row shortcuts per platform", () => {
    expect(resolveOutlineKey(input({
      key: "Enter",
      ctrlKey: true
    }))).toEqual({ kind: "cycleComplete" });
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
