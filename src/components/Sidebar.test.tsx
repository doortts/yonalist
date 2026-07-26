import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FeatureId } from "../features/core/featureTypes";
import { Sidebar, type SidebarProps } from "./Sidebar";

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    online: true,
    loginRequired: false,
    onToggleOnline: vi.fn(),
    activeFeatureId: "notes",
    onFeatureChange: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides
  };
  return { ...render(<Sidebar {...props} />), props };
}

describe("Sidebar", () => {
  it("shows only Yonalist and Settings navigation", () => {
    renderSidebar({ activeFeatureId: "notes" });

    expect(screen.getByRole("button", { name: "Yonalist" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText("GitHub Inbox")).toBeNull();
    expect(screen.queryByText("Notifications")).toBeNull();
    expect(screen.queryByText("Favorites")).toBeNull();
    expect(screen.queryByText("Repository")).toBeNull();
  });

  it("selects a workspace feature from the compiled registry", async () => {
    const onFeatureChange = vi.fn<(featureId: FeatureId) => void>();
    renderSidebar({ activeFeatureId: "settings", onFeatureChange });

    await userEvent.setup().click(
      screen.getByRole("button", { name: "Yonalist" })
    );

    expect(onFeatureChange).toHaveBeenCalledWith("notes");
  });

  it("keeps sign-in and connectivity controls", async () => {
    const onToggleOnline = vi.fn();
    const onOpenSettings = vi.fn();
    renderSidebar({
      online: false,
      loginRequired: true,
      onToggleOnline,
      onOpenSettings
    });

    expect(screen.getByText("Offline")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", {
      name: "Login required"
    }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    await userEvent.setup().click(screen.getByRole("button", {
      name: "Go online"
    }));
    expect(onToggleOnline).toHaveBeenCalledOnce();
  });
});
