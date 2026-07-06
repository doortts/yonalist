import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollbarHover } from "./useScrollbarHover";

function ScrollbarHarness() {
  useScrollbarHover();
  return (
    <div
      data-testid="pane"
      style={{ height: "120px", overflowY: "auto" }}
    >
      <div style={{ height: "400px" }}>Scrollable pane</div>
    </div>
  );
}

function makeScrollable(element: HTMLElement) {
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: 120
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 400
  });
}

describe("useScrollbarHover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a pane scrollbar visible while the pane is scrolling", () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<ScrollbarHarness />);
    const pane = getByTestId("pane");
    makeScrollable(pane);

    fireEvent.scroll(pane);

    expect(pane).toHaveClass("scrollbar-active");

    vi.advanceTimersByTime(900);

    expect(pane).not.toHaveClass("scrollbar-active");
  });

  it("stores overlay scrollbar metrics without using the native gutter", () => {
    const { getByTestId } = render(<ScrollbarHarness />);
    const pane = getByTestId("pane");
    makeScrollable(pane);
    Object.defineProperty(pane, "scrollTop", {
      configurable: true,
      value: 140
    });

    fireEvent.scroll(pane);

    expect(pane).toHaveClass("scrollbar-overlay");
    expect(pane.style.getPropertyValue("--scrollbar-overlay-height")).toBe("36px");
    expect(pane.style.getPropertyValue("--scrollbar-overlay-top")).toBe("182px");
  });

  it("treats overlay overflow panes as scrollable", () => {
    const { getByTestId } = render(<ScrollbarHarness />);
    const pane = getByTestId("pane");
    makeScrollable(pane);

    const getComputedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element === pane) {
        return { overflowY: "overlay" } as CSSStyleDeclaration;
      }
      return getComputedStyle(element);
    });

    fireEvent.pointerOver(pane);

    expect(pane).toHaveClass("scrollbar-hover");
  });
});
