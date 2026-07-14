import { describe, expect, it } from "vitest";
import {
  resolveInlineFormatShortcut,
  toggleInlineFormat
} from "./inlineFormat";

describe("toggleInlineFormat", () => {
  it("wraps a selection and tracks the original content", () => {
    expect(toggleInlineFormat("hello world", 6, 11, "strong")).toEqual({
      value: "hello **world**",
      selectionStart: 8,
      selectionEnd: 13
    });
  });

  it("unwraps when the selection captures its own markers", () => {
    expect(toggleInlineFormat("**bold**", 0, 8, "strong")).toEqual({
      value: "bold",
      selectionStart: 0,
      selectionEnd: 4
    });
  });

  it("unwraps when the markers sit immediately outside the selection", () => {
    expect(toggleInlineFormat("hello **world**", 8, 13, "strong")).toEqual({
      value: "hello world",
      selectionStart: 6,
      selectionEnd: 11
    });
  });

  it("inserts an empty pair at a collapsed caret", () => {
    expect(toggleInlineFormat("hi ", 3, 3, "strong")).toEqual({
      value: "hi ****",
      selectionStart: 5,
      selectionEnd: 5
    });
  });

  it("removes an empty pair the caret sits inside", () => {
    expect(toggleInlineFormat("hi ****", 5, 5, "strong")).toEqual({
      value: "hi ",
      selectionStart: 3,
      selectionEnd: 3
    });
  });

  it.each([
    ["em", "*"],
    ["strike", "~~"],
    ["code", "`"]
  ] as const)("wraps and unwraps %s with its own marker", (kind, marker) => {
    const wrapped = toggleInlineFormat("word", 0, 4, kind);
    expect(wrapped.value).toBe(`${marker}word${marker}`);

    const unwrapped = toggleInlineFormat(
      wrapped.value,
      wrapped.selectionStart,
      wrapped.selectionEnd,
      kind
    );
    expect(unwrapped.value).toBe("word");
  });

  it("nests italic inside bold instead of eating the bold markers", () => {
    // A `*` toggle must never strip one `*` from an enclosing `**`. Both the
    // whole-span selection and the inner-content selection nest to bold+italic.
    expect(toggleInlineFormat("**bold**", 0, 8, "em").value).toBe(
      "***bold***"
    );
    expect(toggleInlineFormat("**bold**", 2, 6, "em").value).toBe(
      "***bold***"
    );
  });
});

describe("resolveInlineFormatShortcut", () => {
  const base = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false
  };

  it("maps the primary-modifier chords to their kinds", () => {
    expect(resolveInlineFormatShortcut({ ...base, metaKey: true, key: "b" })).toBe(
      "strong"
    );
    expect(resolveInlineFormatShortcut({ ...base, ctrlKey: true, key: "I" })).toBe(
      "em"
    );
    expect(
      resolveInlineFormatShortcut({
        ...base,
        metaKey: true,
        shiftKey: true,
        key: "x"
      })
    ).toBe("strike");
  });

  it("ignores chords without the primary modifier, with Alt, or unmatched keys", () => {
    expect(resolveInlineFormatShortcut({ ...base, key: "b" })).toBeNull();
    expect(
      resolveInlineFormatShortcut({ ...base, metaKey: true, altKey: true, key: "b" })
    ).toBeNull();
    expect(
      resolveInlineFormatShortcut({ ...base, metaKey: true, shiftKey: true, key: "b" })
    ).toBeNull();
    expect(resolveInlineFormatShortcut({ ...base, metaKey: true, key: "u" })).toBeNull();
  });
});
