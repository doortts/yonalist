import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    onUpdate: vi.fn(),
    onBrowseVaultFolder: vi.fn().mockResolvedValue(null),
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

  it("edits the three Notes asset retention settings", () => {
    const onUpdate = vi.fn();
    render(<SettingsPage {...settingsPageProps()} onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText("Asset trash retention days"), {
      target: { value: "14" }
    });
    fireEvent.change(screen.getByLabelText("Large asset trash retention days"), {
      target: { value: "3" }
    });
    fireEvent.change(screen.getByLabelText("Large asset threshold (MB)"), {
      target: { value: "8" }
    });

    expect(onUpdate.mock.calls).toEqual([
      ["assetTrashRetentionDays", 14],
      ["assetTrashLargeFileDays", 3],
      ["assetLargeFileThresholdMb", 8]
    ]);
  });
});

describe("SettingsPage vault folder picker", () => {
  it("keeps the local folder input intact and commits it on blur", () => {
    const onUpdate = vi.fn();
    render(
      <SettingsPage
        {...settingsPageProps()}
        section="vault"
        onUpdate={onUpdate}
      />
    );
    const input = screen.getByLabelText("Vault folder");

    fireEvent.change(input, {
      target: { value: "/Users/doortts/TypedVault" }
    });

    expect(input).toHaveValue("/Users/doortts/TypedVault");
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onUpdate).toHaveBeenCalledWith(
      "vaultFolder",
      "/Users/doortts/TypedVault"
    );
  });

  it("updates the vault folder with the picked path", async () => {
    const onUpdate = vi.fn();
    const onBrowseVaultFolder = vi
      .fn()
      .mockResolvedValue("/Users/doortts/PickedVault");
    render(
      <SettingsPage
        {...settingsPageProps()}
        section="vault"
        onUpdate={onUpdate}
        onBrowseVaultFolder={onBrowseVaultFolder}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        "vaultFolder",
        "/Users/doortts/PickedVault"
      )
    );
    expect(onBrowseVaultFolder).toHaveBeenCalledWith(defaultSettings.vaultFolder);
  });

  it("keeps the vault folder when the picker is cancelled", async () => {
    const onUpdate = vi.fn();
    const onBrowseVaultFolder = vi.fn().mockResolvedValue(null);
    render(
      <SettingsPage
        {...settingsPageProps()}
        section="vault"
        onUpdate={onUpdate}
        onBrowseVaultFolder={onBrowseVaultFolder}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));

    await waitFor(() => expect(onBrowseVaultFolder).toHaveBeenCalled());
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("SettingsPage Plugins", () => {
  it("keeps desktop notifications with the GN plugin settings", () => {
    render(<SettingsPage {...settingsPageProps()} section="plugins" />);

    expect(screen.getByRole("checkbox", {
      name: "Desktop notifications for GitHub Notifications"
    })).toBeChecked();
    expect(screen.queryByText("Sync queued changes when online")).toBeNull();
    expect(screen.queryByText("Download comments while syncing")).toBeNull();
    expect(screen.queryByText("Prefetch visible conversations")).toBeNull();
  });

  it("toggles GitHub Notifications and disables its retention input", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const props = settingsPageProps();
    const { rerender } = render(
      <SettingsPage
        {...props}
        section="plugins"
        onUpdate={onUpdate}
      />
    );

    const toggle = screen.getByRole("checkbox", {
      name: "GitHub Notifications 사용"
    });
    const retention = screen.getByRole("spinbutton", {
      name: "읽은 알림 표시 기간"
    });
    expect(toggle).toBeChecked();
    expect(retention).toBeEnabled();

    await user.click(toggle);
    expect(onUpdate).toHaveBeenCalledWith(
      "githubNotificationsPluginEnabled",
      false
    );

    rerender(
      <SettingsPage
        {...props}
        section="plugins"
        settings={{
          ...defaultSettings,
          githubNotificationsPluginEnabled: false
        }}
        onUpdate={onUpdate}
      />
    );
    expect(screen.getByRole("checkbox", {
      name: "GitHub Notifications 사용"
    })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", {
      name: "읽은 알림 표시 기간"
    })).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", {
        name: "GitHub Notifications 사용"
      })
    );
    expect(onUpdate).toHaveBeenLastCalledWith(
      "githubNotificationsPluginEnabled",
      true
    );
  });

  it("edits the GitHub Notifications read retention", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <SettingsPage
        {...settingsPageProps()}
        section="plugins"
        onUpdate={onUpdate}
      />
    );

    expect(
      screen.getByRole("heading", { name: "GitHub Notifications" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/읽지 않은 알림은 이 기간보다 오래되어도 유지됩니다/)
    ).toBeInTheDocument();

    const input = screen.getByRole("spinbutton", {
      name: "읽은 알림 표시 기간"
    });
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "365");
    expect(input).toHaveAttribute("step", "1");
    expect(input).toBeRequired();
    expect(screen.getByRole("button", { name: "Save settings" }))
      .toBeInTheDocument();

    await user.clear(input);
    expect(onUpdate).not.toHaveBeenCalled();
    await user.type(input, "45");
    expect(onUpdate).toHaveBeenLastCalledWith(
      "githubNotificationsReadRetentionDays",
      45
    );
    fireEvent.change(input, { target: { value: "0" } });
    expect(onUpdate).toHaveBeenLastCalledWith(
      "githubNotificationsReadRetentionDays",
      1
    );
    fireEvent.change(input, { target: { value: "366" } });
    expect(onUpdate).toHaveBeenLastCalledWith(
      "githubNotificationsReadRetentionDays",
      365
    );
    fireEvent.change(input, { target: { value: "7.6" } });
    expect(onUpdate).toHaveBeenLastCalledWith(
      "githubNotificationsReadRetentionDays",
      8
    );
    await user.clear(input);
    fireEvent.blur(input);
    expect(onUpdate).toHaveBeenLastCalledWith(
      "githubNotificationsReadRetentionDays",
      30
    );
  });
});

describe("SettingsPage Reset", () => {
  it("explains that Yonalist notes and attachments are kept", async () => {
    render(<SettingsPage {...settingsPageProps()} section="reset" />);

    expect(screen.getByText(
      /Yonalist notes and attachments are kept\./
    )).toBeInTheDocument();
    await userEvent.setup().click(
      screen.getByRole("button", { name: "Reset settings and caches" })
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Yonalist notes and attachments will be kept."
    );
  });
});
