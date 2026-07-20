import { describe, expect, it } from "vitest";
import {
  applyImageLogicalTextEdit,
  imageLogicalLength,
  joinImagePrimary,
  logicalToRawOffset,
  normalizeLogicalSelection,
  selectedImageAtomFragment,
  validateImagePrimary,
  type ImagePrimaryValue
} from "./imageAtomModel";

function image(
  title: string,
  imageOffsetUtf16: number
): ImagePrimaryValue {
  return { title, imageOffsetUtf16 };
}

describe("image atom primary values", () => {
  it("splits and rejoins empty and non-empty text sides", () => {
    expect(validateImagePrimary(image("after", 0))).toEqual({
      beforeText: "",
      afterText: "after"
    });
    expect(validateImagePrimary(image("before", 6))).toEqual({
      beforeText: "before",
      afterText: ""
    });
    expect(validateImagePrimary(image("beforeafter", 6))).toEqual({
      beforeText: "before",
      afterText: "after"
    });
    expect(joinImagePrimary({ beforeText: "before", afterText: "after" })).toEqual(
      image("beforeafter", 6)
    );
  });

  it("counts the image as one logical UTF-16 unit", () => {
    expect(imageLogicalLength(image("A😀B", 3))).toBe(5);
  });

  it("rejects malformed image offsets before slicing", () => {
    expect(() => validateImagePrimary(image("title", -1))).toThrow(RangeError);
    expect(() => validateImagePrimary(image("title", 1.5))).toThrow(RangeError);
    expect(() => validateImagePrimary(image("title", 6))).toThrow(RangeError);
    expect(() => validateImagePrimary(image("A😀B", 2))).toThrow(RangeError);
    expect(() =>
      joinImagePrimary({ beforeText: "\ud83d", afterText: "\ude00" })
    ).toThrow(RangeError);
  });

  it.each([
    ["array", ["title"]],
    ["number", 42]
  ])("rejects a non-primitive %s title", (_name, title) => {
    expect(() =>
      validateImagePrimary(image(title as unknown as string, 0))
    ).toThrow(new TypeError("Title must be a string."));
  });

  it("rejects non-primitive text segments before joining", () => {
    expect(() =>
      joinImagePrimary({
        beforeText: ["before"] as unknown as string,
        afterText: "after"
      })
    ).toThrow(new TypeError("Before text must be a string."));
    expect(() =>
      joinImagePrimary({
        beforeText: "before",
        afterText: 42 as unknown as string
      })
    ).toThrow(new TypeError("After text must be a string."));
  });
});

describe("logical image atom offsets", () => {
  const value = image("abc", 1);

  it("clamps selections without losing forward or reverse direction", () => {
    expect(
      normalizeLogicalSelection(value, { anchorUtf16: -4, focusUtf16: 99 })
    ).toEqual({ anchorUtf16: 0, focusUtf16: 4 });
    expect(
      normalizeLogicalSelection(value, { anchorUtf16: 3, focusUtf16: 0 })
    ).toEqual({ anchorUtf16: 3, focusUtf16: 0 });
  });

  it("maps both atom-adjacent carets to the shared raw boundary", () => {
    expect(logicalToRawOffset(value, 1, "before")).toBe(1);
    expect(logicalToRawOffset(value, 2, "after")).toBe(1);
    expect(logicalToRawOffset(value, 3, "after")).toBe(2);
  });

  it("rejects surrogate-pair interiors before and after the atom", () => {
    const emojiBeforeAtom = image("A😀B", 3);
    expect(() =>
      normalizeLogicalSelection(emojiBeforeAtom, { anchorUtf16: 2, focusUtf16: 2 })
    ).toThrow(RangeError);
    expect(() => logicalToRawOffset(emojiBeforeAtom, 2, "before")).toThrow(RangeError);

    const emojiAfterAtom = image("A😀B", 1);
    expect(() =>
      normalizeLogicalSelection(emojiAfterAtom, { anchorUtf16: 3, focusUtf16: 3 })
    ).toThrow(RangeError);
    expect(() => logicalToRawOffset(emojiAfterAtom, 3, "after")).toThrow(RangeError);
  });

  it("permits combining-mark interiors", () => {
    const combining = image("e\u0301f", 1);
    expect(validateImagePrimary(combining)).toEqual({
      beforeText: "e",
      afterText: "\u0301f"
    });
    expect(
      normalizeLogicalSelection(combining, { anchorUtf16: 1, focusUtf16: 1 })
    ).toEqual({ anchorUtf16: 1, focusUtf16: 1 });
  });
});

