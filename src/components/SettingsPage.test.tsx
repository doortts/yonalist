import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../appSettings";
import type { ResetProgressStatus } from "../resetProgress";
import { SettingsPage } from "./SettingsPage";

const scrollIntoView = vi.fn();
const appStyles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function settingsPageProps(): ComponentProps<typeof SettingsPage> {
  return {
    section: "notes",
    target: null,
    onTargetConsumed: vi.fn(),
    settings: defaultSettings,
    status: "",
    resetProgress: { status: "idle", steps: [], message: "" },
    themeMode: "system",
    lightTheme: "default",
    darkTheme: "dark",
    onThemeModeChange: vi.fn(),
    onLightThemeChange: vi.fn(),
    onDarkThemeChange: vi.fn(),
    servers: {} as ComponentProps<typeof SettingsPage>["servers"],
    auth: {} as ComponentProps<typeof SettingsPage>["auth"],
    repositoryGroups: [],
    projectVisibility: {} as ComponentProps<typeof SettingsPage>["projectVisibility"],
    onUpdate: vi.fn(),
    onSave: vi.fn(),
    onResetAll: vi.fn(),
    onClose: vi.fn()
  };
}

describe("SettingsPage Notes targets", () => {
  beforeEach(() => {
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("focuses, scrolls to, outlines, and consumes the requested Images target", async () => {
    const onTargetConsumed = vi.fn();
    render(
      <SettingsPage
        {...settingsPageProps()}
        target="images"
        onTargetConsumed={onTargetConsumed}
      />
    );

    const images = screen.getByRole("region", { name: "Images" });
    await waitFor(() => expect(images).toHaveFocus());

    expect(images).toHaveAttribute("tabindex", "-1");
    expect(images).toHaveClass("settings-target-highlight");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(onTargetConsumed).toHaveBeenCalledOnce();
    expect(onTargetConsumed).toHaveBeenCalledWith("images");
    expect(within(images).queryByRole("button")).toBeNull();
    expect(within(images).queryByRole("textbox")).toBeNull();

    fireEvent.animationEnd(images);
    expect(images).not.toHaveClass("settings-target-highlight");
  });

  it("clears the Images outline when animationend does not fire", () => {
    vi.useFakeTimers();
    render(<SettingsPage {...settingsPageProps()} target="images" />);

    const images = screen.getByRole("region", { name: "Images" });
    expect(images).toHaveClass("settings-target-highlight");

    act(() => vi.advanceTimersByTime(2_000));

    expect(images).not.toHaveClass("settings-target-highlight");
  });

  it("restarts the outline fallback after navigating away", () => {
    vi.useFakeTimers();
    const props = settingsPageProps();
    const { rerender } = render(<SettingsPage {...props} target="images" />);

    act(() => vi.advanceTimersByTime(1_000));

    rerender(<SettingsPage {...props} section="appearance" target={null} />);
    rerender(<SettingsPage {...props} section="notes" target="images" />);

    const images = screen.getByRole("region", { name: "Images" });
    act(() => vi.advanceTimersByTime(1_000));
    expect(images).toHaveClass("settings-target-highlight");

    act(() => vi.advanceTimersByTime(1_000));
    expect(images).not.toHaveClass("settings-target-highlight");
  });

  it("cancels the outline fallback timer on unmount", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = render(
      <SettingsPage {...settingsPageProps()} target="images" />
    );

    const fallbackCallIndex = setTimeoutSpy.mock.calls.findIndex(
      ([, delay]) => delay === 2_000
    );
    expect(fallbackCallIndex).toBeGreaterThanOrEqual(0);
    const fallbackTimer = setTimeoutSpy.mock.results[fallbackCallIndex]?.value;

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(fallbackTimer);
  });

  it("does not restore a consumed outline after manual section navigation", async () => {
    const props = settingsPageProps();
    const { rerender } = render(<SettingsPage {...props} target="images" />);

    const images = screen.getByRole("region", { name: "Images" });
    await waitFor(() => expect(images).toHaveClass("settings-target-highlight"));

    rerender(<SettingsPage {...props} section="appearance" target={null} />);
    rerender(<SettingsPage {...props} section="notes" target={null} />);

    expect(screen.getByRole("region", { name: "Images" })).not.toHaveClass(
      "settings-target-highlight"
    );
  });

  it("disables target highlight animation when reduced motion is requested", () => {
    expect(appStyles).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*\.settings-target-highlight\s*{[^}]*animation:\s*none;/s
    );
  });
});

function renderResetProgress(status: Exclude<ResetProgressStatus, "idle">) {
  const stepStatus = status === "done" ? "done" : status;
  render(
    <SettingsPage
      {...settingsPageProps()}
      section="reset"
      lightTheme="graphite"
      resetProgress={{
        status,
        message: `${status} reset`,
        steps: [{ id: "cache", label: "Cache", status: stepStatus }]
      }}
    />
  );
}

describe("SettingsPage reset feedback", () => {
  it.each([
    ["running", "status"],
    ["done", "status"],
    ["failed", "alert"]
  ] as const)("uses %s reset semantics", (status, role) => {
    renderResetProgress(status);
    expect(screen.getByRole(role, { name: "Reset progress" }))
      .toHaveTextContent(`${status} reset`);
  });
});
