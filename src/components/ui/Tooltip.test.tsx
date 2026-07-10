import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { IconTooltip } from "./Tooltip";

describe("IconTooltip", () => {
  it("keeps the trigger name and a stable described-by popup relationship", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <IconTooltip label="Helpful detail">
        <button type="button" aria-label="Named action">
          Action
        </button>
      </IconTooltip>
    );
    const trigger = screen.getByRole("button", { name: "Named action" });
    const popupId = trigger.getAttribute("aria-describedby");

    expect(trigger).toHaveAttribute("aria-label", "Named action");
    expect(popupId).toBeTruthy();
    expect(document.getElementById(popupId!)).toBeInTheDocument();
    expect(document.getElementById(popupId!)).toHaveAttribute(
      "role",
      "tooltip"
    );
    expect(document.getElementById(popupId!)).toHaveTextContent(
      "Helpful detail"
    );

    await user.hover(trigger);
    expect(await screen.findByRole("tooltip", { name: "Helpful detail" })).toHaveAttribute(
      "id",
      popupId
    );

    rerender(
      <IconTooltip label="Updated detail">
        <button type="button" aria-label="Named action">
          Action
        </button>
      </IconTooltip>
    );
    expect(trigger).toHaveAttribute("aria-describedby", popupId);
    expect(trigger).toHaveAccessibleName("Named action");
  });

  it("preserves an existing described-by reference", () => {
    render(
      <IconTooltip label="Helpful detail">
        <button type="button" aria-label="Named action" aria-describedby="existing-help">
          Action
        </button>
      </IconTooltip>
    );

    expect(
      screen
        .getByRole("button", { name: "Named action" })
        .getAttribute("aria-describedby")
        ?.split(" ")
    ).toEqual(["existing-help", expect.any(String)]);
  });

  it("keeps unique mounted descriptions for multiple named triggers", () => {
    render(
      <>
        <IconTooltip label="First detail">
          <button type="button" aria-label="First action" />
        </IconTooltip>
        <IconTooltip label="Second detail">
          <button type="button" aria-label="Second action" />
        </IconTooltip>
      </>
    );

    const first = screen.getByRole("button", { name: "First action" });
    const second = screen.getByRole("button", { name: "Second action" });
    const firstId = first.getAttribute("aria-describedby");
    const secondId = second.getAttribute("aria-describedby");

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(document.getElementById(firstId!)).toHaveTextContent("First detail");
    expect(document.getElementById(secondId!)).toHaveTextContent("Second detail");
    expect(first).toHaveAccessibleName("First action");
    expect(second).toHaveAccessibleName("Second action");
  });
});
