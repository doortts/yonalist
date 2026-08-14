import { fireEvent, render, screen } from "@testing-library/react";

import { defaultOutlineMarkerStyles } from "./outlineMarkers";
import { SettingsView } from "./SettingsView";

function renderSettings(overrides: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const handlers = {
    caretColor: "auto",
    markerStyles: defaultOutlineMarkerStyles(),
    onThemeModeChange: vi.fn(),
    onLightThemeChange: vi.fn(),
    onDarkThemeChange: vi.fn(),
    onCaretColorChange: vi.fn(),
    onMarkerStyleChange: vi.fn(),
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

  it("starts the caret on the theme default", () => {
    renderSettings();

    expect(
      screen.getByRole("button", { name: "Auto (theme default)" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pink" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("reports a picked caret swatch", () => {
    const handlers = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Pink" }));
    expect(handlers.onCaretColorChange).toHaveBeenCalledWith("#ff375f");

    fireEvent.click(screen.getByRole("button", { name: "Auto (theme default)" }));
    expect(handlers.onCaretColorChange).toHaveBeenCalledWith("auto");
  });

  it("reports a custom caret color", () => {
    const handlers = renderSettings();

    fireEvent.change(screen.getByLabelText("Custom"), {
      target: { value: "#123456" }
    });
    expect(handlers.onCaretColorChange).toHaveBeenCalledWith("#123456");
  });

  it("marks the swatch matching the current caret color", () => {
    renderSettings({ caretColor: "#bf5af2" });

    expect(screen.getByRole("button", { name: "Purple" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.getByRole("button", { name: "Auto (theme default)" })
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Custom")).toHaveValue("#bf5af2");
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

  it("changes one outline level's marker shape without touching the others", () => {
    const handlers = renderSettings();

    fireEvent.click(
      screen.getByRole("button", { name: "Square marker for level 2" })
    );
    expect(handlers.onMarkerStyleChange).toHaveBeenCalledWith(
      1, { shape: "square", char: "", color: null }
    );
  });

  // Turning a level custom has to hand it a character to draw, or the level
  // would show nothing until the field is typed into.
  it("seeds a custom level with a marker and takes an edited one", () => {
    const handlers = renderSettings({
      markerStyles: [
        { shape: "custom", char: "▸", color: null },
        { shape: "dot", char: "", color: null },
        { shape: "dot", char: "", color: null }
      ]
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Custom marker for level 2" })
    );
    expect(handlers.onMarkerStyleChange).toHaveBeenCalledWith(
      1, { shape: "custom", char: "▸", color: null }
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Level 1 marker character" }),
      { target: { value: "★★" } }
    );
    expect(handlers.onMarkerStyleChange).toHaveBeenCalledWith(
      0, { shape: "custom", char: "★", color: null }
    );
  });

  it("moves a level between the theme colour and a picked one", () => {
    const handlers = renderSettings({
      markerStyles: [
        { shape: "dot", char: "", color: "#e8734a" },
        { shape: "dot", char: "", color: null },
        { shape: "dot", char: "", color: null }
      ]
    });

    expect(
      screen.getByRole("button", { name: "Theme colour for level 2" })
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Theme colour for level 1" })
    );
    expect(handlers.onMarkerStyleChange).toHaveBeenCalledWith(
      0, { shape: "dot", char: "", color: null }
    );

    fireEvent.change(
      screen.getByLabelText("Custom colour for level 2"),
      { target: { value: "#123456" } }
    );
    expect(handlers.onMarkerStyleChange).toHaveBeenCalledWith(
      1, { shape: "dot", char: "", color: "#123456" }
    );
  });
});
