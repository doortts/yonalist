import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { NoteSearchTag } from "../../domain/notes";
import {
  NotesTagChooser,
  type NotesTagChooserCommit,
  type NotesTagChooserProps
} from "./NotesTagChooser";
import type { NotesFrozenSelectionSnapshot } from "./notesSelectionChooser";

interface TestOwnership {
  readonly vaultPath: string;
  readonly scopeKey: string;
  readonly generation: number;
}

const ownership: Readonly<TestOwnership> = Object.freeze({
  vaultPath: "/vault",
  scopeKey: "all",
  generation: 11
});
const openedSnapshot: NotesFrozenSelectionSnapshot<Readonly<TestOwnership>> =
  Object.freeze({
    nodeIds: Object.freeze(["one", "two"]),
    ownership
  });

const suggestions: readonly NoteSearchTag[] = Object.freeze([
  Object.freeze({ prefix: "#", normalizedTag: "work", displayTag: "Work" }),
  Object.freeze({ prefix: "@", normalizedTag: "alice", displayTag: "Alice" }),
  Object.freeze({ prefix: "#", normalizedTag: "other", displayTag: "Other" })
]);

const selectedTagUnion: readonly NoteSearchTag[] = Object.freeze([
  suggestions[0],
  suggestions[1]
]);

function chooser(
  overrides: Partial<NotesTagChooserProps<Readonly<TestOwnership>>> = {}
) {
  const onCommit = vi.fn<
    (commit: NotesTagChooserCommit<Readonly<TestOwnership>>) => void
  >();
  const onOpenChange = vi.fn();
  const onRequestFocusReturn = vi.fn();
  render(
    <NotesTagChooser
      open
      snapshot={openedSnapshot}
      suggestions={suggestions}
      selectedTagUnion={selectedTagUnion}
      onOpenChange={onOpenChange}
      onCommit={onCommit}
      onRequestFocusReturn={onRequestFocusReturn}
      {...overrides}
    />
  );
  return { onCommit, onOpenChange, onRequestFocusReturn };
}

