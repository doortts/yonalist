import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { NotesLibraryPageRow } from "./NotesLibraryPageRow";

const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8"
);

function node(overrides: Partial<NoteNode> = {}): NoteNode {
  return {
    id: "page",
    nodeKind: "text",
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
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet"
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
    onExport: vi.fn(),
    onRename: vi.fn().mockResolvedValue(true)
  };
}

describe("NotesLibraryPageRow", () => {
  it("uses square corners for the selected row and keeps the straight inset accent", () => {
    expect(notesStyles).toMatch(
      /\.notes-library-page-row\[data-active="true"\]\s*\{[^}]*border-radius:\s*0;[^}]*background:\s*var\(--list-selected-bg\);[^}]*box-shadow:\s*var\(--list-selected-shadow\);/s
    );
    expect(notesStyles).toMatch(
      /\.notes-library-page-row\s*\{[^}]*border-radius:\s*var\(--radius\);/s
    );
  });

  it("opens an inactive page before a second click on the selected row starts rename", async () => {
    const user = userEvent.setup();
    const props = callbacks();
    const { rerender } = render(
      <NotesLibraryPageRow
        node={node({ title: "Project" })}
        mode="active"
        active={false}
        {...props}
      />
    );

    await user.click(screen.getByRole("button", { name: "Project" }));
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    rerender(
      <NotesLibraryPageRow
        node={node({ title: "Project" })}
        mode="active"
        active
        {...props}
      />
    );
    await user.click(screen.getByRole("button", { name: "Project" }));
    const input = screen.getByRole("textbox", { name: "Rename Project" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Project");
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", "Project".length);
    expect(props.onOpen).toHaveBeenCalledOnce();
  });

  it("commits a changed title exactly once with Enter", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    let resolveRename!: (saved: boolean) => void;
    handlers.onRename.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRename = resolve;
        })
    );
    render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    await user.click(screen.getByRole("button", { name: "Project plan" }));
    const input = screen.getByRole("textbox", {
      name: "Rename Project plan"
    });
    await user.clear(input);
    await user.type(input, "Renamed");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    expect(handlers.onRename).toHaveBeenCalledOnce();
    expect(handlers.onRename).toHaveBeenCalledWith("Renamed");
    await act(async () => resolveRename(true));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("commits a changed title exactly once on blur", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    await user.click(screen.getByRole("button", { name: "Project plan" }));
    const input = screen.getByRole("textbox", {
      name: "Rename Project plan"
    });
    await user.clear(input);
    await user.type(input, "Renamed");
    await user.tab();

    await waitFor(() => expect(handlers.onRename).toHaveBeenCalledOnce());
    expect(handlers.onRename).toHaveBeenCalledWith("Renamed");
  });

  it("cancels with Escape without committing on the resulting blur", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    await user.click(screen.getByRole("button", { name: "Project plan" }));
    const input = screen.getByRole("textbox", {
      name: "Rename Project plan"
    });
    await user.clear(input);
    await user.type(input, "Discard me{Escape}");

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project plan" })).toBeVisible();
    expect(handlers.onRename).not.toHaveBeenCalled();
  });

  it("does not commit Enter while Korean IME composition is active", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    await user.click(screen.getByRole("button", { name: "Project plan" }));
    const input = screen.getByRole("textbox", {
      name: "Rename Project plan"
    });
    fireEvent.change(input, { target: { value: "프로젝트" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(input).toHaveValue("프로젝트");
    expect(input).toHaveFocus();
  });

  it.each([
    ["Korean", "프로젝트"],
    ["Japanese", "プロジェクト"]
  ])(
    "does not cancel Escape while %s IME composition is active",
    async (_language, composedTitle) => {
      const user = userEvent.setup();
      const handlers = callbacks();
      render(
        <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
      );

      await user.click(screen.getByRole("button", { name: "Project plan" }));
      const input = screen.getByRole("textbox", {
        name: "Rename Project plan"
      });
      fireEvent.change(input, { target: { value: composedTitle } });
      fireEvent.keyDown(input, { key: "Escape", isComposing: true });

      expect(handlers.onRename).not.toHaveBeenCalled();
      expect(input).toHaveValue(composedTitle);
      expect(input).toHaveFocus();
    }
  );

  it("keeps the typed title editable when saving fails", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    handlers.onRename.mockResolvedValue(false);
    render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    await user.click(screen.getByRole("button", { name: "Project plan" }));
    const input = screen.getByRole("textbox", {
      name: "Rename Project plan"
    });
    await user.clear(input);
    await user.type(input, "Retry me{Enter}");

    await waitFor(() => expect(handlers.onRename).toHaveBeenCalledOnce());
    expect(input).toHaveValue("Retry me");
    expect(input).toBeInTheDocument();
  });

  it("retries a visible failed title draft that differs from the committed title", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    handlers.onRename.mockResolvedValue(false);
    render(
      <NotesLibraryPageRow
        node={node({ title: "Project plan" })}
        displayTitle="Retry me"
        mode="active"
        active
        {...handlers}
      />
    );

    await user.click(screen.getByRole("button", { name: "Retry me" }));
    const input = screen.getByRole("textbox", { name: "Rename Retry me" });
    await user.type(input, "{Enter}");

    await waitFor(() => expect(handlers.onRename).toHaveBeenCalledOnce());
    expect(handlers.onRename).toHaveBeenCalledWith("Retry me");
    expect(input).toHaveValue("Retry me");
    expect(input).not.toHaveAttribute("readonly");
  });

  it("keeps an unchanged title from a note-only draft as a no-op", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow
        node={node({ title: "Project plan" })}
        displayTitle="Project plan"
        mode="active"
        active
        {...handlers}
      />
    );

    await user.click(screen.getByRole("button", { name: "Project plan" }));
    await user.type(
      screen.getByRole("textbox", { name: "Rename Project plan" }),
      "{Enter}"
    );

    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it.each(["Enter", "blur"] as const)(
    "commits a revert from a divergent failed draft exactly once with %s",
    async (commitMethod) => {
      const user = userEvent.setup();
      const handlers = callbacks();
      let resolveRename!: (saved: boolean) => void;
      handlers.onRename.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRename = resolve;
          })
      );
      render(
        <NotesLibraryPageRow
          node={node({ title: "Project" })}
          displayTitle="Renamed"
          mode="active"
          active
          {...handlers}
        />
      );

      await user.click(screen.getByRole("button", { name: "Renamed" }));
      const input = screen.getByRole("textbox", { name: "Rename Renamed" });
      await user.clear(input);
      await user.type(input, "Project");

      if (commitMethod === "Enter") {
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.blur(input);
      } else {
        fireEvent.blur(input);
      }

      expect(handlers.onRename).toHaveBeenCalledOnce();
      expect(handlers.onRename).toHaveBeenCalledWith("Project");
      await act(async () => resolveRename(true));
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    }
  );

  it.each([
    ["rejects", () => Promise.reject(new Error("rename rejected"))],
    [
      "throws",
      () => {
        throw new Error("rename threw");
      }
    ]
  ])(
    "keeps the editor usable without an unhandled rejection when onRename %s",
    async (_failureMode, rename) => {
      const user = userEvent.setup();
      const handlers = callbacks();
      handlers.onRename.mockImplementation(rename);
      render(
        <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
      );

      await user.click(screen.getByRole("button", { name: "Project plan" }));
      const input = screen.getByRole("textbox", {
        name: "Rename Project plan"
      });
      await user.clear(input);
      await user.type(input, "Retry me{Enter}");

      await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
      expect(handlers.onRename).toHaveBeenCalledOnce();
      expect(input).toHaveValue("Retry me");
      expect(input).toHaveFocus();
    }
  );

  it("commits whitespace titles unchanged and presents them as Untitled page", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const { rerender } = render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    await user.click(screen.getByRole("button", { name: "Project plan" }));
    const input = screen.getByRole("textbox", {
      name: "Rename Project plan"
    });
    await user.clear(input);
    await user.type(input, "   {Enter}");
    await waitFor(() => expect(handlers.onRename).toHaveBeenCalledWith("   "));

    rerender(
      <NotesLibraryPageRow
        node={node({ title: "   " })}
        mode="active"
        active
        {...handlers}
      />
    );
    expect(screen.getByRole("button", { name: "Untitled page" })).toBeVisible();
  });

  it("keeps the action menu isolated from selected-row rename", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    await user.click(
      screen.getByRole("button", { name: "Page actions for Project plan" })
    );

    expect(await screen.findByRole("menu")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it("uses the owned filename when an image has no primary text", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const props = {
      node: node({ nodeKind: "image", title: "", imageOffsetUtf16: 0 }),
      imageAttachmentOriginalName: "fallback.png",
      mode: "active" as const,
      active: true,
      ...handlers
    } satisfies Parameters<typeof NotesLibraryPageRow>[0];
    render(
      <NotesLibraryPageRow {...props} />
    );

    const selection = screen.getByRole("button", {
      name: "Image: fallback.png"
    });
    expect(within(selection).getByText("fallback.png")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Page actions for Image: fallback.png"
      })
    ).toBeVisible();

    await user.click(selection);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(handlers.onRename).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "Page actions for Image: fallback.png"
      })
    );
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Move to Trash" }));
    const dialog = screen.getByRole("alertdialog", {
      name: "Move page to Trash?"
    });
    expect(dialog).toHaveTextContent(
      "Move fallback.png and all of its descendants to Trash?"
    );
  });

  it.each(["active", "archive", "trash"] as const)(
    "uses the owned filename fallback in a %s library row",
    (mode) => {
      const props = {
        node: node({ nodeKind: "image", title: "", imageOffsetUtf16: 0 }),
        imageAttachmentOriginalName: "fallback.png",
        mode,
        active: false,
        ...callbacks()
      } satisfies Parameters<typeof NotesLibraryPageRow>[0];
      render(
        <NotesLibraryPageRow {...props} />
      );

      const selection = screen.getByRole("button", {
        name: "Image: fallback.png"
      });
      expect(within(selection).getByText("fallback.png")).toBeVisible();
      expect(
        screen.getByRole("button", {
          name: "Page actions for Image: fallback.png"
        })
      ).toBeVisible();
    }
  );

  it("discards rename mode when the row stops being selected", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const { rerender } = render(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );
    await user.click(screen.getByRole("button", { name: "Project plan" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    rerender(
      <NotesLibraryPageRow
        node={node()}
        mode="active"
        active={false}
        {...handlers}
      />
    );
    rerender(
      <NotesLibraryPageRow node={node()} mode="active" active {...handlers} />
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project plan" })).toBeVisible();
  });

  it.each(["archive", "trash"] as const)(
    "keeps selected %s rows read-only",
    async (mode) => {
      const user = userEvent.setup();
      const handlers = callbacks();
      render(
        <NotesLibraryPageRow node={node()} mode={mode} active {...handlers} />
      );

      await user.click(screen.getByRole("button", { name: "Project plan" }));

      expect(handlers.onOpen).toHaveBeenCalledOnce();
      expect(handlers.onRename).not.toHaveBeenCalled();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    }
  );

  it("keeps page selection and menu activation as separate controls", async () => {
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

    const selection = screen.getByRole("button", { name: "Project plan" });
    const menuTrigger = screen.getByRole("button", {
      name: "Page actions for Project plan"
    });
    expect(selection.contains(menuTrigger)).toBe(false);
    expect(selection).not.toHaveAttribute("aria-current");

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
