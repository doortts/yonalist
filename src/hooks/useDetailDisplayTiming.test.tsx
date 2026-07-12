import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDetailDisplayTiming } from "./useDetailDisplayTiming";

type Timing = ReturnType<typeof useDetailDisplayTiming>;

function Harness({
  activeDetailKey,
  detailReady,
  onTiming
}: {
  activeDetailKey: string | null;
  detailReady: boolean;
  onTiming: (timing: Timing) => void;
}) {
  const timing = useDetailDisplayTiming(activeDetailKey, detailReady);
  onTiming(timing);
  return (
    <button type="button" onClick={() => timing.startDetailTransition(100)}>
      start
    </button>
  );
}

describe("useDetailDisplayTiming", () => {
  let frameCallbacks: FrameRequestCallback[];
  let timing: Timing;
  const onTiming = (next: Timing) => {
    timing = next;
  };

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
      <Harness activeDetailKey={null} detailReady={false} onTiming={onTiming} />
    );

    rerender(
      <Harness activeDetailKey="item:1" detailReady={false} onTiming={onTiming} />
    );
    expect(timing.getDetailDisplayDurationMs()).toBeNull();

    vi.mocked(performance.now).mockReturnValue(125);
    rerender(
      <Harness activeDetailKey="item:1" detailReady onTiming={onTiming} />
    );

    expect(timing.getDetailDisplayDurationMs()).toBeNull();
    expect(frameCallbacks).toHaveLength(1);

    vi.mocked(performance.now).mockReturnValue(142);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(142));
    });

    expect(timing.getDetailDisplayDurationMs()).toBeCloseTo(42);
  });

  it("uses the explicit click start time when provided before selection changes", () => {
    const { rerender } = render(
      <Harness activeDetailKey="item:1" detailReady onTiming={onTiming} />
    );

    act(() => {
      screen.getByRole("button", { name: "start" }).click();
    });
    rerender(
      <Harness activeDetailKey="item:2" detailReady onTiming={onTiming} />
    );

    vi.mocked(performance.now).mockReturnValue(150);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(150));
    });

    expect(timing.getDetailDisplayDurationMs()).toBeCloseTo(50);
  });

  it("measures a ready detail again when the selected item is clicked again", () => {
    render(<Harness activeDetailKey="item:1" detailReady onTiming={onTiming} />);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(100));
    });

    act(() => {
      screen.getByRole("button", { name: "start" }).click();
    });

    expect(timing.getDetailDisplayDurationMs()).toBeNull();
    expect(frameCallbacks).toHaveLength(1);

    vi.mocked(performance.now).mockReturnValue(118);
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(118));
    });

    expect(timing.getDetailDisplayDurationMs()).toBeCloseTo(18);
  });
});
