import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppBadge } from "./useAppBadge";

const setAppBadgeCountMock = vi.hoisted(() => vi.fn());

vi.mock("../services/appBadge", () => ({
  setAppBadgeCount: (count: number) => {
    setAppBadgeCountMock(count);
    return Promise.resolve();
  }
}));

function AppBadgeHarness({ count }: { count: number }) {
  useAppBadge(count);
  return null;
}

describe("useAppBadge", () => {
  afterEach(() => {
    setAppBadgeCountMock.mockReset();
  });

  it("updates the app badge when the notification count changes", () => {
    const { rerender } = render(<AppBadgeHarness count={3} />);

    expect(setAppBadgeCountMock).toHaveBeenCalledTimes(1);
    expect(setAppBadgeCountMock).toHaveBeenLastCalledWith(3);

    rerender(<AppBadgeHarness count={3} />);
    expect(setAppBadgeCountMock).toHaveBeenCalledTimes(1);

    rerender(<AppBadgeHarness count={0} />);
    expect(setAppBadgeCountMock).toHaveBeenCalledTimes(2);
    expect(setAppBadgeCountMock).toHaveBeenLastCalledWith(0);
  });
});
