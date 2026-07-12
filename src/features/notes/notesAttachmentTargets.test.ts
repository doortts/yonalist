import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentTargetFromPoint } from "./notesAttachmentTargets";

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

describe("attachmentTargetFromPoint", () => {
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

  it.each(["", "   "])(
    "returns null for a malformed attachment target value %j",
    (noteId) => {
      const malformedTarget = appendTarget(root, noteId);
      elementFromPoint.mockReturnValue(malformedTarget);

      expect(attachmentTargetFromPoint(root, { x: 20, y: 30 })).toBeNull();
    }
  );
});