describe("NotesTagChooser", () => {
  it("starts in an explicit Add mode with canonical suggestions", async () => {
    chooser();

    const dialog = await screen.findByRole("dialog", { name: "Edit tags" });
    expect(within(dialog).getByRole("tab", { name: "Add" }))
      .toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tab", { name: "Remove" }))
      .toHaveAttribute("aria-selected", "false");
    expect(within(dialog).getByRole("combobox", { name: "Tag to add" }))
      .toHaveFocus();
    expect(
      within(dialog).getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["#Work", "@Alice", "#Other"]);
    expect(
      within(dialog).getAllByRole("option").map((option) => option.tabIndex)
    ).toEqual([-1, -1, -1]);
  });

  it("uses roving tab focus and arrow keys for the Add/Remove tabs", async () => {
    chooser();
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Edit tags" });
    const addTab = within(dialog).getByRole("tab", { name: "Add" });
    const removeTab = within(dialog).getByRole("tab", { name: "Remove" });

    expect(addTab).toHaveAttribute("tabindex", "0");
    expect(removeTab).toHaveAttribute("tabindex", "-1");
    addTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(removeTab).toHaveFocus();
    expect(removeTab).toHaveAttribute("aria-selected", "true");
    expect(removeTab).toHaveAttribute("tabindex", "0");
    expect(addTab).toHaveAttribute("tabindex", "-1");
    expect(
      within(dialog).getByRole("combobox", { name: "Tag to remove" })
    ).toBeInTheDocument();
  });

  it("accepts exactly one canonical #/@ token and preserves the frozen payload", async () => {
    const { onCommit, onOpenChange } = chooser();
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Tag to add" });

    await user.type(input, `#${"CAFÉ".normalize("NFD")}{Enter}`);

    expect(onCommit).toHaveBeenCalledOnce();
    const commit = onCommit.mock.calls[0][0];
    expect(commit).toEqual({
      mode: "add",
      tag: { prefix: "#", normalizedTag: "café", displayTag: "CAFÉ" },
      snapshot: openedSnapshot
    });
    expect(commit.snapshot).toBe(openedSnapshot);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each(["work", "#one #two", "#one,"])(
    "keeps the chooser open and reports invalid Add input %s",
    async (invalid) => {
      const { onCommit, onOpenChange } = chooser();
      const user = userEvent.setup();
      const input = await screen.findByRole("combobox", {
        name: "Tag to add"
      });

      await user.type(input, `${invalid}{Enter}`);

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enter exactly one tag beginning with # or @."
      );
      expect(screen.getByRole("dialog", { name: "Edit tags" })).toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    }
  );

  it("searches Add suggestions and commits a clicked canonical suggestion", async () => {
    const { onCommit } = chooser();
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Tag to add" });

    await user.type(input, "ali");
    expect(screen.getByRole("option", { name: "@Alice" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "#Work" }))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "@Alice" }));

    expect(onCommit.mock.calls[0][0]).toEqual({
      mode: "add",
      tag: suggestions[1],
      snapshot: openedSnapshot
    });
  });

  it("Remove searches only the exact selected-row tag union and commits with Enter", async () => {
    const { onCommit } = chooser();
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Edit tags" });

    await user.click(within(dialog).getByRole("tab", { name: "Remove" }));
    const search = within(dialog).getByRole("combobox", {
      name: "Tag to remove"
    });
    expect(within(dialog).queryByRole("option", { name: "#Other" }))
      .not.toBeInTheDocument();
    await user.type(search, "alice");
    expect(within(dialog).getByRole("option", { name: "@Alice" })).toBeVisible();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onCommit.mock.calls[0][0]).toEqual({
      mode: "remove",
      tag: { prefix: "@", normalizedTag: "alice" },
      snapshot: openedSnapshot
    });
  });

  it("freezes the opening IDs and ownership when live props change", async () => {
    const onCommit = vi.fn();
    const newerSnapshot = Object.freeze({
      nodeIds: Object.freeze(["new"]),
      ownership: Object.freeze({
        vaultPath: "/new",
        scopeKey: "recent",
        generation: 12
      })
    });
    const { rerender } = render(
      <NotesTagChooser
        open
        snapshot={openedSnapshot}
        suggestions={suggestions}
        selectedTagUnion={selectedTagUnion}
        onOpenChange={vi.fn()}
        onCommit={onCommit}
        onRequestFocusReturn={vi.fn()}
      />
    );
    await screen.findByRole("dialog", { name: "Edit tags" });

    rerender(
      <NotesTagChooser
        open
        snapshot={newerSnapshot}
        suggestions={suggestions}
        selectedTagUnion={selectedTagUnion}
        onOpenChange={vi.fn()}
        onCommit={onCommit}
        onRequestFocusReturn={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("option", { name: "#Work" }));

    expect(onCommit.mock.calls[0][0].snapshot).toBe(openedSnapshot);
  });

  it("shows loading and Remove empty states", async () => {
    const onCommit = vi.fn();
    const loadingView = render(
      <NotesTagChooser
        open
        loading
        snapshot={openedSnapshot}
        suggestions={suggestions}
        selectedTagUnion={selectedTagUnion}
        onOpenChange={vi.fn()}
        onCommit={onCommit}
        onRequestFocusReturn={vi.fn()}
      />
    );
    expect(
      await screen.findByRole("status", { name: "Loading tags" })
    ).toBeVisible();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onCommit).not.toHaveBeenCalled();

    loadingView.unmount();
    render(
      <NotesTagChooser
        open
        initialMode="remove"
        snapshot={openedSnapshot}
        suggestions={suggestions}
        selectedTagUnion={[]}
        onOpenChange={vi.fn()}
        onCommit={vi.fn()}
        onRequestFocusReturn={vi.fn()}
      />
    );
    expect(screen.getByText("No selected tags to remove")).toBeVisible();
  });

  it("closes on Escape and delegates focus restoration", async () => {
    const onRequestFocusReturn = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Open Tags
          </button>
          <NotesTagChooser
            open={open}
            snapshot={openedSnapshot}
            suggestions={suggestions}
            selectedTagUnion={selectedTagUnion}
            onOpenChange={setOpen}
            onCommit={vi.fn()}
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
    const trigger = screen.getByRole("button", { name: "Open Tags" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Edit tags" });
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(onRequestFocusReturn).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
});
