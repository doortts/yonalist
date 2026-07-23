import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { NoteNode } from "../../domain/notes";
import {
  NotesMoveChooser,
  type NotesMoveChooserCommit
} from "./NotesMoveChooser";
import type { NotesFrozenSelectionSnapshot } from "./notesSelectionChooser";

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
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null
  };
}

interface TestOwnership {
  readonly vaultPath: string;
  readonly scopeKey: string;
  readonly generation: number;
}

const ownership: Readonly<TestOwnership> = Object.freeze({
  vaultPath: "/vault",
  scopeKey: "all",
  generation: 7
});

function frozenSnapshot(
  nodeIds: readonly string[] = Object.freeze(["selected"]),
  token: Readonly<TestOwnership> = ownership
): NotesFrozenSelectionSnapshot<Readonly<TestOwnership>> {
  return Object.freeze({ nodeIds, ownership: token });
}

function authoritativeNodes(): Readonly<Record<string, NoteNode>> {
  const nodes = [
    node({ id: "selected", title: "Selected" }),
    node({ id: "selected-child", parentId: "selected", title: "Hidden child" }),
    node({ id: "other", sortKey: 2048, title: "Other" }),
    node({ id: "other-child", parentId: "other", title: "Other child" }),
    node({ id: "archived", sortKey: 3072, title: "Archived", archivedAt: "2026-07-11T00:00:00Z" })
  ];
  return Object.fromEntries(nodes.map((item) => [item.id, item]));
}

describe("NotesMoveChooser", () => {
  it("shows searchable authoritative destinations outside every selected subtree", async () => {
    render(
      <NotesMoveChooser
        open
        snapshot={frozenSnapshot()}
        nodesById={authoritativeNodes()}
        onOpenChange={vi.fn()}
        onChoose={vi.fn()}
        onRequestFocusReturn={vi.fn()}
      />
    );

    const dialog = await screen.findByRole("dialog", { name: "Move selection" });
    expect(screen.getByRole("searchbox", { name: "Search destinations" }))
      .toHaveFocus();
    expect(
      within(dialog).getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["Top level", "Other", "Other child"]);
    expect(
      within(dialog).getAllByRole("option").map((option) => option.tabIndex)
    ).toEqual([-1, -1, -1]);
    expect(within(dialog).queryByText("Selected")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Hidden child")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Archived")).not.toBeInTheDocument();
  });

  it("filters destinations and commits the active option with Enter", async () => {
    const snapshot = frozenSnapshot();
    const onChoose = vi.fn<
      (commit: NotesMoveChooserCommit<Readonly<TestOwnership>>) => void
    >();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesMoveChooser
        open
        snapshot={snapshot}
        nodesById={authoritativeNodes()}
        onOpenChange={onOpenChange}
        onChoose={onChoose}
        onRequestFocusReturn={vi.fn()}
      />
    );

    const search = await screen.findByRole("searchbox", {
      name: "Search destinations"
    });
    await user.type(search, "child");
    expect(screen.getByRole("option", { name: "Other child" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Other" }))
      .not.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChoose).toHaveBeenCalledOnce();
    const commit = onChoose.mock.calls[0][0];
    expect(commit.destinationId).toBe("other-child");
    expect(commit.snapshot).toBe(snapshot);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the exact opening snapshot when props change while open", async () => {
    const opened = frozenSnapshot();
    const newer = frozenSnapshot(Object.freeze(["other"]), Object.freeze({
      vaultPath: "/other-vault",
      scopeKey: "recent",
      generation: 8
    }));
    const onChoose = vi.fn();
    const { rerender } = render(
      <NotesMoveChooser
        open
        snapshot={opened}
        nodesById={authoritativeNodes()}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onRequestFocusReturn={vi.fn()}
      />
    );
    await screen.findByRole("dialog", { name: "Move selection" });

    rerender(
      <NotesMoveChooser
        open
        snapshot={newer}
        nodesById={authoritativeNodes()}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onRequestFocusReturn={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("option", { name: "Other" }));

    expect(onChoose.mock.calls[0][0].snapshot).toBe(opened);
  });

  it("freezes destination identities for the open chooser session", async () => {
    const onChoose = vi.fn();
    const openedNodes = authoritativeNodes();
    const { rerender } = render(
      <NotesMoveChooser
        open
        snapshot={frozenSnapshot()}
        nodesById={openedNodes}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onRequestFocusReturn={vi.fn()}
      />
    );
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "Move selection" });
    await user.click(
      screen.getByRole("searchbox", { name: "Search destinations" })
    );

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: "Other" }))
      .toHaveAttribute("aria-selected", "true");
    const changedNodes = {
      ...openedNodes,
      inserted: node({ id: "inserted", sortKey: 1536, title: "Inserted" })
    };
    rerender(
      <NotesMoveChooser
        open
        snapshot={frozenSnapshot(Object.freeze(["other"]))}
        nodesById={changedNodes}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onRequestFocusReturn={vi.fn()}
      />
    );

    expect(screen.queryByRole("option", { name: "Inserted" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Other" }))
      .toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onChoose.mock.calls[0][0].destinationId).toBe("other");
  });

  it("renders loading and empty states without stale options", async () => {
    const onChoose = vi.fn();
    const { rerender } = render(
      <NotesMoveChooser
        open
        loading
        snapshot={frozenSnapshot()}
        nodesById={authoritativeNodes()}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onRequestFocusReturn={vi.fn()}
      />
    );
    expect(
      await screen.findByRole("status", { name: "Loading move destinations" })
    ).toBeVisible();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChoose).not.toHaveBeenCalled();

    rerender(
      <NotesMoveChooser
        open
        snapshot={frozenSnapshot()}
        nodesById={null}
        onOpenChange={vi.fn()}
        onChoose={vi.fn()}
        onRequestFocusReturn={vi.fn()}
      />
    );
    expect(screen.getByText("No destinations found")).toBeVisible();
  });

  it("closes on Escape and delegates focus restoration", async () => {
    const onRequestFocusReturn = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Open Move To
          </button>
          <NotesMoveChooser
            open={open}
            snapshot={frozenSnapshot()}
            nodesById={authoritativeNodes()}
            onOpenChange={setOpen}
            onChoose={vi.fn()}
            onRequestFocusReturn={() => {
              onRequestFocusReturn();
              triggerRef.current?.focus();
            }}
          />
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open Move To" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Move selection" });
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(onRequestFocusReturn).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("exposes a dialog focus ref for integration without owning mutations", async () => {
    const dialogRef = createRef<HTMLDivElement>();
    const onChoose = vi.fn();
    render(
      <NotesMoveChooser
        ref={dialogRef}
        open
        snapshot={frozenSnapshot()}
        nodesById={authoritativeNodes()}
        onOpenChange={vi.fn()}
        onChoose={onChoose}
        onRequestFocusReturn={vi.fn()}
      />
    );

    expect(await screen.findByRole("dialog", { name: "Move selection" }))
      .toBe(dialogRef.current);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
