import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Count renders of the Notes panes so we can assert that App-only state churn
// (analogous to the notification poll / status-metric updates the shell runs)
// does not re-render the Notes subtree once the feature panes are memoized
// (remediation 2.4). The real panes take no props, so a counting stand-in is a
// faithful probe of the element-reference bailout the memoization enables.
const libraryRenders = vi.hoisted(() => ({ count: 0 }));
const outlineRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("./features/notes/NotesLibraryPane", () => ({
  NotesLibraryPane: () => {
    libraryRenders.count += 1;
    return <div aria-label="Notes library" />;
  }
}));

vi.mock("./features/notes/NotesOutlinePane", () => ({
  NotesOutlinePane: () => {
    outlineRenders.count += 1;
    return <div aria-label="Notes outline" />;
  }
}));

import App from "./App";
import { activeFeatureStorageKey } from "./features/core/featureSelection";

describe("feature pane memoization across App commits", () => {
  beforeEach(() => {
    libraryRenders.count = 0;
    outlineRenders.count = 0;
    // Past the startup login gate and booting straight into the Notes feature.
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
    window.localStorage.setItem(activeFeatureStorageKey, "notes");
  });

  it("does not re-render the Notes panes when unrelated App state changes", async () => {
    const user = userEvent.setup();
    render(<App initialOnline={false} />);

    await screen.findByLabelText("Notes library");
    await screen.findByLabelText("Notes outline");

    // Let the mount's effects (feature persistence, settings normalization,
    // workspace load) flush so the baseline reflects a quiescent shell.
    await act(async () => {
      await Promise.resolve();
    });

    const libraryBaseline = libraryRenders.count;
    const outlineBaseline = outlineRenders.count;
    expect(libraryBaseline).toBeGreaterThan(0);
    expect(outlineBaseline).toBeGreaterThan(0);

    // Toggle connectivity: an App-level state change with nothing to do with
    // Notes, standing in for notification-poll / status-metric churn that
    // re-renders the shell.
    await user.click(screen.getByRole("button", { name: "Go online" }));

    // The App committed the new online state (the offline affordance is gone),
    // so the shell re-rendered.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Go online" })).toBeNull()
    );

    // Memoized feature panes keep stable element references, so React bails out
    // of the Notes subtree: no additional pane renders from the App commit.
    expect(libraryRenders.count).toBe(libraryBaseline);
    expect(outlineRenders.count).toBe(outlineBaseline);
  });
});
