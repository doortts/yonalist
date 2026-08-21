import {
  clampImageWidth,
  imageKeyboardResizeWidth
} from "./imageResize";

describe("image resize geometry", () => {
  it("clamps pointer widths to 120 and the current content width", () => {
    expect(clampImageWidth(80, 600)).toBe(120);
    expect(clampImageWidth(421.6, 600)).toBe(422);
    expect(clampImageWidth(900, 600)).toBe(600);
  });

  it("uses 10px keys and 50px shifted keys without committing policy", () => {
    expect(imageKeyboardResizeWidth(320, "ArrowLeft", false, 700)).toBe(310);
    expect(imageKeyboardResizeWidth(320, "ArrowRight", false, 700)).toBe(330);
    expect(imageKeyboardResizeWidth(320, "ArrowLeft", true, 700)).toBe(270);
    expect(imageKeyboardResizeWidth(680, "ArrowRight", true, 700)).toBe(700);
  });
});
