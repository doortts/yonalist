import { fireEvent, render, screen } from "@testing-library/react";

import { SettingsView } from "./SettingsView";

function renderSettings(overrides: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const handlers = {
    onThemeModeChange: vi.fn(),
    onLightThemeChange: vi.fn(),
    onDarkThemeChange: vi.fn(),
    onClose: vi.fn()
  };
  render(
    <SettingsView
      themeMode="system"
      lightTheme="soft-paper"
      darkTheme="dark"
      {...handlers}
      {...overrides}
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
});
