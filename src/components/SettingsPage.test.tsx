import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../appSettings";
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
