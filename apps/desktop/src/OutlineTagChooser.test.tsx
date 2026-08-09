import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import { OutlineTagChooser } from "./OutlineTagChooser";

const ROOT = "page-1";

function bullet(id: string, text: string, note = ""): NoteView {
  return {
    id,
    parentId: ROOT,
    sortKey: 1024,
    kind: "bullet",
    image: null,
    text,
    note,
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

// a, b, c are the rows being edited; d is elsewhere in the workspace.
const TREE: readonly NoteView[] = [
  bullet("a", "buy milk #shop"),
  bullet("b", "call mum @ada"),
  bullet("c", "pay rent"),
  bullet("d", "read #books")
];

function renderChooser(options: {
  readonly targetIds?: readonly string[];
} = {}) {
  const applyTextEdits = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const store = {
    applyTextEdits,
    getSnapshot: () => ({ nodes: TREE, drafts: {}, noteDrafts: {} })
  } as unknown as NotesStore;
  function Harness() {
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={triggerRef} type="button">Actions</button>
        <OutlineTagChooser
          nodes={TREE}
          targetIds={options.targetIds ?? ["a", "b", "c"]}
          store={store}
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
  const tab = (name: "Add" | "Remove") => screen.getByRole("tab", { name });
  return { applyTextEdits, onClose, input, optionLabels, activeLabel, tab };
}

describe("OutlineTagChooser", () => {
  it("names itself and says what committing will do", () => {
    renderChooser();

    expect(screen.getByRole("dialog", { name: "Edit tags" }))
      .toHaveAccessibleDescription(
        "Add or remove one exact tag from the selected rows."
      );
  });

  it("suggests every tag in the workspace, not only the ones on the rows", () => {
    const { optionLabels } = renderChooser();

    expect(optionLabels()).toEqual(["#shop", "@ada", "#books"]);
  });

  it("narrows the suggestions by a substring of prefix and tag", () => {
    const { input, optionLabels } = renderChooser();

    fireEvent.change(input, { target: { value: "oo" } });

    expect(optionLabels()).toEqual(["#books"]);
  });

  it("offers only the tags the target rows already carry in Remove mode", () => {
    const { optionLabels, tab } = renderChooser();

    fireEvent.click(tab("Remove"));

    expect(optionLabels()).toEqual(["#shop", "@ada"]);
  });

  it("commits the highlighted suggestion on Enter", () => {
    const { input, applyTextEdits, onClose } = renderChooser();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(applyTextEdits).toHaveBeenCalledWith([
      { id: "b", text: "call mum @ada #shop" },
      { id: "c", text: "pay rent #shop" }
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("accepts free text in Add mode when it is exactly one tag", () => {
    const { input, applyTextEdits } = renderChooser();

    fireEvent.change(input, { target: { value: "#zzz" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(applyTextEdits).toHaveBeenCalledWith([
      { id: "a", text: "buy milk #shop #zzz" },
      { id: "b", text: "call mum @ada #zzz" },
      { id: "c", text: "pay rent #zzz" }
    ]);
  });

  it("refuses free text that is not exactly one tag", () => {
    const { input, applyTextEdits } = renderChooser();

    fireEvent.change(input, { target: { value: "buy milk" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("alert"))
      .toHaveTextContent("Enter exactly one tag beginning with # or @.");
    expect(applyTextEdits).not.toHaveBeenCalled();
  });

  it("refuses free text in Remove mode even when it parses as a tag", () => {
    const { input, applyTextEdits, tab } = renderChooser();

    fireEvent.click(tab("Remove"));
    fireEvent.change(input, { target: { value: "#books" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("alert"))
      .toHaveTextContent("Choose one of the tags already on these rows.");
    expect(applyTextEdits).not.toHaveBeenCalled();
  });

  it("strips the chosen tag from the rows that carry it in Remove mode", () => {
    const { applyTextEdits, tab } = renderChooser();

    fireEvent.click(tab("Remove"));
    fireEvent.click(screen.getAllByRole("option")[0]);

    expect(applyTextEdits).toHaveBeenCalledWith([{ id: "a", text: "buy milk" }]);
  });

  it("wraps the active suggestion at both ends", () => {
    const { input, activeLabel } = renderChooser();

    expect(activeLabel()).toBe("#shop");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeLabel()).toBe("#books");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeLabel()).toBe("#shop");
  });

  it("moves between the tabs with the arrow keys", () => {
    const { tab, optionLabels } = renderChooser();

    tab("Add").focus();
    fireEvent.keyDown(tab("Add"), { key: "ArrowRight" });

    expect(tab("Remove")).toHaveAttribute("aria-selected", "true");
    expect(optionLabels()).toEqual(["#shop", "@ada"]);
  });

  // A Korean IME ends its composition with Enter; committing there would
  // apply whichever tag the list happened to be pointing at.
  it("ignores an Enter that is only ending a composition", () => {
    const { input, applyTextEdits, onClose } = renderChooser();

    fireEvent.keyDown(input, {
      key: "Enter",
      nativeEvent: { isComposing: true },
      isComposing: true
    });
    fireEvent.keyDown(input, { key: "Process" });

    expect(applyTextEdits).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape without editing anything", () => {
    const { input, applyTextEdits, onClose } = renderChooser();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(applyTextEdits).not.toHaveBeenCalled();
  });
});
