import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MobileDayMenu } from "./MobileDayMenu";

function open(showCompleted = true, onShowCompletedChange = vi.fn()) {
  render(
    <MobileDayMenu
      showCompleted={showCompleted}
      onShowCompletedChange={onShowCompletedChange}
    />
  );
  return { onShowCompletedChange };
}

describe("MobileDayMenu", () => {
  it("stays shut until it is asked for", () => {
    open();

    expect(screen.getByRole("button", { name: /more/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("holds what the phone has no other way to reach", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: /more/i }));

    const items = screen.getAllByRole("menuitemcheckbox");
    expect(items.map((item) => item.textContent)).toEqual(["Completed items"]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
  });

  it("reports the toggle rather than deciding it, and shuts after", async () => {
    const user = userEvent.setup();
    const { onShowCompletedChange } = open(true);

    await user.click(screen.getByRole("button", { name: /more/i }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /completed/i }));

    expect(onShowCompletedChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("says which way the toggle already sits", async () => {
    const user = userEvent.setup();
    open(false);

    await user.click(screen.getByRole("button", { name: /more/i }));

    expect(screen.getByRole("menuitemcheckbox")).toHaveAttribute("aria-checked", "false");
  });
});
