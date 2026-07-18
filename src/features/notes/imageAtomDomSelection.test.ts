import { afterEach, describe, expect, it } from "vitest";
import {
  IMAGE_ATOM_CARET_AID_ATTRIBUTE,
  IMAGE_ATOM_OVERLAY_ATTRIBUTE,
  readImageAtomDomSelection,
  writeImageAtomDomSelection,
  type ImageAtomDomRegions
} from "./imageAtomDomSelection";

type Fixture = ImageAtomDomRegions & {
  readonly selection: Selection;
};

function fixture(): Fixture {
  const host = document.createElement("div");
  const before = document.createElement("span");
  const atom = document.createElement("span");
  const after = document.createElement("span");
  host.append(before, atom, after);
  document.body.append(host);
  const selection = document.getSelection();
  if (!selection) throw new Error("JSDOM did not expose a Selection.");
  selection.removeAllRanges();
  return { host, before, atom, after, selection };
}

function select(
  selection: Selection,
  anchorNode: Node,
  anchorOffset: number,
  focusNode: Node,
  focusOffset: number
): void {
  selection.removeAllRanges();
  selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}

function text(parent: Node, value: string): Text {
  const valueNode = document.createTextNode(value);
  parent.appendChild(valueNode);
  return valueNode;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("image atom DOM selections", () => {
  it("maps an empty-region host range to the logical atom", () => {
    const regions = fixture();

    select(regions.selection, regions.host, 1, regions.host, 2);

    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 0,
      focusUtf16: 1
    });
  });

  it("walks nested text descendants from before through after", () => {
    const regions = fixture();
    const beforeStart = text(regions.before, "a");
    const beforeNested = document.createElement("strong");
    const beforeNestedText = text(beforeNested, "bc");
    regions.before.append(beforeNested);
    const afterStart = text(regions.after, "d");
    const afterNested = document.createElement("em");
    const afterNestedText = text(afterNested, "ef");
    regions.after.append(afterNested);

    select(regions.selection, beforeNestedText, 1, afterNestedText, 1);

    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: beforeStart.data.length + 1,
      focusUtf16: 3 + 1 + afterStart.data.length + 1
    });
  });

  it("maps atom descendants to ordered atom edges without reading their text", () => {
    const regions = fixture();
    text(regions.before, "before");
    const controls = document.createElement("span");
    const controlText = text(controls, "image controls are not title text");
    const image = document.createElement("img");
    regions.atom.append(image, controls);
    const afterText = text(regions.after, "after");

    select(regions.selection, controlText, 3, afterText, 0);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 6,
      focusUtf16: 7
    });

    select(regions.selection, afterText, 0, image, 0);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 7,
      focusUtf16: 6
    });
  });

  it("preserves a reverse DOM range", () => {
    const regions = fixture();
    const beforeText = text(regions.before, "ab");
    const afterText = text(regions.after, "cd");

    select(regions.selection, afterText, 1, beforeText, 1);

    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 4,
      focusUtf16: 1
    });
  });

  it("uses the exact caret-aid and overlay markers without treating their text as data", () => {
    const regions = fixture();
    text(regions.before, "a");
    const caretAid = document.createElement("span");
    caretAid.setAttribute(IMAGE_ATOM_CARET_AID_ATTRIBUTE, "");
    caretAid.setAttribute("aria-hidden", "true");
    const caretAidText = text(caretAid, "\u200b");
    const overlay = document.createElement("span");
    overlay.setAttribute(IMAGE_ATOM_OVERLAY_ATTRIBUTE, "");
    overlay.className = "notes-token-text";
    const overlayText = text(overlay, "token overlay");
    const beforeEnd = text(regions.before, "b");
    regions.before.append(caretAid, overlay, beforeEnd);

    select(regions.selection, caretAidText, 1, overlayText, overlayText.length);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 1,
      focusUtf16: 1
    });

    writeImageAtomDomSelection(
      regions,
      { anchorUtf16: 0, focusUtf16: 2 },
      regions.selection
    );
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 0,
      focusUtf16: 2
    });
    expect(caretAid.contains(regions.selection.anchorNode)).toBe(false);
    expect(overlay.contains(regions.selection.focusNode)).toBe(false);
  });

  it("writes fresh DOM points after a region rerender", () => {
    const regions = fixture();
    const staleBeforeText = text(regions.before, "old");
    text(regions.after, "after");
    select(regions.selection, staleBeforeText, 2, staleBeforeText, 2);
    const freshBeforeText = document.createTextNode("new");
    regions.before.replaceChildren(freshBeforeText);

    writeImageAtomDomSelection(
      regions,
      { anchorUtf16: 2, focusUtf16: 2 },
      regions.selection
    );

    expect(regions.selection.anchorNode).toBe(freshBeforeText);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 2,
      focusUtf16: 2
    });
  });

  it("snaps surrogate-pair interiors to the lower nearest UTF-16 boundary", () => {
    const regions = fixture();
    const beforeText = text(regions.before, "A😀B");

    select(regions.selection, beforeText, 2, beforeText, 2);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 1,
      focusUtf16: 1
    });

    writeImageAtomDomSelection(
      regions,
      { anchorUtf16: 2, focusUtf16: 2 },
      regions.selection
    );
    expect(regions.selection.anchorNode).toBe(beforeText);
    expect(regions.selection.anchorOffset).toBe(1);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 1,
      focusUtf16: 1
    });
  });

  it("normalizes host siblings and external endpoints but ignores unrelated selections", () => {
    const regions = fixture();
    const beforeText = text(regions.before, "a");
    const unexpected = document.createElement("span");
    const unexpectedText = text(unexpected, "unexpected");
    regions.host.insertBefore(unexpected, regions.atom);
    const afterText = text(regions.after, "b");
    const beforeHost = document.createElement("span");
    const beforeHostText = text(beforeHost, "outside before");
    const afterHost = document.createElement("span");
    const afterHostText = text(afterHost, "outside after");
    document.body.prepend(beforeHost);
    document.body.append(afterHost);

    select(regions.selection, unexpectedText, 3, afterText, 0);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: beforeText.length,
      focusUtf16: beforeText.length + 1
    });

    select(regions.selection, beforeHostText, 0, afterText, 1);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 0,
      focusUtf16: 3
    });

    select(regions.selection, beforeHostText, 0, afterHostText, afterHostText.length);
    expect(readImageAtomDomSelection(regions, regions.selection)).toBeNull();
  });

  it("writes forward and reverse selections with their anchor/focus direction", () => {
    const regions = fixture();
    text(regions.before, "ab");
    text(regions.after, "cd");

    writeImageAtomDomSelection(
      regions,
      { anchorUtf16: 1, focusUtf16: 4 },
      regions.selection
    );
    expect(regions.selection.anchorOffset).toBe(1);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 1,
      focusUtf16: 4
    });

    writeImageAtomDomSelection(
      regions,
      { anchorUtf16: 4, focusUtf16: 1 },
      regions.selection
    );
    expect(regions.selection.anchorOffset).toBe(1);
    expect(readImageAtomDomSelection(regions, regions.selection)).toEqual({
      anchorUtf16: 4,
      focusUtf16: 1
    });
  });

  it.each(["missing", "throwing"] as const)(
    "falls back to an ordered Range when setBaseAndExtent is %s",
    (mode) => {
      const regions = fixture();
      text(regions.before, "ab");
      text(regions.after, "cd");
      const selection = regions.selection as Selection & {
        setBaseAndExtent?: Selection["setBaseAndExtent"];
      };

      Object.defineProperty(selection, "setBaseAndExtent", {
        configurable: true,
        value:
          mode === "missing"
            ? undefined
            : () => {
                throw new Error("unsupported");
              }
      });
      try {
        writeImageAtomDomSelection(
          regions,
          { anchorUtf16: 4, focusUtf16: 1 },
          selection
        );
      } finally {
        Reflect.deleteProperty(selection, "setBaseAndExtent");
      }

      expect(readImageAtomDomSelection(regions, selection)).toEqual({
        anchorUtf16: 1,
        focusUtf16: 4
      });
    }
  );
});
