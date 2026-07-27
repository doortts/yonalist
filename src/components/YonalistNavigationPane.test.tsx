import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { YonalistNavigationPane } from "./YonalistNavigationPane";

function renderPane(
  overrides: Partial<ComponentProps<typeof YonalistNavigationPane>> = {}
) {
  const props: ComponentProps<typeof YonalistNavigationPane> = {
    activeFeatureId: "notes",
    online: true,
    loginRequired: false,
    notesStatus: "ready",
    onOpenNotes: vi.fn(),
    onOpenSettings: vi.fn(),
    onRetryNotes: vi.fn(),
    onToggleOnline: vi.fn(),
    headerActions: <button type="button">Data settings</button>,
    children: <div aria-label="Yonalist library">Notes navigation</div>,
    ...overrides
  };
  return { ...render(<YonalistNavigationPane {...props} />), props };
}

describe("YonalistNavigationPane", () => {
  it("renders one navigation landmark with fixed app and Notes controls", () => {
    renderPane();

    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Yonalist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Yonalist library")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("marks only Settings as the app-level selection", () => {
    renderPane({ activeFeatureId: "settings" });

    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("keeps connectivity and login controls available", async () => {
    const onOpenSettings = vi.fn();
    const onToggleOnline = vi.fn();
    renderPane({ online: false, loginRequired: true, onOpenSettings, onToggleOnline });

    expect(screen.getByText("Offline")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Login required" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await userEvent.setup().click(screen.getByRole("button", { name: "Go online" }));
    expect(onToggleOnline).toHaveBeenCalledOnce();
  });

  it("keeps Settings available while Notes is loading or failed", async () => {
    const onRetryNotes = vi.fn();
    const { rerender, props } = renderPane({ notesStatus: "loading", headerActions: null, children: null, onRetryNotes });
    expect(screen.getByRole("status")).toHaveTextContent("Loading Yonalist");
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();
    rerender(<YonalistNavigationPane {...props} notesStatus="failed" headerActions={null}>{null}</YonalistNavigationPane>);
    await userEvent.setup().click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetryNotes).toHaveBeenCalledOnce();
  });
});
