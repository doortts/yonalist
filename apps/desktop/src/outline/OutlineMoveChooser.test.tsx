import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "../notesStore";
import { OutlineMoveChooser } from "./OutlineMoveChooser";
import type { OutlineMenuMode } from "./outlineMenuCommands";

const ROOT = "page-1";

function bullet(
  id: string,
  parentId: string | null,
  sortKey: number,
  text: string
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

// page-1 > Alpha, Beta, Gamma ; Beta > Beta child
const TREE: readonly NoteView[] = [
  bullet("a", ROOT, 1024, "Alpha"),
  bullet("b", ROOT, 2048, "Beta"),
  bullet("c", ROOT, 3072, "Gamma"),
  bullet("bc", "b", 1024, "Beta child")
];

function renderChooser(options: {
  readonly mode?: OutlineMenuMode;
  readonly movingRootIds?: readonly string[];
} = {}) {
  const moveNodes = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  function Harness() {
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={triggerRef} type="button">Actions</button>
        <OutlineMoveChooser
          mode={options.mode ?? "selection"}
          nodes={TREE}
          movingRootIds={options.movingRootIds ?? ["a"]}
          rootId={ROOT}
          store={{ moveNodes } as unknown as NotesStore}
          triggerRef={triggerRef}
          onClose={onClose}
        />
      </>
    );
  }
  render(<Harness />);
  const input = screen.getByRole("combobox");
  const optionLabels = () =>
    screen.queryAllByRole("option").map((option) => option.textContent);
  const activeLabel = () => {
    const id = input.getAttribute("aria-activedescendant");
    return id ? document.getElementById(id)?.textContent ?? null : null;
  };
  return { moveNodes, onClose, input, optionLabels, activeLabel };
}

describe("OutlineMoveChooser", () => {
  it("names itself for the mode it was opened in", () => {
    renderChooser({ mode: "selection" });

    const dialog = screen.getByRole("dialog", { name: "Move selection" });
    expect(dialog).toHaveAccessibleDescription(
      "Choose a new parent for the selected outline."
    );
  });

  it("says Move item when one row opened it", () => {
    renderChooser({ mode: "row" });

    expect(screen.getByRole("dialog", { name: "Move item" })).toBeVisible();
  });

  it("lists every destination outside the moving subtree", () => {
    const { optionLabels } = renderChooser({ movingRootIds: ["b"] });

    expect(optionLabels()).toEqual(["Top level", "Alpha", "Gamma"]);
  });

  it("narrows the list by a case-insensitive substring", () => {
    const { input, optionLabels } = renderChooser();

    fireEvent.change(input, { target: { value: "BETA" } });

    expect(optionLabels()).toEqual(["Beta", "Beta child"]);
  });

  it("wraps the active option at both ends", () => {
    const { input, activeLabel } = renderChooser();

    expect(activeLabel()).toBe("Top level");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeLabel()).toBe("Gamma");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeLabel()).toBe("Top level");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeLabel()).toBe("Beta");
  });

  it("commits the active option on Enter as an append", () => {
    const { input, moveNodes, onClose } = renderChooser();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(moveNodes).toHaveBeenCalledWith([
      { id: "a", parentId: "b", beforeId: null }
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("moves to the outline root through the top-level entry", () => {
    const { input, moveNodes } = renderChooser({ movingRootIds: ["bc"] });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(moveNodes).toHaveBeenCalledWith([
      { id: "bc", parentId: ROOT, beforeId: null }
    ]);
  });

  it("commits a clicked option and tracks pointer movement", () => {
    const { activeLabel, moveNodes } = renderChooser();

    const gamma = screen.getAllByRole("option")[3];
    fireEvent.pointerMove(gamma);
    expect(activeLabel()).toBe("Gamma");
    fireEvent.click(gamma);

    expect(moveNodes).toHaveBeenCalledWith([
      { id: "a", parentId: "c", beforeId: null }
    ]);
  });

  it("closes on Escape without moving anything", () => {
    const { input, moveNodes, onClose } = renderChooser();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(moveNodes).not.toHaveBeenCalled();
  });

  // A Korean IME ends its composition with Enter; committing on that keystroke
  // would move whatever the list happened to be pointing at.
  it("ignores an Enter that is only ending a composition", () => {
    const { input, moveNodes, onClose } = renderChooser();

    fireEvent.keyDown(input, {
      key: "Enter",
      nativeEvent: { isComposing: true },
      isComposing: true
    });
    fireEvent.keyDown(input, { key: "Process" });

    expect(moveNodes).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
