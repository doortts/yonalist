import { beforeEach, describe, expect, it } from "vitest";
import {
  insertPlainTextAtSelection,
  readPlainText,
  readPlainTextSelection,
  replacePlainText,
  restorePlainTextSelection
} from "./plainTextContenteditable";

describe("plain-text contenteditable DOM utilities", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.contentEditable = "plaintext-only";
    document.body.replaceChildren(root);
    document.getSelection()?.removeAllRanges();
  });

  it("normalizes browser line and space nodes while dropping one WebKit trailing break", () => {
    root.innerHTML = "a&nbsp;b<br>c\u2028d\u2029e<br>";

    expect(readPlainText(root)).toBe("a b\nc\nd\ne");
  });

  it("restores and reads a backward UTF-16 selection across an astral character", () => {
    expect(
      replacePlainText(root, "A😀한글", {
        anchorUtf16: 5,
        focusUtf16: 1
      })
    ).toBe(true);

    const selection = document.getSelection()!;
    expect(selection.anchorOffset).toBe(5);
    expect(selection.focusOffset).toBe(1);
    expect(readPlainTextSelection(root)).toEqual({
      anchorUtf16: 5,
      focusUtf16: 1
    });
  });

  it("clamps restored endpoints to the current UTF-16 source length", () => {
    root.append("short");

    expect(
      restorePlainTextSelection(root, {
        anchorUtf16: 99,
        focusUtf16: -4
      })
    ).toBe(true);
    expect(readPlainTextSelection(root)).toEqual({
      anchorUtf16: 5,
      focusUtf16: 0
    });
  });

  it("returns null when the browser selection is outside the editor", () => {
    root.append("inside");
    const outside = document.createElement("div");
    outside.append("outside");
    document.body.append(outside);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(
      outside.firstChild!,
      0,
      outside.firstChild!,
      7
    );

    expect(readPlainTextSelection(root)).toBeNull();
  });

  it("inserts plain text at a collapsed caret and returns the next snapshot", () => {
    root.append("abcd");
    restorePlainTextSelection(root, { anchorUtf16: 2, focusUtf16: 2 });

    expect(insertPlainTextAtSelection(root, "<x>")).toEqual({
      source: "ab<x>cd",
      selection: { anchorUtf16: 5, focusUtf16: 5 }
    });
    expect(root.querySelector("*")).toBeNull();
  });

  it("replaces the selected range with one plain text node", () => {
    root.append("abcdef");
    restorePlainTextSelection(root, { anchorUtf16: 5, focusUtf16: 2 });

    expect(insertPlainTextAtSelection(root, "X")).toEqual({
      source: "abXf",
      selection: { anchorUtf16: 3, focusUtf16: 3 }
    });
    expect(root.textContent).toBe("abXf");
  });
});
