import { fireEvent, render, screen } from "@testing-library/react";

import { SettingsView } from "./SettingsView";

function renderSettings(overrides: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const handlers = {
    onThemeModeChange: vi.fn(),
    onLightThemeChange: vi.fn(),
    onDarkThemeChange: vi.fn(),
    onClose: vi.fn(),
    unusedAssets: vi.fn().mockResolvedValue({
      count: 0,
      totalBytes: 0,
      purged: false
    }),
    deleteAllData: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  render(
    <SettingsView
      themeMode="system"
      lightTheme="soft-paper"
      darkTheme="dark"
      {...handlers}
    />
  );
  return handlers;
}

describe("SettingsView", () => {
  it("offers system, light, and dark modes and reports a change", () => {
    const handlers = renderSettings();

    fireEvent.click(screen.getByRole("radio", { name: "Dark mode" }));
    expect(handlers.onThemeModeChange).toHaveBeenCalledWith("dark");
    expect(screen.getByRole("radio", { name: "System mode" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Light mode" })).toBeInTheDocument();
  });

  it("changes theme variants independently and closes", () => {
    const handlers = renderSettings();

    fireEvent.click(screen.getByRole("radio", { name: "Yona light theme" }));
    expect(handlers.onLightThemeChange).toHaveBeenCalledWith("yona");

    fireEvent.click(screen.getByRole("radio", { name: "Yonal Dark dark theme" }));
    expect(handlers.onDarkThemeChange).toHaveBeenCalledWith("yona-dark");

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it("checks unused assets and purges only after confirmation", async () => {
    const handlers = renderSettings({
      unusedAssets: vi.fn().mockResolvedValue({
        count: 3,
        totalBytes: 4_096,
        purged: false
      })
    });

    fireEvent.click(screen.getByRole("button", { name: "Check unused assets" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "3 unused assets (4,096 bytes)"
    );
    expect(handlers.unusedAssets).toHaveBeenCalledWith(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete unused assets..." })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete 3 unused assets" })
    );
    await screen.findByRole("status");
    expect(handlers.unusedAssets).toHaveBeenCalledWith(true);
  });

  it("deletes all data only after an explicit confirmation step", async () => {
    const handlers = renderSettings();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete all Yonalist data..." })
    );
    expect(handlers.deleteAllData).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.deleteAllData).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete all Yonalist data..." })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete everything and restart" })
    );
    expect(handlers.deleteAllData).toHaveBeenCalledOnce();
  });
});
