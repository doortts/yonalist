import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const perfSpies = vi.hoisted(() => ({
  tracePerf: vi.fn(),
  tracePerfOnce: vi.fn()
}));

vi.mock("./services/perfTrace", () => perfSpies);

import App from "./App";
import { activeFeatureStorageKey } from "./features/core/featureSelection";

describe("App feature activation timing", () => {
  beforeEach(() => {
    perfSpies.tracePerf.mockClear();
    perfSpies.tracePerfOnce.mockClear();
    window.localStorage.clear();
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
    window.localStorage.setItem(activeFeatureStorageKey, "settings");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records one start and visible event when Yonalist becomes visible", async () => {
    render(<App initialOnline={false} />);

    await userEvent.setup().click(
      await screen.findByRole("button", { name: "Yonalist" })
    );
    await screen.findByLabelText("Yonalist library", {}, { timeout: 5_000 });

    await waitFor(() => {
      const featureEvents = perfSpies.tracePerf.mock.calls.filter(
        ([name]) => typeof name === "string" && name.startsWith("feature_activation_")
      );
      expect(featureEvents).toHaveLength(2);
    });

    const featureEvents = perfSpies.tracePerf.mock.calls
      .filter(
        ([name]) => typeof name === "string" && name.startsWith("feature_activation_")
      )
      .map(([name, detail]) => ({ name, detail }));

    expect(featureEvents.map(({ name }) => name)).toEqual([
      "feature_activation_start",
      "feature_activation_visible"
    ]);
    expect(featureEvents[0]?.detail).toMatchObject({
      activationId: 1,
      featureId: "notes"
    });
    expect(featureEvents[1]?.detail).toMatchObject({
      activationId: 1,
      featureId: "notes",
      durationMs: expect.any(Number)
    });
  }, 10_000);
});