describe("selectedImageAtomFragment", () => {
  it.each([
    {
      name: "returns an exact atom selection",
      value: image("beforeafter", 6),
      selection: { anchorUtf16: 6, focusUtf16: 7 },
      expected: {
        beforeText: "",
        afterText: "",
        selection: { anchorUtf16: 6, focusUtf16: 7 }
      }
    },
    {
      name: "returns text before through the atom",
      value: image("beforeafter", 6),
      selection: { anchorUtf16: 3, focusUtf16: 7 },
      expected: {
        beforeText: "ore",
        afterText: "",
        selection: { anchorUtf16: 3, focusUtf16: 7 }
      }
    },
    {
      name: "returns the atom through text after it",
      value: image("beforeafter", 6),
      selection: { anchorUtf16: 6, focusUtf16: 10 },
      expected: {
        beforeText: "",
        afterText: "aft",
        selection: { anchorUtf16: 6, focusUtf16: 10 }
      }
    },
    {
      name: "returns a whole mixed forward selection",
      value: image("beforeafter", 6),
      selection: { anchorUtf16: 3, focusUtf16: 10 },
      expected: {
        beforeText: "ore",
        afterText: "aft",
        selection: { anchorUtf16: 3, focusUtf16: 10 }
      }
    },
    {
      name: "preserves reverse direction for a mixed selection",
      value: image("beforeafter", 6),
      selection: { anchorUtf16: 10, focusUtf16: 3 },
      expected: {
        beforeText: "ore",
        afterText: "aft",
        selection: { anchorUtf16: 10, focusUtf16: 3 }
      }
    },
    {
      name: "does not return a text-only selection",
      value: image("beforeafter", 6),
      selection: { anchorUtf16: 0, focusUtf16: 3 },
      expected: null
    },
    {
      name: "does not return a collapsed atom-adjacent selection",
      value: image("beforeafter", 6),
      selection: { anchorUtf16: 6, focusUtf16: 6 },
      expected: null
    },
    {
      name: "preserves a surrogate pair immediately before the atom",
      value: image("A😀B", 3),
      selection: { anchorUtf16: 1, focusUtf16: 4 },
      expected: {
        beforeText: "😀",
        afterText: "",
        selection: { anchorUtf16: 1, focusUtf16: 4 }
      }
    }
  ])("$name", ({ value, selection, expected }) => {
    expect(selectedImageAtomFragment(value, selection)).toEqual(expected);
  });
});

