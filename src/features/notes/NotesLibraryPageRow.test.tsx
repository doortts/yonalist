import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { NotesLibraryPageRow } from "./NotesLibraryPageRow";

function node(overrides: Partial<NoteNode> = {}): NoteNode {
  return {
    id: "page",
    parentId: null,
    sortKey: 1,
    title: "Project plan",
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function callbacks() {
  return {
    onOpen: vi.fn(),
    onToggleStar: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onRestore: vi.fn(),
    onMoveToTrash: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn()
  };
}

describe("NotesLibraryPageRow", () => {
  it("keeps page selection and menu activation as separate controls", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow
        node={node()}
        mode="active"
        active
        {...handlers}
      />
    );

    const selection = screen.getByRole("button", { name: "Project plan" });
    const menuTrigger = screen.getByRole("button", {
      name: "Page actions for Project plan"
    });
    expect(selection.contains(menuTrigger)).toBe(false);
    expect(selection).toHaveAttribute("aria-current", "page");

    await user.click(selection);
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    expect(handlers.onToggleStar).not.toHaveBeenCalled();

    await user.click(menuTrigger);
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Open",
      "Star",
      "Archive",
      "Move to Trash",
      "Duplicate",
      "Export"
    ]);
  });

  it("uses state-aware star copy and exposes both export formats", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow
        node={node({ isStarred: true })}
        mode="active"
        active={false}
        {...handlers}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Page actions for Project plan" })
    );
    const starMenu = await screen.findByRole("menu");
    await user.click(within(starMenu).getByRole("menuitem", { name: "Unstar" }));
    expect(handlers.onToggleStar).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "Page actions for Project plan" })
    );
    const exportMenu = await screen.findByRole("menu");
    await user.click(within(exportMenu).getByRole("menuitem", { name: "Export" }));
    const menu = screen.getByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export as Markdown" })
    );
    expect(handlers.onExport).toHaveBeenCalledWith("markdown");
  });

  it("confirms that descendants move with a root page before trashing it", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow
        node={node()}
        mode="active"
        active={false}
        {...handlers}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Page actions for Project plan" })
    );
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Move to Trash" }));
    expect(handlers.onMoveToTrash).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog", {
      name: "Move page to Trash?"
    });
    expect(dialog).toHaveTextContent(
      "Move Project plan and all of its descendants to Trash?"
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Move to Trash" })
    );
    expect(handlers.onMoveToTrash).toHaveBeenCalledOnce();
  });

  it("limits archived rows to Unarchive and Move to Trash", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow
        node={node({
          archivedAt: "2026-07-11T01:00:00Z",
          archiveRootId: "page"
        })}
        mode="archive"
        active={false}
        {...handlers}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Page actions for Project plan" })
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Unarchive", "Move to Trash"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Unarchive" }));
    expect(handlers.onUnarchive).toHaveBeenCalledOnce();
  });

  it("exposes Restore from the trash row action menu by keyboard", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow
        node={node({ deletedAt: "2026-07-11T02:00:00Z" })}
        mode="trash"
        active
        {...handlers}
      />
    );

    const selection = screen.getByRole("button", { name: "Project plan" });
    const trigger = screen.getByRole("button", {
      name: "Page actions for Project plan"
    });
    expect(selection.nextElementSibling).toBe(trigger);

    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Restore"]);
    await waitFor(() => expect(items[0]).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(handlers.onRestore).toHaveBeenCalledOnce();
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it("returns focus to the menu trigger when the menu closes", async () => {
    const user = userEvent.setup();
    render(
      <NotesLibraryPageRow
        node={node()}
        mode="active"
        active={false}
        {...callbacks()}
      />
    );
    const trigger = screen.getByRole("button", {
      name: "Page actions for Project plan"
    });

    await user.click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to Export when leaving the export submenu", async () => {
    const user = userEvent.setup();
    render(
      <NotesLibraryPageRow
        node={node()}
        mode="active"
        active={false}
        {...callbacks()}
      />
    );
    await user.click(
      screen.getByRole("button", { name: "Page actions for Project plan" })
    );
    const menu = await screen.findByRole("menu");
    const exportItem = within(menu).getByRole("menuitem", { name: "Export" });
    await user.click(exportItem);
    const back = await within(menu).findByRole("menuitem", { name: "Back" });
    await waitFor(() => expect(back).toHaveFocus());

    await user.click(back);

    await waitFor(() =>
      expect(
        within(menu).getByRole("menuitem", { name: "Export" })
      ).toHaveFocus()
    );
  });
});
