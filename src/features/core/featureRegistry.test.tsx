import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppNavigationContext } from "../../AppNavigationContext";
import { VaultRootContext } from "../../VaultRootContext";
import { featureRegistry, getFeatureDefinition } from "./featureRegistry";

describe("feature registry", () => {
  it("registers only Yonalist and Settings", () => {
    expect(featureRegistry.map((feature) => feature.id)).toEqual([
      "notes",
      "settings"
    ]);
    expect(featureRegistry.map((feature) => feature.label)).toEqual([
      "Yonalist",
      "Settings"
    ]);
  });

  it("registers Yonalist as the retained lazy workspace", () => {
    const notes = getFeatureDefinition("notes");

    expect(notes.section).toBe("workspace");
    expect(notes.order).toBe(20);
    expect(notes.keepMounted).toBe(true);
  });

  it("gives Notes metadata a loader instead of an eager runtime", () => {
    const notes = getFeatureDefinition("notes");

    expect(notes.id).toBe("notes");
    expect("runtime" in notes).toBe(false);
    expect("loadRuntime" in notes).toBe(true);
  });

  it("keeps the Settings runtime eager", () => {
    expect("runtime" in getFeatureDefinition("settings")).toBe(true);
  });

  it("delegates Settings panes to the App-owned renderer", () => {
    const renderSettingsPanes = vi.fn(() => ({
      middle: <div>Settings middle pane</div>,
      detail: <div>Settings detail pane</div>
    }));

    const settings = getFeatureDefinition("settings");
    if (!settings.runtime) {
      throw new Error("Settings runtime must be eager.");
    }
    const panes = settings.runtime.renderPanes({
      renderSettingsPanes
    });

    expect(renderSettingsPanes).toHaveBeenCalledOnce();
    expect(panes.navigation).toBeUndefined();
    expect(panes.middle).toBeDefined();
    render(<>{panes.middle}{panes.detail}</>);
    expect(screen.getByText("Settings middle pane")).toBeInTheDocument();
    expect(screen.getByText("Settings detail pane")).toBeInTheDocument();
  });

  it("loads retained Notes navigation and detail without a middle pane", async () => {
    const notes = getFeatureDefinition("notes");
    if (!notes.loadRuntime) {
      throw new Error("Notes runtime must be lazy.");
    }
    const runtime = await notes.loadRuntime();
    const panes = runtime.renderPanes({
      renderSettingsPanes: vi.fn()
    });
    const NotesProvider = runtime.Provider;

    expect(panes.middle).toBeUndefined();
    expect(panes.navigation).toBeDefined();

    render(
      <AppNavigationContext.Provider
        value={{ openNotes: vi.fn(), openSettings: vi.fn() }}
      >
        <VaultRootContext.Provider value="/registry-vault">
          <NotesProvider>
            {panes.navigation?.headerActions}
            {panes.navigation?.content}
            {panes.detail}
          </NotesProvider>
        </VaultRootContext.Provider>
      </AppNavigationContext.Provider>
    );
    expect(screen.getByLabelText("Yonalist library")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
  });
});
