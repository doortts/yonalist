import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  SettingsCategoryPane,
  settingsSections,
  type SettingsSection
} from "./SettingsCategoryPane";

/**
 * Controlled harness that mirrors how App wires SettingsCategoryPane: the
 * selected section is lifted into parent state so that selecting a tab (by
 * click or keyboard) actually updates which tab is active.
 */
function ControlledPane({
  initial = "appearance",
  onSelect
}: {
  initial?: SettingsSection;
  onSelect?: (section: SettingsSection) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initial);
  return (
    <SettingsCategoryPane
      section={section}
      onSelect={(next) => {
        setSection(next);
        onSelect?.(next);
      }}
    />
  );
}

describe("SettingsCategoryPane (Base UI vertical Tabs)", () => {
  it("renders each settings section as a tab inside a vertical tablist", () => {
    render(<SettingsCategoryPane section="appearance" onSelect={vi.fn()} />);

    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveClass("settings-category-list");
    expect(tablist).toHaveAttribute("aria-orientation", "vertical");

    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(settingsSections.length);
    for (const tab of tabs) {
      expect(tab).toHaveClass("category-item");
    }
  });

  it("marks the active section with aria-selected and the active class", () => {
    render(<SettingsCategoryPane section="servers" onSelect={vi.fn()} />);

    const active = screen.getByRole("tab", { name: /GitHub 서버/ });
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(active).toHaveClass("category-item", "active");

    const inactive = screen.getByRole("tab", { name: /Appearance/ });
    expect(inactive).toHaveAttribute("aria-selected", "false");
    expect(inactive).not.toHaveClass("active");
  });

  it("selects a category via click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SettingsCategoryPane section="appearance" onSelect={onSelect} />);

    await user.click(screen.getByRole("tab", { name: /Reset/ }));

    expect(onSelect).toHaveBeenCalledWith("reset");
  });

  it("offers Notes as a settings category", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SettingsCategoryPane section="appearance" onSelect={onSelect} />);

    await user.click(screen.getByRole("tab", { name: /Notes/ }));

    expect(onSelect).toHaveBeenCalledWith("notes");
  });

  it("moves the selection with the arrow keys", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledPane initial="appearance" onSelect={onSelect} />);

    // Focus the currently active tab, then walk down the vertical list.
    const first = screen.getByRole("tab", { name: /Appearance/ });
    first.focus();
    await user.keyboard("{ArrowDown}");

    // Second section becomes selected as focus moves (vertical orientation).
    const second = screen.getByRole("tab", { name: /GitHub 서버/ });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(onSelect).toHaveBeenLastCalledWith("servers");
  });
});
