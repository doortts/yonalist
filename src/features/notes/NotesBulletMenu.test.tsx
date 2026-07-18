import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { NoteNode } from "../../domain/notes";
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  type NotesMoveDestination,
  NotesBulletMenu,
  type NotesBulletMenuSelectionBridge,
  type NotesBulletMenuSelectionState
} from "./NotesBulletMenu";
import type { NotesSelectionActionSnapshot } from "./notesSelectionActions";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
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
    imageOffsetUtf16: 0,
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

function eligible(nodeIds: readonly string[] = ["a"]) {
  return { eligible: true as const, nodeIds };
}

function selectionSnapshot(
  overrides: Partial<NotesSelectionActionSnapshot> = {}
): NotesSelectionActionSnapshot {
  const nodeIds = ["a"];
  return {
    selection: { anchorId: "a", headId: "a" },
    selectedNodeIds: nodeIds,
    structuralRootIds: nodeIds,
    completion: "none",
    deleteFocusNodeId: "tail",
    eligibility: {
      copy: eligible(nodeIds),
      cut: eligible(nodeIds),
      delete: eligible(nodeIds),
      duplicate: eligible(nodeIds),
      indent: eligible(nodeIds),
      outdent: eligible(nodeIds),
      moveUp: {
        ...eligible(nodeIds),
        target: { parentId: null, afterId: null, beforeId: "previous" }
      },
      moveDown: {
        ...eligible(nodeIds),
        target: { parentId: null, afterId: "next" }
      },
      moveTo: eligible(nodeIds)
    },
    ...overrides
  };
}

