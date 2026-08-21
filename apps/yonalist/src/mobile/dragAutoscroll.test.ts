import { describe, expect, it } from "vitest";
import { autoscrollStep } from "./dragAutoscroll";

/** A scroller 600 tall, showing rows 0..600 of a 2000 tall list. */
const box = { top: 0, bottom: 600 };

describe("autoscrollStep", () => {
  it("stays still while the finger is anywhere in the middle", () => {
    expect(autoscrollStep(300, box)).toBe(0);
  });

  it("pulls the list down when the finger reaches the top edge", () => {
    expect(autoscrollStep(4, box)).toBeLessThan(0);
  });

  it("pushes it up at the bottom edge", () => {
    expect(autoscrollStep(596, box)).toBeGreaterThan(0);
  });

  it("moves faster the further into the edge the finger goes", () => {
    const shallow = autoscrollStep(560, box);
    const deep = autoscrollStep(598, box);

    expect(deep).toBeGreaterThan(shallow);
    expect(shallow).toBeGreaterThan(0);
  });

  it("keeps scrolling past the edge rather than giving up on the row it wants", () => {
    expect(autoscrollStep(-40, box)).toBeLessThan(0);
    expect(autoscrollStep(700, box)).toBeGreaterThan(0);
  });

  it("never asks for more than a step a frame can show", () => {
    expect(Math.abs(autoscrollStep(-4000, box))).toBeLessThanOrEqual(24);
    expect(Math.abs(autoscrollStep(4000, box))).toBeLessThanOrEqual(24);
  });
});
