import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { notesSlashCommandDefinitions } from "./notesSlashCommands";
import { NotesSlashCommandMenu } from "./NotesSlashCommandMenu";

describe("NotesSlashCommandMenu", () => {
  it("renders an accessible active option and selects it without pointer blur", () => {
    const anchor = document.createElement("textarea");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      x: 24,
      y: 40,
      top: 40,
      right: 224,
      bottom: 64,
      left: 24,
      width: 200,
      height: 24,
      toJSON: () => ({})
    });
    const onSelect = vi.fn();

    try {
      render(
        <NotesSlashCommandMenu
          anchor={anchor}
          commands={notesSlashCommandDefinitions}
          activeIndex={0}
          menuId="test-slash-menu"
          onSelect={onSelect}
        />
      );

      expect(
        screen.getByRole("listbox", { name: "Slash commands" })
      ).toBeInTheDocument();
      const option = screen.getByRole("option", { name: /Today/ });
      expect(option).toHaveAttribute("aria-selected", "true");
      expect(option).toHaveAttribute("tabindex", "-1");
      expect(option).toHaveTextContent("Insert today's date");
      expect(fireEvent.pointerDown(option)).toBe(false);
      fireEvent.click(option);
      expect(onSelect).toHaveBeenCalledWith("today");
    } finally {
      anchor.remove();
    }
  });
});
