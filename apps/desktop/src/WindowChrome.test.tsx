import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WindowChrome } from "./WindowChrome";

describe("WindowChrome tooltips and controls", () => {
  it("renders correct tooltip and state for sidebar toggle button", () => {
    const onToggleSidebar = vi.fn();
    const onToggleDetail = vi.fn();

    const { rerender } = render(
      <WindowChrome
        sidebarCollapsed={false}
        detailMaximized={false}
        onToggleSidebar={onToggleSidebar}
        onToggleDetail={onToggleDetail}
      />
    );

    const sidebarButton = screen.getByRole("button", { name: "Toggle sidebar" });
    expect(sidebarButton).toHaveAttribute("data-tooltip", "Collapse sidebar");
    expect(sidebarButton).toHaveAttribute("data-tooltip-align", "left");
    expect(sidebarButton).not.toHaveAttribute("title");
    expect(sidebarButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(sidebarButton);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    // When collapsed
    rerender(
      <WindowChrome
        sidebarCollapsed={true}
        detailMaximized={false}
        onToggleSidebar={onToggleSidebar}
        onToggleDetail={onToggleDetail}
      />
    );
    expect(sidebarButton).toHaveAttribute("data-tooltip", "Expand sidebar");
    expect(sidebarButton).toHaveAttribute("aria-pressed", "true");
  });

  it("renders correct tooltip and state for detail maximize button", () => {
    const onToggleSidebar = vi.fn();
    const onToggleDetail = vi.fn();

    const { rerender } = render(
      <WindowChrome
        sidebarCollapsed={false}
        detailMaximized={false}
        onToggleSidebar={onToggleSidebar}
        onToggleDetail={onToggleDetail}
      />
    );

    const maximizeButton = screen.getByRole("button", { name: "Maximize detail" });
    expect(maximizeButton).toHaveAttribute("data-tooltip", "Maximize detail");
    expect(maximizeButton).toHaveAttribute("data-tooltip-align", "right");
    expect(maximizeButton).not.toHaveAttribute("title");
    expect(maximizeButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(maximizeButton);
    expect(onToggleDetail).toHaveBeenCalledTimes(1);

    // When maximized
    rerender(
      <WindowChrome
        sidebarCollapsed={false}
        detailMaximized={true}
        onToggleSidebar={onToggleSidebar}
        onToggleDetail={onToggleDetail}
      />
    );
    expect(maximizeButton).toHaveAttribute("data-tooltip", "Restore detail");
    expect(maximizeButton).toHaveAttribute("aria-pressed", "true");
  });
});
