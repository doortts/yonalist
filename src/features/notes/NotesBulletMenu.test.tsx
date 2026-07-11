import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { NoteNode } from "../../domain/notes";
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  type NotesMoveDestination,
  NotesBulletMenu
} from "./NotesBulletMenu";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function standardProps(
  overrides: Partial<ComponentProps<typeof NotesBulletMenu>> = {}
): ComponentProps<typeof NotesBulletMenu> {
  return {
    label: "Project",
    completed: false,
    starred: false,
    hasNote: false,
    saveFailed: false,
    createdAt: "2026-07-10T08:30:00Z",
    updatedAt: "2026-07-11T09:45:00Z",
    formatTimestamp: (value) => `formatted:${value}`,
    moveDestinations: [
      { id: null, label: "Top level", depth: 0 },
      { id: "planning", label: "Planning", depth: 0 },
      { id: "archive", label: "Archive candidate", depth: 1 }
    ],
    onMoveTo: vi.fn(),
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    onSortAscending: vi.fn(),
    onSortDescending: vi.fn(),
    onToggleComplete: vi.fn(),
    onToggleStar: vi.fn(),
    onOpenNote: vi.fn(),
    onAddDate: vi.fn(),
    onUploadImage: vi.fn(),
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
  it("excludes the moving subtree and inactive lifecycle nodes from destinations", () => {
    const nodes = [
      node({ id: "moving", title: "Moving" }),
      node({ id: "child", parentId: "moving", title: "Child" }),
      node({ id: "grandchild", parentId: "child", title: "Grandchild" }),
      node({ id: "other", sortKey: 2048, title: "Other" }),
      node({ id: "other-child", parentId: "other", title: "Other child" }),
      node({ id: "archived", sortKey: 3072, archivedAt: "2026-07-11T00:00:00Z" }),
      node({ id: "deleted", sortKey: 4096, deletedAt: "2026-07-11T00:00:00Z" })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(buildNotesMoveDestinations(nodesById, "moving")).toEqual([
      { id: null, label: "Top level", depth: 0 },
      { id: "other", label: "Other", depth: 0 },
      { id: "other-child", label: "Other child", depth: 1 }
    ]);
  });

  it("builds deterministic append moves and skips an already-last sibling", () => {
    const nodes = [
      node({ id: "source-parent" }),
      node({ id: "moving", parentId: "source-parent", sortKey: 1024 }),
      node({ id: "source-last", parentId: "source-parent", sortKey: 2048 }),
      node({ id: "target", sortKey: 2048 }),
      node({ id: "target-last", parentId: "target", sortKey: 1024 })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(buildNotesMoveNodeInput(nodesById, "moving", "target")).toEqual({
      id: "moving",
      parentId: "target",
      afterId: "target-last"
    });
    expect(buildNotesMoveNodeInput(nodesById, "source-last", "source-parent"))
      .toBeNull();
    expect(buildNotesMoveNodeInput(nodesById, "moving", "source-parent"))
      .toEqual({
        id: "moving",
        parentId: "source-parent",
        afterId: "source-last"
      });
  });

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
      "Upload image",
      "Move To...",
      "Expand all",
      "Collapse all",
      "Sort A-Z",
      "Sort Z-A",
      "Duplicate",
      "Export subtree",
      "Delete"
    ]);
    expect(within(menu).getByText("Created formatted:2026-07-10T08:30:00Z"))
      .toBeVisible();
    expect(within(menu).getByText("Changed formatted:2026-07-11T09:45:00Z"))
      .toBeVisible();
    expect(within(menu).queryByRole("menuitem", { name: "Restore" })).toBeNull();
  });

  it("opens a searchable Move To chooser and commits the keyboard selection", async () => {
    const props = standardProps();
    const user = userEvent.setup();
    render(<NotesBulletMenu {...props} />);
    const { menu, trigger } = await openMenu(user);

    await user.click(within(menu).getByRole("menuitem", { name: "Move To..." }));
    const search = await screen.findByRole("searchbox", {
      name: "Search move destinations"
    });
    expect(search).toHaveFocus();

    await user.type(search, "plan");
    expect(screen.getByRole("option", { name: "Planning" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Archive candidate" }))
      .not.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onMoveTo).toHaveBeenCalledOnce();
    expect(props.onMoveTo).toHaveBeenCalledWith("planning");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("loads Move To destinations on demand", async () => {
    let resolveDestinations!: (
      value: readonly NotesMoveDestination[]
    ) => void;
    const getMoveDestinations = vi.fn(
      () => new Promise<readonly NotesMoveDestination[]>(
        (resolve) => { resolveDestinations = resolve; }
      )
    );
    const user = userEvent.setup();
    render(
      <NotesBulletMenu
        {...standardProps({
          moveDestinations: [],
          getMoveDestinations
        })}
      />
    );
    const { menu } = await openMenu(user);

    await user.click(within(menu).getByRole("menuitem", { name: "Move To..." }));
    expect(getMoveDestinations).toHaveBeenCalledOnce();
    expect(screen.getByRole("status", { name: "Loading move destinations" }))
      .toBeVisible();

    resolveDestinations([{ id: "inbox", label: "Inbox", depth: 0 }]);
    expect(await screen.findByRole("option", { name: "Inbox" })).toBeVisible();
  });

  it("returns from Move To with Escape and restores focus to its parent command", async () => {
    const user = userEvent.setup();
    render(<NotesBulletMenu {...standardProps()} />);
    const { menu } = await openMenu(user);

    await user.click(within(menu).getByRole("menuitem", { name: "Move To..." }));
    const search = await screen.findByRole("searchbox", {
      name: "Search move destinations"
    });
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Move To..." })).toHaveFocus()
    );
    expect(search).not.toBeInTheDocument();
  });

  it("invokes subtree actions once while their command is busy", async () => {
    let resolveExpand!: () => void;
    const onExpandAll = vi.fn(
      () => new Promise<void>((resolve) => { resolveExpand = resolve; })
    );
    const user = userEvent.setup();
    render(
      <NotesBulletMenu
        {...standardProps({ onExpandAll, actionBusy: true })}
      />
    );
    const { menu } = await openMenu(user);

    const expand = within(menu).getByRole("menuitem", { name: "Expand all" });
    expect(expand).toHaveAttribute("data-disabled");
    await user.dblClick(expand);
    expect(onExpandAll).not.toHaveBeenCalled();
    resolveExpand?.();
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
      "{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}"
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

  it("uploads an image from the writable menu with an image upload icon", async () => {
    const onUploadImage = vi.fn();
    const user = userEvent.setup();
    render(<NotesBulletMenu {...standardProps({ onUploadImage })} />);

    const { menu } = await openMenu(user);
    const item = within(menu).getByRole("menuitem", { name: "Upload image" });
    expect(item.querySelector(".lucide-image-up")).not.toBeNull();

    await user.click(item);

    expect(onUploadImage).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
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
