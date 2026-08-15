import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { pickVaultFolder } from "./vaultPicker";

import {
  defaultOutlineMarkerStyles,
  MAX_OUTLINE_MARKER_LEVELS
} from "./outlineMarkers";
import { SettingsView } from "./SettingsView";
import type { TextFont } from "./useTheme";

function renderSettings(overrides: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const handlers = {
    caretColor: "auto",
    textFont: "sans" as TextFont,
    markerStyles: defaultOutlineMarkerStyles(),
    onThemeModeChange: vi.fn(),
    onLightThemeChange: vi.fn(),
    onDarkThemeChange: vi.fn(),
    onCaretColorChange: vi.fn(),
    onTextFontChange: vi.fn(),
    onMarkerStylesChange: vi.fn(),
    onClose: vi.fn(),
    unusedAssets: vi.fn().mockResolvedValue({
      count: 0,
      totalBytes: 0,
      purged: false
    }),
    deleteAllData: vi.fn().mockResolvedValue(undefined),
    readVaultPath: vi.fn().mockResolvedValue(null),
    setVaultPath: vi.fn().mockResolvedValue(undefined),
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

vi.mock("./vaultPicker", () => ({ pickVaultFolder: vi.fn() }));

describe("SettingsView", () => {
  it("shows the vault folder that is already chosen", async () => {
    renderSettings({
      readVaultPath: vi.fn().mockResolvedValue("/Users/me/Yonalist")
    });

    expect(await screen.findByText("/Users/me/Yonalist")).toBeInTheDocument();
  });

  it("saves and shows a newly chosen vault folder", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue("/Users/me/Yonalist");
    const handlers = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));

    await waitFor(() => {
      expect(handlers.setVaultPath).toHaveBeenCalledWith("/Users/me/Yonalist");
    });
    expect(await screen.findByText("/Users/me/Yonalist")).toBeInTheDocument();
  });

  it("leaves the folder alone when the picker is dismissed", async () => {
    vi.mocked(pickVaultFolder).mockResolvedValue(null);
    const handlers = renderSettings({
      readVaultPath: vi.fn().mockResolvedValue("/Users/me/Yonalist")
    });

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    await waitFor(() => expect(pickVaultFolder).toHaveBeenCalled());
    expect(handlers.setVaultPath).not.toHaveBeenCalled();
    expect(screen.getByText("/Users/me/Yonalist")).toBeInTheDocument();
  });

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

  // Only the outline's own text changes; the rest of the window stays in the
  // interface font, which is what the stylesheet scopes the setting to.
  it("moves the outline text between the sans and monospace fonts", () => {
    const handlers = renderSettings();

    fireEvent.click(screen.getByRole("radio", { name: "Monospace outline text" }));
    expect(handlers.onTextFontChange).toHaveBeenCalledWith("mono");
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

  it("shows one level and an invitation to add the next", () => {
    renderSettings();

    expect(screen.getByRole("button", { name: "Dot marker for level 1" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dot marker for level 2" }))
      .toBeNull();
    expect(screen.getByRole("button", { name: "Add level 2" }))
      .toBeInTheDocument();
  });

  it("appends a plain level and reports the whole set", () => {
    const handlers = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Add level 2" }));
    expect(handlers.onMarkerStylesChange).toHaveBeenCalledWith([
      { shape: "dot", char: "", color: null },
      { shape: "dot", char: "", color: null }
    ]);
  });

  it("stops inviting a new level once the last one is configured", () => {
    renderSettings({
      markerStyles: Array.from({ length: MAX_OUTLINE_MARKER_LEVELS }, () => (
        { shape: "dot" as const, char: "", color: null }
      ))
    });

    expect(screen.queryByRole("button", { name: /^Add level/u })).toBeNull();
  });

  // Removing a level in the middle pulls every level below it up a place, which
  // changes markers nobody asked to change. Only the last one goes.
  it("offers removal on the last level alone, and never on the only one", () => {
    renderSettings();
    expect(screen.queryByRole("button", { name: /^Remove level/u })).toBeNull();

    renderSettings({
      markerStyles: [
        { shape: "dot", char: "", color: null },
        { shape: "dash", char: "", color: null },
        { shape: "square", char: "", color: null }
      ]
    });
    expect(screen.queryByRole("button", { name: "Remove level 2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove level 3" }))
      .toBeInTheDocument();
  });

  it("drops the level its remove icon sits beside", () => {
    const handlers = renderSettings({
      markerStyles: [
        { shape: "dot", char: "", color: null },
        { shape: "dash", char: "", color: null }
      ]
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove level 2" }));
    expect(handlers.onMarkerStylesChange).toHaveBeenCalledWith([
      { shape: "dot", char: "", color: null }
    ]);
  });

  it("changes one level's marker shape without touching the others", () => {
    const handlers = renderSettings({
      markerStyles: [
        { shape: "dot", char: "", color: null },
        { shape: "dot", char: "", color: null }
      ]
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Square marker for level 2" })
    );
    expect(handlers.onMarkerStylesChange).toHaveBeenCalledWith([
      { shape: "dot", char: "", color: null },
      { shape: "square", char: "", color: null }
    ]);
  });

  // Turning a level custom has to hand it a character to draw, or the level
  // would show nothing until the field is typed into.
  it("seeds a custom level with a marker and takes an edited one", () => {
    const handlers = renderSettings({
      markerStyles: [{ shape: "custom", char: "▸", color: null }]
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Level 1 marker character" }),
      { target: { value: "★★" } }
    );
    expect(handlers.onMarkerStylesChange).toHaveBeenCalledWith([
      { shape: "custom", char: "★", color: null }
    ]);
  });

  // The picker always answers with a colour -- there is no "none" in it -- so
  // the only way back to the theme's own colour is a control of our own, and it
  // shows up on a level that has a colour to clear.
  it("takes a picked colour and clears it only where there is one", () => {
    const handlers = renderSettings();
    expect(screen.getByText("Color")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Clear level/u })).toBeNull();

    fireEvent.change(screen.getByLabelText("Level 1 marker color"), {
      target: { value: "#123456" }
    });
    expect(handlers.onMarkerStylesChange).toHaveBeenCalledWith([
      { shape: "dot", char: "", color: "#123456" }
    ]);
  });

  it("puts a level back on the theme colour", () => {
    const handlers = renderSettings({
      markerStyles: [{ shape: "dot", char: "", color: "#e8734a" }]
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear level 1 color" }));
    expect(handlers.onMarkerStylesChange).toHaveBeenCalledWith([
      { shape: "dot", char: "", color: null }
    ]);
  });
});
