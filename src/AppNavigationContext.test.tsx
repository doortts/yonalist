import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { useAppNavigation } from "./AppNavigationContext";
import { notesFeature } from "./features/notes/NotesFeature";

const OriginalNotesProvider = notesFeature.Provider;
const scrollIntoView = vi.fn();

function NavigationProbeProvider({ children }: PropsWithChildren) {
  const { openSettings } = useAppNavigation();

  return (
    <OriginalNotesProvider>
      <button
        type="button"
        onClick={() => openSettings("notes", "images")}
      >
        Open Notes image settings
      </button>
      {children}
    </OriginalNotesProvider>
  );
}

describe("AppNavigationContext", () => {
  beforeEach(() => {
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
    notesFeature.Provider = NavigationProbeProvider;
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
  });

  afterEach(() => {
    notesFeature.Provider = OriginalNotesProvider;
  });

  it("lets a mounted feature provider open and target Notes image settings", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Open Notes image settings" })
    );

    const categories = await screen.findByLabelText("Settings sections");
    expect(within(categories).getByRole("tab", { name: /Notes/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    const images = await screen.findByRole("region", { name: "Images" });
    await waitFor(() => expect(images).toHaveFocus());
    expect(images).toHaveClass("settings-target-highlight");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("clears the image target on manual category changes and close", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Open Notes image settings" })
    );
    const categories = await screen.findByLabelText("Settings sections");
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Images" })).toHaveClass(
        "settings-target-highlight"
      )
    );

    await user.click(within(categories).getByRole("tab", { name: /Appearance/ }));
    await user.click(within(categories).getByRole("tab", { name: /Notes/ }));
    expect(screen.getByRole("region", { name: "Images" })).not.toHaveClass(
      "settings-target-highlight"
    );

    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("region", { name: "Images" })).not.toHaveClass(
      "settings-target-highlight"
    );
  });
});
