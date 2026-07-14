import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteId, NoteSearchResult } from "../../domain/notes";
import { NotesQuickJump } from "./NotesQuickJump";

function result(overrides: Partial<NoteSearchResult> & { nodeId: NoteId }): NoteSearchResult {
  return {
    title: overrides.nodeId,
    parentTrail: [],
    matchedField: "title",
    ...overrides
  };
}

function Harness({
  onSearch,
  onJump,
  initialOpen = true
}: {
  onSearch: (query: string) => Promise<readonly NoteSearchResult[]>;
  onJump: (nodeId: NoteId) => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <NotesQuickJump
        open={open}
        onOpenChange={setOpen}
        onSearch={onSearch}
        onJump={onJump}
        debounceMs={10}
      />
    </>
  );
}

describe("NotesQuickJump", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the dialog with a search field when open", async () => {
    render(
      <Harness onSearch={vi.fn().mockResolvedValue([])} onJump={vi.fn()} />
    );

    expect(
      await screen.findByRole("dialog", { name: "Jump to note" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Jump to note" })
    ).toBeInTheDocument();
  });

  it("does not render the dialog when closed", () => {
    render(
      <Harness
        onSearch={vi.fn().mockResolvedValue([])}
        onJump={vi.fn()}
        initialOpen={false}
      />
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls the search action as the query changes and lists results with their parent trail", async () => {
    const onSearch = vi.fn().mockResolvedValue([
      result({ nodeId: "plan", title: "Plan", parentTrail: ["Project"] }),
      result({
        nodeId: "milestone",
        title: "Milestone",
        parentTrail: ["Project", "Plan"]
      })
    ]);
    const user = userEvent.setup();
    render(<Harness onSearch={onSearch} onJump={vi.fn()} />);

    const input = await screen.findByRole("combobox", { name: "Jump to note" });
    await user.type(input, "plan");

    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("plan"));
    expect(
      await screen.findByRole("option", { name: "Plan, in Project" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Milestone, in Project / Plan" })
    ).toBeInTheDocument();
  });

  it("moves the active selection with the arrow keys and jumps on Enter, then closes", async () => {
    const onSearch = vi.fn().mockResolvedValue([
      result({ nodeId: "plan", title: "Plan", parentTrail: ["Project"] }),
      result({
        nodeId: "milestone",
        title: "Milestone",
        parentTrail: ["Project", "Plan"]
      })
    ]);
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSearch={onSearch} onJump={onJump} />);

    const input = await screen.findByRole("combobox", { name: "Jump to note" });
    await user.type(input, "pl");
    await screen.findByRole("option", { name: "Plan, in Project" });

    await user.keyboard("[ArrowDown]");
    expect(
      screen.getByRole("option", { name: "Milestone, in Project / Plan" })
    ).toHaveAttribute("aria-selected", "true");

    await user.keyboard("[Enter]");

    expect(onJump).toHaveBeenCalledWith("milestone");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("does not treat an IME-composition Enter as a jump commit", async () => {
    const onSearch = vi.fn().mockResolvedValue([
      result({ nodeId: "plan", title: "Plan", parentTrail: ["Project"] })
    ]);
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSearch={onSearch} onJump={onJump} />);

    const input = await screen.findByRole("combobox", { name: "Jump to note" });
    await user.type(input, "pl");
    await screen.findByRole("option", { name: "Plan, in Project" });

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(onJump).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Jump to note" })).toBeVisible();
  });

  it("closes on Escape and restores focus to the previously focused element", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        onSearch={vi.fn().mockResolvedValue([])}
        onJump={vi.fn()}
        initialOpen={false}
      />
    );
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);

    await screen.findByRole("dialog", { name: "Jump to note" });
    await user.keyboard("[Escape]");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
