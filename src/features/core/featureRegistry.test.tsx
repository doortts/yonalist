import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import { featureRegistry, getFeatureDefinition } from "./featureRegistry";

describe("feature registry", () => {
  it("registers the compiled features in navigation order", () => {
    expect(featureRegistry.map((feature) => feature.id)).toEqual([
      "inbox",
      "notes",
      "settings"
    ]);
  });

  it("registers Notes as an offline workspace feature", () => {
    const notes = getFeatureDefinition("notes");

    expect(notes.requiresGithubAuth).toBe(false);
    expect(notes.section).toBe("workspace");
    expect(notes.order).toBe(20);
  });

  it("gives Notes metadata a loader instead of an eager runtime", () => {
    const notes = getFeatureDefinition("notes");

    expect(notes.id).toBe("notes");
    expect("runtime" in notes).toBe(false);
    expect("loadRuntime" in notes).toBe(true);
  });

  it("keeps Inbox and Settings runtimes eager", () => {
    expect("runtime" in getFeatureDefinition("inbox")).toBe(true);
    expect("runtime" in getFeatureDefinition("settings")).toBe(true);
  });

  it("delegates Inbox panes to the App-owned renderer", () => {
    const renderInboxPanes = vi.fn(() => ({
      middle: <div>Inbox middle pane</div>,
      detail: <div>Inbox detail pane</div>
    }));

    const inbox = getFeatureDefinition("inbox");
    if (!inbox.runtime) {
      throw new Error("Inbox runtime must be eager.");
    }
    const panes = inbox.runtime.renderPanes({
      renderInboxPanes,
      renderSettingsPanes: vi.fn()
    });

    expect(renderInboxPanes).toHaveBeenCalledOnce();
    render(<>{panes.middle}{panes.detail}</>);
    expect(screen.getByText("Inbox middle pane")).toBeInTheDocument();
    expect(screen.getByText("Inbox detail pane")).toBeInTheDocument();
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
      renderInboxPanes: vi.fn(),
      renderSettingsPanes
    });

    expect(renderSettingsPanes).toHaveBeenCalledOnce();
    render(<>{panes.middle}{panes.detail}</>);
    expect(screen.getByText("Settings middle pane")).toBeInTheDocument();
    expect(screen.getByText("Settings detail pane")).toBeInTheDocument();
  });

  it("loads structural Notes panes without App-owned renderers", async () => {
    const notes = getFeatureDefinition("notes");
    if (!notes.loadRuntime) {
      throw new Error("Notes runtime must be lazy.");
    }
    const runtime = await notes.loadRuntime();
    const panes = runtime.renderPanes({
      renderInboxPanes: vi.fn(),
      renderSettingsPanes: vi.fn()
    });
    const NotesProvider = runtime.Provider;

    render(
      <VaultRootContext.Provider value="/registry-vault">
        <NotesProvider>
          {panes.middle}
          {panes.detail}
        </NotesProvider>
      </VaultRootContext.Provider>
    );
    expect(screen.getByLabelText("Notes library")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes outline")).toBeInTheDocument();
  });
});
