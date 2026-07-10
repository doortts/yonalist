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
});
