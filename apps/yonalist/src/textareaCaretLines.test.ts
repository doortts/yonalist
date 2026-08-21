import {
  classifyCaretLines,
  measureTextareaCaretLines
} from "./textareaCaretLines";

describe("textarea caret visual-line measurement", () => {
  it("classifies first, middle, last, and single-line caret positions", () => {
    expect(classifyCaretLines(8, 8, 48)).toEqual({
      first: true,
      last: false
    });
    expect(classifyCaretLines(28, 8, 48)).toEqual({
      first: false,
      last: false
    });
    expect(classifyCaretLines(48, 8, 48)).toEqual({
      first: false,
      last: true
    });
    expect(classifyCaretLines(8, 8, 8)).toEqual({
      first: true,
      last: true
    });
  });

  it("treats a title without explicit line breaks as one visual line when layout is unavailable", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "wrapped title";
    textarea.setSelectionRange(4, 4);

    expect(measureTextareaCaretLines(textarea)).toEqual({
      first: true,
      last: true
    });
  });

  it("uses explicit line breaks for the no-layout fallback", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "first\nmiddle\nlast";
    textarea.setSelectionRange(8, 8);

    expect(measureTextareaCaretLines(textarea)).toEqual({
      first: false,
      last: false
    });
  });
});
