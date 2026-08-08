import type { ImageView } from "../../../../packages/contracts/generated/ImageView";

import { imageZoneSize } from "./imageZones";

function image(overrides: Partial<ImageView> = {}): ImageView {
  return {
    contentHash: "hash",
    originalName: "shot.png",
    mimeType: "image/png",
    byteLength: 1_024,
    pixelWidth: 800,
    pixelHeight: 400,
    displayWidth: 800,
    ...overrides
  };
}

describe("image zone size", () => {
  it("keeps a small image at its own pixels instead of upscaling", () => {
    expect(imageZoneSize(
      image({ pixelWidth: 40, pixelHeight: 20, displayWidth: 40 }),
      900
    )).toEqual({ width: 40, height: 20 });
  });

  it("clamps a stored display width to the original and the content width", () => {
    expect(imageZoneSize(image({ displayWidth: 2_000 }), 900).width).toBe(800);
    expect(imageZoneSize(image({ displayWidth: 600 }), 900).width).toBe(600);
    expect(imageZoneSize(image({ displayWidth: 600 }), 320).width).toBe(320);
  });

  it("derives the height from the original aspect ratio", () => {
    expect(imageZoneSize(image({ displayWidth: 400 }), 900)).toEqual({
      width: 400,
      height: 200
    });
  });

  it("falls back to the original width when measurements are missing", () => {
    expect(imageZoneSize(image({ displayWidth: 0 }), 0)).toEqual({
      width: 800,
      height: 400
    });
    expect(imageZoneSize(
      image({ pixelWidth: 0, pixelHeight: 0, displayWidth: 0 }),
      900
    )).toEqual({ width: 0, height: 0 });
  });
});