describe("applyImageLogicalTextEdit", () => {
  it.each([
    {
      name: "inserts before the atom from its before caret",
      value: image("ab", 1),
      selection: { anchorUtf16: 1, focusUtf16: 1 },
      replacement: "X",
      expected: {
        value: image("aXb", 2),
        selection: { anchorUtf16: 2, focusUtf16: 2 },
        removesAtom: false
      }
    },
    {
      name: "inserts after the atom from its after caret",
      value: image("ab", 1),
      selection: { anchorUtf16: 2, focusUtf16: 2 },
      replacement: "X",
      expected: {
        value: image("aXb", 1),
        selection: { anchorUtf16: 3, focusUtf16: 3 },
        removesAtom: false
      }
    },
    {
      name: "counts a surrogate-pair replacement in UTF-16 units",
      value: image("ab", 1),
      selection: { anchorUtf16: 1, focusUtf16: 1 },
      replacement: "😀",
      expected: {
        value: image("a😀b", 3),
        selection: { anchorUtf16: 3, focusUtf16: 3 },
        removesAtom: false
      }
    },
    {
      name: "deletes a forward range entirely before the atom",
      value: image("abcd", 2),
      selection: { anchorUtf16: 0, focusUtf16: 2 },
      replacement: "",
      expected: {
        value: image("cd", 0),
        selection: { anchorUtf16: 0, focusUtf16: 0 },
        removesAtom: false
      }
    },
    {
      name: "deletes a reverse range entirely after the atom",
      value: image("abcd", 2),
      selection: { anchorUtf16: 5, focusUtf16: 3 },
      replacement: "",
      expected: {
        value: image("ab", 2),
        selection: { anchorUtf16: 3, focusUtf16: 3 },
        removesAtom: false
      }
    },
    {
      name: "removes an atom-only range",
      value: image("ab", 1),
      selection: { anchorUtf16: 1, focusUtf16: 2 },
      replacement: "",
      expected: {
        value: image("ab", 0),
        selection: { anchorUtf16: 1, focusUtf16: 1 },
        removesAtom: true
      }
    },
    {
      name: "removes a mixed range from before through the atom",
      value: image("abc", 1),
      selection: { anchorUtf16: 0, focusUtf16: 2 },
      replacement: "",
      expected: {
        value: image("bc", 0),
        selection: { anchorUtf16: 0, focusUtf16: 0 },
        removesAtom: true
      }
    },
    {
      name: "replaces a reverse mixed range from the atom through after text",
      value: image("abc", 1),
      selection: { anchorUtf16: 4, focusUtf16: 1 },
      replacement: "X",
      expected: {
        value: image("aX", 0),
        selection: { anchorUtf16: 2, focusUtf16: 2 },
        removesAtom: true
      }
    },
    {
      name: "clamps a whole logical range before replacing across the atom",
      value: image("ab", 1),
      selection: { anchorUtf16: -2, focusUtf16: 99 },
      replacement: "X",
      expected: {
        value: image("X", 0),
        selection: { anchorUtf16: 1, focusUtf16: 1 },
        removesAtom: true
      }
    },
    {
      name: "edits at a combining-mark interior caret",
      value: image("e\u0301f", 1),
      selection: { anchorUtf16: 1, focusUtf16: 1 },
      replacement: "X",
      expected: {
        value: image("eX\u0301f", 2),
        selection: { anchorUtf16: 2, focusUtf16: 2 },
        removesAtom: false
      }
    },
    {
      name: "preserves an emoji before the atom without splitting it",
      value: image("A😀B", 3),
      selection: { anchorUtf16: 3, focusUtf16: 3 },
      replacement: "X",
      expected: {
        value: image("A😀XB", 4),
        selection: { anchorUtf16: 4, focusUtf16: 4 },
        removesAtom: false
      }
    }
  ])("$name", ({ value, selection, replacement, expected }) => {
    expect(applyImageLogicalTextEdit(value, selection, replacement)).toEqual(expected);
  });

  it("rejects an edit selection that would split a surrogate pair", () => {
    expect(() =>
      applyImageLogicalTextEdit(
        image("A😀B", 3),
        { anchorUtf16: 2, focusUtf16: 3 },
        ""
      )
    ).toThrow(RangeError);
  });

  it("rejects atom removal when its splice leaves the caret inside a new pair", () => {
    expect(() =>
      applyImageLogicalTextEdit(
        image("\ud83da\ude00", 1),
        { anchorUtf16: 1, focusUtf16: 3 },
        ""
      )
    ).toThrow(RangeError);
  });

  it("rejects a text-only splice when its returned caret splits a new pair", () => {
    expect(() =>
      applyImageLogicalTextEdit(
        image("\ud83da\ude00", 3),
        { anchorUtf16: 1, focusUtf16: 2 },
        ""
      )
    ).toThrow(RangeError);
  });

  it.each([
    ["array", ["replacement"]],
    ["number", 42]
  ])("rejects a non-primitive %s replacement", (_name, replacement) => {
    expect(() =>
      applyImageLogicalTextEdit(
        image("ab", 1),
        { anchorUtf16: 1, focusUtf16: 1 },
        replacement as unknown as string
      )
    ).toThrow(new TypeError("Replacement must be a string."));
  });
});
