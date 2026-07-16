import { describe, expect, it } from "vitest";
import {
  defaultPaneWidths,
  getEffectivePaneGeometry,
  paneWidthLimits
} from "./usePaneResize";

const expanded = { sidebar: false, list: false };
const requestedMax = {
  sidebar: paneWidthLimits.sidebar.max,
  list: paneWidthLimits.list.max
};

describe("getEffectivePaneGeometry", () => {
  it("keeps requested widths when the desktop has room or panes stack", () => {
    expect(getEffectivePaneGeometry(defaultPaneWidths, 1440, expanded).widths)
      .toEqual(defaultPaneWidths);
    expect(getEffectivePaneGeometry(requestedMax, 980, expanded)).toEqual({
      widths: requestedMax,
      maxWidths: requestedMax
    });
  });

  it("reserves a usable desktop detail pane and reports reachable maxima", () => {
    expect(getEffectivePaneGeometry(requestedMax, 981, expanded)).toEqual({
      widths: { sidebar: 323, list: 320 },
      maxWidths: { sidebar: 323, list: 320 }
    });
    expect(getEffectivePaneGeometry(requestedMax, 1280, expanded)).toEqual({
      widths: { sidebar: 420, list: 522 },
      maxWidths: { sidebar: 420, list: 522 }
    });
  });

  it("zeros collapsed tracks without discarding the requested widths", () => {
    expect(
      getEffectivePaneGeometry(requestedMax, 981, {
        sidebar: true,
        list: false
      })
    ).toEqual({
      widths: { sidebar: 0, list: 640 },
      maxWidths: { sidebar: 0, list: 640 }
    });
    expect(
      getEffectivePaneGeometry(requestedMax, 981, {
        sidebar: false,
        list: true
      }).widths
    ).toEqual({ sidebar: 420, list: 0 });
    expect(
      getEffectivePaneGeometry(requestedMax, 981, {
        sidebar: true,
        list: true
      }).widths
    ).toEqual({ sidebar: 0, list: 0 });
    expect(getEffectivePaneGeometry(requestedMax, 981, expanded).widths)
      .toEqual({ sidebar: 323, list: 320 });
  });
});
