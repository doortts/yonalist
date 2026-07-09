import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDetailDisplayTiming } from "./useDetailDisplayTiming";

function Harness({
  activeDetailKey,
  detailReady
}: {
  activeDetailKey: string | null;
  detailReady: boolean;
}) {
  const timing = useDetailDisplayTiming(activeDetailKey, detailReady);
  return (
    <>
      <button type="button" onClick={() => timing.startDetailTransition(100)}>
        start
      </button>
      <output aria-label="duration">
        {timing.detailDisplayDurationMs === null
          ? "--"
          : Math.round(timing.detailDisplayDurationMs)}
      </output>
    </>
  );
}

describe("useDetailDisplayTiming", () => {
  let frameCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    frameCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValue(100);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports detail display time only after the ready detail has painted", () => {
    const { rerender } = render(
      <Harness activeDetailKey={null} detailReady={false} />
    );

    rerender(<Harness activeDetailKey="item:1" detailReady={false} />);
    expect(screen.getByLabelText("duration")).toHaveTextContent("--");

    vi.mocked(performance.now).mockReturnValue(125);
    rerender(<Harness activeDetailKey="item:1" detailReady />);

    expect(screen.getByLabelText("duration")).toHaveTextContent("--");
    expect(frameCallbacks).toHaveLength(1);

    vi.mocked(performance.now).mockReturnValue(142);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(142));
    });

    expect(screen.getByLabelText("duration")).toHaveTextContent("42");
  });

  it("uses the explicit click start time when provided before selection changes", () => {
    const { rerender } = render(
      <Harness activeDetailKey="item:1" detailReady />
    );

    act(() => {
      screen.getByRole("button", { name: "start" }).click();
    });
    rerender(<Harness activeDetailKey="item:2" detailReady />);

    vi.mocked(performance.now).mockReturnValue(150);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(150));
    });

    expect(screen.getByLabelText("duration")).toHaveTextContent("50");
  });

  it("measures a ready detail again when the selected item is clicked again", () => {
    render(<Harness activeDetailKey="item:1" detailReady />);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(100));
    });

    act(() => {
      screen.getByRole("button", { name: "start" }).click();
    });

    expect(screen.getByLabelText("duration")).toHaveTextContent("--");
    expect(frameCallbacks).toHaveLength(1);

    vi.mocked(performance.now).mockReturnValue(118);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(118));
    });

    expect(screen.getByLabelText("duration")).toHaveTextContent("18");
  });
});
