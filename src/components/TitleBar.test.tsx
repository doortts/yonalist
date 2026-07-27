import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TitleBar, type PaneToggleControls } from "./TitleBar";

const baseControls: PaneToggleControls = {
  sidebarCollapsed: true,
  detailMaximized: false,
  middlePaneVisible: false,
  onToggleSidebar: vi.fn(),
  onToggleMaximize: vi.fn(),
  showDetailMaximizeToggle: true
};

describe("TitleBar", () => {
  it("places a collapsed navigation toggle after the traffic lights in Notes", () => {
    render(<TitleBar paneToggles={baseControls} />);

    expect(screen.getByRole("group", { name: "Pane layout" })).toHaveStyle({
      left: "86px"
    });
  });

  it("places a collapsed navigation toggle at the Settings middle-pane edge", () => {
    render(
      <TitleBar
        paneToggles={{ ...baseControls, middlePaneVisible: true }}
      />
    );

    expect(screen.getByRole("group", { name: "Pane layout" })).toHaveStyle({
      left:
        "max(86px, calc(var(--shell-inset, 8px) + var(--list-width, 340px) - 36px))"
    });
  });
});
