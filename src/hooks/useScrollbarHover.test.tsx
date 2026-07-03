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
});
