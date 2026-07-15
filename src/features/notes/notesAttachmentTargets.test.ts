import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentTargetFromPaste,
  attachmentTargetFromPoint
} from "./notesAttachmentTargets";

const elementFromPoint = vi.fn(
  (_x: number, _y: number): Element | null => null
);
const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint"
);

function appendTarget(
  parent: HTMLElement,
  noteId?: string,
  tagName = "div"
): HTMLElement {
  const target = document.createElement(tagName);
  if (noteId !== undefined) {
    target.dataset.notesAttachmentTarget = noteId;
  }
  parent.append(target);
  return target;
}

describe("notes attachment target resolution", () => {
  let root: HTMLElement;

  beforeAll(() => {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint
    });
  });

  beforeEach(() => {
    elementFromPoint.mockReset();
    elementFromPoint.mockReturnValue(null);
    root = document.createElement("section");
    document.body.replaceChildren(root);
  });

  afterAll(() => {
    if (originalElementFromPoint) {
      Object.defineProperty(
        document,
        "elementFromPoint",
        originalElementFromPoint
      );
    } else {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("returns the note id for a row hit inside the root", () => {
    const row = appendTarget(root, "row-note");
    elementFromPoint.mockReturnValue(row);

    expect(attachmentTargetFromPoint(root, { x: 120, y: 240 })).toBe(
      "row-note"
    );
    expect(elementFromPoint).toHaveBeenCalledWith(120, 240);
  });

  it("returns the note id for a zoomed page header", () => {
    const header = appendTarget(root, "zoomed-note", "header");
    elementFromPoint.mockReturnValue(header);

    expect(attachmentTargetFromPoint(root, { x: 24, y: 48 })).toBe(
      "zoomed-note"
    );
  });

  it("uses the closest attachment target for a nested control", () => {
    const row = appendTarget(root, "nested-note");
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    row.append(button);
    elementFromPoint.mockReturnValue(icon);

    expect(attachmentTargetFromPoint(root, { x: 16, y: 32 })).toBe(
      "nested-note"
    );
  });

  it("rejects a target outside the supplied root", () => {
    const outsideRoot = document.createElement("aside");
    document.body.append(outsideRoot);
    const outsideTarget = appendTarget(outsideRoot, "outside-note");
    elementFromPoint.mockReturnValue(outsideTarget);

    expect(attachmentTargetFromPoint(root, { x: 8, y: 12 })).toBeNull();
  });

  it("returns null when the hit test finds no element", () => {
    expect(attachmentTargetFromPoint(root, { x: 0, y: 0 })).toBeNull();
  });

  it("returns null when the hit has no attachment target dataset", () => {
    const rowWithoutTarget = appendTarget(root);
    elementFromPoint.mockReturnValue(rowWithoutTarget);

    expect(attachmentTargetFromPoint(root, { x: 20, y: 30 })).toBeNull();
  });

  it("falls back to the zoomed page for a targetless hit inside the outline", () => {
    const blankOutlineSurface = appendTarget(root);
    elementFromPoint.mockReturnValue(blankOutlineSurface);

    expect(
      attachmentTargetFromPoint(root, { x: 20, y: 30 }, "zoomed-page")
    ).toBe("zoomed-page");
  });

  it("does not use the zoomed-page fallback outside the outline", () => {
    const outsideRoot = document.createElement("aside");
    document.body.append(outsideRoot);
    elementFromPoint.mockReturnValue(outsideRoot);

    expect(
      attachmentTargetFromPoint(root, { x: 20, y: 30 }, "zoomed-page")
    ).toBeNull();
  });

  it.each(["", "   "])(
    "returns null for a malformed attachment target value %j",
    (noteId) => {
      const malformedTarget = appendTarget(root, noteId);
      elementFromPoint.mockReturnValue(malformedTarget);

      expect(attachmentTargetFromPoint(root, { x: 20, y: 30 })).toBeNull();
    }
  );

  it("prefers the closest paste target over the selected fallback", () => {
    const row = appendTarget(root, "row-note");
    const title = document.createElement("textarea");
    const titleText = document.createTextNode("Title");
    title.append(titleText);
    row.append(title);

    expect(
      attachmentTargetFromPaste(root, title, "selected-note")
    ).toBe("row-note");
    expect(
      attachmentTargetFromPaste(root, titleText, "selected-note")
    ).toBe("row-note");
  });

  it("falls back to a selected note for targetless or outside paste elements", () => {
    const targetless = document.createElement("textarea");
    root.append(targetless);
    const outsideRoot = document.createElement("aside");
    const outsideTarget = appendTarget(outsideRoot, "outside-note");
    document.body.append(outsideRoot);

    expect(
      attachmentTargetFromPaste(root, targetless, "selected-note")
    ).toBe("selected-note");
    expect(
      attachmentTargetFromPaste(root, outsideTarget, "selected-note")
    ).toBe("selected-note");
  });

  it("returns null when neither paste target nor selected fallback is valid", () => {
    const targetless = document.createElement("div");
    root.append(targetless);

    expect(attachmentTargetFromPaste(root, targetless, null)).toBeNull();
    expect(attachmentTargetFromPaste(root, targetless, "  ")).toBeNull();
  });
});
