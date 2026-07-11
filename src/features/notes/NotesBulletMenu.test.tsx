import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { NotesBulletMenu } from "./NotesBulletMenu";

function standardProps(
  overrides: Partial<ComponentProps<typeof NotesBulletMenu>> = {}
): ComponentProps<typeof NotesBulletMenu> {
  return {
    label: "Project",
    completed: false,
    starred: false,
    hasNote: false,
    saveFailed: false,
    onToggleComplete: vi.fn(),
    onToggleStar: vi.fn(),
    onOpenNote: vi.fn(),
    onAddDate: vi.fn(),
    onRemoveNote: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    onRetrySave: vi.fn(),
    ...overrides
  };
}

async function openMenu(user = userEvent.setup()) {
  const trigger = screen.getByRole("button", {
    name: "More actions for Project"
  });
  await user.click(trigger);
  return { menu: await screen.findByRole("menu"), trigger, user };
}

describe("NotesBulletMenu", () => {
  it("exposes one compact trigger and the standard bullet commands", async () => {
    render(<NotesBulletMenu {...standardProps()} />);

    const { menu, trigger } = await openMenu();
    expect(trigger).toHaveClass("notes-bullet-menu-trigger");
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Complete",
      "Star",
      "Add note",
      "Add date",
      "Duplicate",
      "Export subtree",
      "Delete"
    ]);
    expect(within(menu).queryByRole("menuitem", { name: "Restore" })).toBeNull();
  });

  it("start-aligns the popup to its left-rail trigger", async () => {
    render(<NotesBulletMenu {...standardProps()} />);

    const { menu, trigger } = await openMenu();

    expect(trigger).toHaveAttribute("data-popup-open");
    expect(menu.parentElement).toHaveAttribute("data-align", "start");
  });

  it("uses state-aware labels and invokes the matching commands", async () => {
    const props = standardProps({
      completed: true,
      starred: true,
      hasNote: true,
      saveFailed: true
    });
    const { rerender } = render(<NotesBulletMenu {...props} />);
    const { menu, user } = await openMenu();

    expect(within(menu).getByRole("menuitem", { name: "Uncomplete" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "Unstar" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "Edit note" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "Retry save" })).toBeVisible();

    await user.click(within(menu).getByRole("menuitem", { name: "Uncomplete" }));
    expect(props.onToggleComplete).toHaveBeenCalledOnce();

    rerender(<NotesBulletMenu {...props} />);
    const reopened = await openMenu(user);
    await user.click(
      within(reopened.menu).getByRole("menuitem", { name: "Edit note" })
    );
    expect(props.onOpenNote).toHaveBeenCalledOnce();
  });

  it("removes an existing note and returns focus to the menu trigger", async () => {
    const props = standardProps({ hasNote: true });
    render(<NotesBulletMenu {...props} />);
    const { menu, trigger, user } = await openMenu();

    expect(within(menu).getByRole("menuitem", { name: "Edit note" })).toBeVisible();
    await user.click(within(menu).getByRole("menuitem", { name: "Remove note" }));

    expect(props.onRemoveNote).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it.each([
    ["Markdown", "markdown"],
    ["PDF", "pdf"]
  ] as const)("offers real %s subtree export", async (label, format) => {
    const props = standardProps();
    render(<NotesBulletMenu {...props} />);
    const { menu, user } = await openMenu();

    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree" })
    );
    const exportItem = await screen.findByRole("menuitem", {
      name: `Export subtree as ${label}`
    });
    await user.click(exportItem);

    expect(props.onExport).toHaveBeenCalledWith(format);
  });

  it("moves focus into the export view and back to its parent command", async () => {
    const user = userEvent.setup();
    render(<NotesBulletMenu {...standardProps()} />);
    const trigger = screen.getByRole("button", {
      name: "More actions for Project"
    });
    trigger.focus();

    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Complete" })).toHaveFocus()
    );
    await user.keyboard(
      "{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}"
    );

    const back = await screen.findByRole("menuitem", { name: "Back" });
    await waitFor(() => expect(back).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitem", { name: "Export subtree as Markdown" })
    ).toHaveFocus();
    await user.keyboard("{ArrowUp}{Enter}");

    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: "Export subtree" })
      ).toHaveFocus()
    );
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<NotesBulletMenu {...standardProps()} />);
    const trigger = screen.getByRole("button", {
      name: "More actions for Project"
    });
    trigger.focus();

    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() =>
      expect(
        within(menu).getByRole("menuitem", { name: "Complete" })
      ).toHaveFocus()
    );
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("hands note focus off only after the popup reaches its closed state", async () => {
    const user = userEvent.setup();
    const onOpenNote = vi.fn(() => {
      expect(screen.getByRole("menu")).toHaveAttribute("data-closed");
      expect(screen.getByRole("menu")).not.toHaveAttribute("data-open");
      note.focus();
    });
    render(
      <>
        <NotesBulletMenu {...standardProps({ onOpenNote })} />
        <textarea aria-label="Supporting note" />
      </>
    );
    const trigger = screen.getByRole("button", {
      name: "More actions for Project"
    });
    const note = screen.getByRole("textbox", { name: "Supporting note" });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Add note"
      })
    );

    await waitFor(() => expect(onOpenNote).toHaveBeenCalledOnce());
    expect(note).toHaveFocus();
  });

  it("hands Add date off after closing and uses the Calendar icon", async () => {
    const user = userEvent.setup();
    const onAddDate = vi.fn(() => {
      expect(screen.getByRole("menu")).toHaveAttribute("data-closed");
    });
    render(<NotesBulletMenu {...standardProps({ onAddDate })} />);

    await user.click(
      screen.getByRole("button", { name: "More actions for Project" })
    );
    const item = within(await screen.findByRole("menu")).getByRole(
      "menuitem",
      { name: "Add date" }
    );
    expect(item.querySelector(".lucide-calendar")).not.toBeNull();

    await user.click(item);

    await waitFor(() => expect(onAddDate).toHaveBeenCalledOnce());
  });

  it("closes on an outside pointer press", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <NotesBulletMenu {...standardProps()} />
        <button type="button">Outside</button>
      </div>
    );
    await openMenu(user);

    await user.click(screen.getByRole("button", { name: "Outside" }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("keeps Trash rows limited to Restore", async () => {
    const onRestore = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesBulletMenu
        mode="trash"
        label="Project"
        disabled={false}
        onRestore={onRestore}
      />
    );

    const { menu } = await openMenu(user);
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    await user.click(within(menu).getByRole("menuitem", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("keeps archived roots limited to Unarchive and Move to Trash", async () => {
    const onUnarchive = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesBulletMenu
        mode="archive"
        label="Project"
        onUnarchive={onUnarchive}
        onDelete={onDelete}
      />
    );

    const { menu } = await openMenu(user);
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Unarchive", "Move to Trash"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Unarchive" }));
    expect(onUnarchive).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("disables the trigger when row commands are unavailable", () => {
    render(<NotesBulletMenu {...standardProps({ disabled: true })} />);
    expect(
      screen.getByRole("button", { name: "More actions for Project" })
    ).toBeDisabled();
  });
});
