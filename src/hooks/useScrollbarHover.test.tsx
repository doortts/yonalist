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

function setBoundingRect(
  element: HTMLElement,
  rect: Partial<DOMRect> & { top: number; right: number }
) {
  const full: DOMRect = {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom ?? rect.top + 120,
    left: rect.left ?? rect.right - 500,
    width: rect.width ?? 500,
    height: rect.height ?? 120,
    x: rect.x ?? rect.left ?? rect.right - 500,
    y: rect.y ?? rect.top,
    toJSON: () => ""
  };
  element.getBoundingClientRect = () => full;
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

  it("positions the overlay thumb in viewport coordinates, not scroll offset", () => {
    const { getByTestId } = render(<ScrollbarHarness />);
    const pane = getByTestId("pane");
    makeScrollable(pane);
    // The scroll container sits 100px down the viewport with its right edge at 500.
    setBoundingRect(pane, { top: 100, right: 500 });
    Object.defineProperty(pane, "scrollTop", {
      configurable: true,
      value: 140
    });

    fireEvent.scroll(pane);

    expect(pane).toHaveClass("scrollbar-overlay");
    // thumbHeight = round((120 / 400) * 120) = 36
    expect(pane.style.getPropertyValue("--scrollbar-overlay-height")).toBe("36px");
    // thumbViewportTop = (140 / 280) * (120 - 36) = 42
    // viewport top = rect.top + thumbViewportTop = 100 + 42 = 142
    // (the old, buggy formula added scrollTop and would yield 182)
    expect(pane.style.getPropertyValue("--scrollbar-overlay-top")).toBe("142px");
    // left = rect.right - 4px inset - 6px width = 500 - 10 = 490
    expect(pane.style.getPropertyValue("--scrollbar-overlay-left")).toBe("490px");
  });

  it("recomputes overlay position on window resize", () => {
    const { getByTestId } = render(<ScrollbarHarness />);
    const pane = getByTestId("pane");
    makeScrollable(pane);
    setBoundingRect(pane, { top: 100, right: 500 });
    Object.defineProperty(pane, "scrollTop", {
      configurable: true,
      value: 0
    });

    fireEvent.scroll(pane);
    expect(pane.style.getPropertyValue("--scrollbar-overlay-top")).toBe("100px");

    // The pane moved/resized: its viewport rect changed but no scroll happened.
    setBoundingRect(pane, { top: 60, right: 420 });
    fireEvent(window, new Event("resize"));

    expect(pane.style.getPropertyValue("--scrollbar-overlay-top")).toBe("60px");
    expect(pane.style.getPropertyValue("--scrollbar-overlay-left")).toBe("410px");
  });

  it("clears stale overlay artifacts when a pane stops being scrollable", () => {
    const { getByTestId } = render(<ScrollbarHarness />);
    const pane = getByTestId("pane");
    makeScrollable(pane);
    setBoundingRect(pane, { top: 100, right: 500 });

    fireEvent.scroll(pane);
    expect(pane).toHaveClass("scrollbar-overlay");
    expect(pane.style.getPropertyValue("--scrollbar-overlay-height")).toBe("36px");

    // Content shrinks so the pane no longer overflows.
    Object.defineProperty(pane, "scrollHeight", {
      configurable: true,
      value: 120
    });
    fireEvent(window, new Event("resize"));

    expect(pane).not.toHaveClass("scrollbar-overlay");
    expect(pane.style.getPropertyValue("--scrollbar-overlay-height")).toBe("");
    expect(pane.style.getPropertyValue("--scrollbar-overlay-top")).toBe("");
    expect(pane.style.getPropertyValue("--scrollbar-overlay-left")).toBe("");
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
