import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNavigationListAccent } from "./useNavigationListAccent";

function AccentProbe({ activeKey }: { activeKey: string }) {
  const style = useNavigationListAccent(activeKey);
  return <output aria-label="Accent" style={style} />;
}

describe("useNavigationListAccent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("changes the list hover and selected palette when navigation changes", async () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.8);
    const { rerender } = render(<AccentProbe activeKey="inbox:all" />);
    const output = document.querySelector("output") as HTMLOutputElement;
    const initialHover = output.style.getPropertyValue("--nav-list-hover-bg");
    const initialSelected = output.style.getPropertyValue("--nav-list-selected-bg");

    rerender(<AccentProbe activeKey="repo:pi/agent-dev" />);

    await waitFor(() => {
      expect(output.style.getPropertyValue("--nav-list-hover-bg")).not.toBe(
        initialHover
      );
      expect(output.style.getPropertyValue("--nav-list-selected-bg")).not.toBe(
        initialSelected
      );
    });
  });
});