function createSelectionBridge(
  initialState: NotesBulletMenuSelectionState = {
    snapshot: selectionSnapshot()
  },
  handlers: {
    execute?: NotesBulletMenuSelectionBridge["execute"];
    requestChooser?: NotesBulletMenuSelectionBridge["requestChooser"];
  } = {}
) {
  let state = initialState;
  const listeners = new Set<() => void>();
  const execute = vi.fn(handlers.execute ?? (() => undefined));
  const requestChooser = vi.fn(
    handlers.requestChooser ?? (() => undefined)
  );
  const bridge: NotesBulletMenuSelectionBridge = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    execute,
    requestChooser
  };

  return {
    bridge,
    execute,
    requestChooser,
    update(nextState: NotesBulletMenuSelectionState) {
      state = nextState;
      act(() => {
        listeners.forEach((listener) => listener());
      });
    }
  };
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

  it("uses a neutral move destination for image nodes without changing text labels", () => {
    const nodes = [
      node({ id: "moving", title: "Moving" }),
      node({ id: "image", nodeKind: "image", title: "private-image.png" }),
      node({ id: "text", sortKey: 2048, title: "Visible text" })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(buildNotesMoveDestinations(nodesById, "moving")).toEqual([
      { id: null, label: "Top level", depth: 0 },
      { id: "image", label: "Image", depth: 0 },
      { id: "text", label: "Visible text", depth: 0 }
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

  it("keeps Move To open and announces a rejected stale destination", async () => {
    const onMoveTo = vi.fn().mockResolvedValue({
      ok: false,
      error: "That destination is no longer active. Refresh Move To."
    });
    const user = userEvent.setup();
    render(<NotesBulletMenu {...standardProps({ onMoveTo })} />);
    const { menu } = await openMenu(user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Move To..." })
    );
    const search = await screen.findByRole("searchbox", {
      name: "Search move destinations"
    });

    await user.click(screen.getByRole("option", { name: "Planning" }));

    expect(onMoveTo).toHaveBeenCalledWith("planning");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That destination is no longer active"
    );
    expect(screen.getByRole("menu")).toBeVisible();
    expect(search).toHaveFocus();
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

  it("disables already-open export leaves when export becomes unavailable", async () => {
    const props = standardProps();
    const { rerender } = render(<NotesBulletMenu {...props} />);
    const { menu, user } = await openMenu();
    await user.click(
      within(menu).getByRole("menuitem", { name: "Export subtree" })
    );

    rerender(<NotesBulletMenu {...props} exportDisabled />);

    const markdown = screen.getByRole("menuitem", {
      name: "Export subtree as Markdown"
    });
    const pdf = screen.getByRole("menuitem", {
      name: "Export subtree as PDF"
    });
    expect(markdown).toHaveAttribute("aria-disabled", "true");
    expect(pdf).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(markdown);
    fireEvent.click(pdf);
    expect(props.onExport).not.toHaveBeenCalled();
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

  it("shows only selected-range commands for a one-row range and uses the aggregate completion label", async () => {
    const snapshot = selectionSnapshot({ completion: "all" });
    const selection = createSelectionBridge({ snapshot });
    render(
      <NotesBulletMenu
        {...standardProps()}
        selectionBridge={selection.bridge}
      />
    );

    const { menu } = await openMenu();

    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Uncomplete",
      "Move To",
      "Move up",
      "Move down",
      "Indent",
      "Outdent",
      "Duplicate",
      "Tags",
      "Copy",
      "Cut",
      "Delete"
    ]);
    expect(within(menu).queryByRole("menuitem", { name: "Star" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Add note" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Add date" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Upload image" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Sort A-Z" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Expand all" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Export subtree" })).toBeNull();
    expect(within(menu).queryByText(/^Created /)).toBeNull();
  });

  it("uses snapshot eligibility reasons as accessible disabled explanations", async () => {
    const moveReason = "The selection is already first among its siblings.";
    const cutReason = "Cut would remove supporting notes. Use Move To instead.";
    const base = selectionSnapshot();
    const selection = createSelectionBridge({
      snapshot: {
        ...base,
        eligibility: {
          ...base.eligibility,
          moveUp: { eligible: false, reason: moveReason },
          cut: { eligible: false, reason: cutReason }
        }
      }
    });
    render(
      <NotesBulletMenu
        label="Project"
        selectionBridge={selection.bridge}
      />
    );

    const { menu } = await openMenu();
    const moveUp = within(menu).getByRole("menuitem", { name: "Move up" });
    const cut = within(menu).getByRole("menuitem", { name: "Cut" });

    expect(moveUp).toHaveAttribute("aria-disabled", "true");
    expect(moveUp).toHaveAccessibleDescription(moveReason);
    expect(cut).toHaveAttribute("aria-disabled", "true");
    expect(cut).toHaveAccessibleDescription(cutReason);
  });

  it("maps every direct selected-range command to the stable bridge executor", async () => {
    const selection = createSelectionBridge();
    const user = userEvent.setup();
    render(
      <NotesBulletMenu
        label="Project"
        selectionBridge={selection.bridge}
      />
    );
    const commands = [
      ["Complete", "toggleComplete"],
      ["Move up", "moveUp"],
      ["Move down", "moveDown"],
      ["Indent", "indent"],
      ["Outdent", "outdent"],
      ["Duplicate", "duplicate"],
      ["Copy", "copy"],
      ["Cut", "cut"],
      ["Delete", "delete"]
    ] as const;

    for (const [label, action] of commands) {
      const { menu } = await openMenu(user);
      await user.click(within(menu).getByRole("menuitem", { name: label }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(selection.execute).toHaveBeenLastCalledWith(action);
    }
    expect(selection.execute).toHaveBeenCalledTimes(commands.length);
  });

  it.each([
    ["Move To", "move"],
    ["Tags", "tags"]
  ] as const)(
    "closes before handing %s focus to the parent chooser",
    async (label, chooser) => {
      const onOpenChange = vi.fn();
      const chooserFocus = vi.fn(() => {
        expect(screen.getByRole("menu")).toHaveAttribute("data-closed");
        screen.getByRole("button", { name: "Chooser focus" }).focus();
      });
      const selection = createSelectionBridge(undefined, {
        requestChooser: chooserFocus
      });
      const user = userEvent.setup();
      render(
        <>
          <NotesBulletMenu
            label="Project"
            selectionBridge={selection.bridge}
            onOpenChange={onOpenChange}
          />
          <button type="button">Chooser focus</button>
        </>
      );

      const { menu } = await openMenu(user);
      await user.click(within(menu).getByRole("menuitem", { name: label }));

      await waitFor(() =>
        expect(selection.requestChooser).toHaveBeenCalledWith(chooser)
      );
      expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
      expect(selection.execute).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Chooser focus" })).toHaveFocus();
    }
  );

  it("updates selected-range presentation through one stable bridge without rerendering its parent", async () => {
    const selection = createSelectionBridge();
    const bridgeIdentity = selection.bridge;
    const parentRender = vi.fn();
    const moveReason = "The selection is already first among its siblings.";
    const updatedBase = selectionSnapshot({ completion: "all" });
    const updatedSnapshot: NotesSelectionActionSnapshot = {
      ...updatedBase,
      eligibility: {
        ...updatedBase.eligibility,
        moveUp: { eligible: false, reason: moveReason }
      }
    };
    function StableBridgeParent() {
      parentRender();
      return (
        <NotesBulletMenu
          label="Project"
          selectionBridge={selection.bridge}
        />
      );
    }

    render(<StableBridgeParent />);
    const { menu } = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Complete" }))
      .not.toHaveAttribute("aria-disabled", "true");

    selection.update({ snapshot: updatedSnapshot });

    expect(selection.bridge).toBe(bridgeIdentity);
    expect(parentRender).toHaveBeenCalledOnce();
    expect(within(menu).getByRole("menuitem", { name: "Uncomplete" }))
      .toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "Move up" }))
      .toHaveAccessibleDescription(moveReason);

    selection.update({ snapshot: updatedSnapshot, busy: true });

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .every((item) => item.getAttribute("aria-disabled") === "true")
    ).toBe(true);
    expect(parentRender).toHaveBeenCalledOnce();
  });

  it("blocks selected-range activation while externally busy", async () => {
    const selection = createSelectionBridge({
      snapshot: selectionSnapshot(),
      busy: true
    });
    render(
      <NotesBulletMenu
        label="Project"
        selectionBridge={selection.bridge}
      />
    );

    const { menu } = await openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(11);
    expect(items.every((item) => item.getAttribute("aria-disabled") === "true"))
      .toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Complete" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move To" }));
    expect(selection.execute).not.toHaveBeenCalled();
    expect(selection.requestChooser).not.toHaveBeenCalled();
  });

  it("submits a direct selected-range command once before the busy snapshot can settle", async () => {
    let resolveAction!: () => void;
    const selection = createSelectionBridge(undefined, {
      execute: () => new Promise<void>((resolve) => { resolveAction = resolve; })
    });
    render(
      <NotesBulletMenu
        label="Project"
        selectionBridge={selection.bridge}
      />
    );

    const { menu } = await openMenu();
    const complete = within(menu).getByRole("menuitem", { name: "Complete" });
    fireEvent.click(complete);
    fireEvent.click(complete);

    expect(selection.execute).toHaveBeenCalledOnce();
    resolveAction();
  });
});
