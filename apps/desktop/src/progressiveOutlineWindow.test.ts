import {
  advanceOutlineWindow,
  describeOutlineWindow,
  initialOutlineWindowCount,
  materializeOutlineThrough
} from "./progressiveOutlineWindow";
import { measuredOutlineRowHeight } from "./progressiveOutlineObservers";

describe("progressive outline window policy", () => {
  it("bounds the initial DOM and represents the loaded tail with height", () => {
    expect(initialOutlineWindowCount(140)).toBe(60);
    expect(describeOutlineWindow(60, 140, 28)).toEqual({
      renderedCount: 60,
      remainingCount: 80,
      spacerHeight: 2_240
    });
  });

  it("grows by one batch without evicting the mounted prefix", () => {
    expect(advanceOutlineWindow(60, 140)).toBe(120);
    expect(advanceOutlineWindow(120, 140)).toBe(140);
    expect(advanceOutlineWindow(140, 140)).toBe(140);
  });

  it("rounds a hidden focus target through its containing batch", () => {
    expect(materializeOutlineThrough(60, 119, 140)).toBe(120);
    expect(materializeOutlineThrough(60, 120, 140)).toBe(140);
    expect(materializeOutlineThrough(120, 20, 140)).toBe(120);
  });

  it("bounds measured row-height refinement for variable content", () => {
    expect(measuredOutlineRowHeight(2_100, 60)).toBe(35);
    expect(measuredOutlineRowHeight(300, 60)).toBe(20);
    expect(measuredOutlineRowHeight(30_000, 60)).toBe(240);
  });
});
