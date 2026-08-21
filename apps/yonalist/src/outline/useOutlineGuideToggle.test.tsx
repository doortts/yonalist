import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "../notesStore";
import { OutlineIndex } from "./outlineIndex";
import { useOutlineGuideToggle } from "./useOutlineGuideToggle";

function node(id: string, parentId: string | null, sortKey: number): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: parentId === null ? "page" : "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

// `top` owns a guide with something to fold: its child `kid` has a child of its
// own. `flat` owns one with nothing: both its children are leaves.
const nodes = [
  node("page", null, 1_024),
  node("top", "page", 1_024),
  node("kid", "top", 1_024),
  node("grandkid", "kid", 1_024),
  node("flat", "page", 2_048),
  node("leafA", "flat", 1_024),
  node("leafB", "flat", 2_048)
];

const ROWS = ["top", "kid", "grandkid", "flat", "leafA", "leafB"];
const store = {} as NotesStore;

/**
 * The hook reads the stripe geometry off the row with `getComputedStyle`, and
 * jsdom cascades no custom properties, so the rows answer for the two the hit
 * test needs and everything else keeps the real implementation.
 */
function stubRowGeometry() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (element instanceof Element && element.classList.contains("notes-node")) {
      return {
        getPropertyValue: (name: string) =>
          name === "--notes-bullet-center-offset"
            ? "61"
            : name === "--notes-outline-indent"
              ? "36"
              : ""
      } as unknown as CSSStyleDeclaration;
    }
    return real(element as Element, pseudo as string | undefined);
  });
}

function Harness({ index }: { readonly index: OutlineIndex }) {
  const guide = useOutlineGuideToggle(store, index, "page");
  return (
    <ol data-testid="list" {...guide}>
      {ROWS.map((id) => (
        <li key={id}>
          <div className="notes-node" data-outline-id={id}>
            {id}
          </div>
        </li>
      ))}
    </ol>
  );
}

function row(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-outline-id="${id}"]`);
  if (!found) throw new Error(`missing row: ${id}`);
  return found;
}

/** The first stripe's own centre, so the hit lands on band 0. */
function hover(target: HTMLElement) {
  fireEvent.mouseMove(target, { clientX: 61, clientY: 0 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useOutlineGuideToggle", () => {
  it("lights a foldable range in the actionable flavour, under a pointer", () => {
    stubRowGeometry();
    const { container, getByTestId } = render(
      <Harness index={new OutlineIndex(nodes)} />
    );
    hover(row(container, "kid"));
    expect(row(container, "kid").dataset.guideHot).toBe("true");
    expect(row(container, "grandkid").dataset.guideHot).toBe("true");
    expect(row(container, "leafA").dataset.guideHot).toBeUndefined();
    expect(getByTestId("list").style.cursor).toBe("pointer");
  });

  // Still lit -- a dark line would read as a dead hit test -- but the flavour
  // says the click has nothing to do, and the cursor stops promising one.
  it("lights a range with nothing to fold in the inert flavour, no pointer", () => {
    stubRowGeometry();
    const { container, getByTestId } = render(
      <Harness index={new OutlineIndex(nodes)} />
    );
    hover(row(container, "leafA"));
    expect(row(container, "leafA").dataset.guideHot).toBe("inert");
    expect(row(container, "leafB").dataset.guideHot).toBe("inert");
    expect(getByTestId("list").style.cursor).toBe("");
  });

  // The repaint is skipped while the hit is unchanged, and an edit that empties
  // the range leaves the stripe and its owner exactly where they were -- so the
  // flavour has to be part of what "unchanged" means or the line keeps lying.
  it("repaints when the flavour flips under the same stripe", () => {
    stubRowGeometry();
    const { container, getByTestId, rerender } = render(
      <Harness index={new OutlineIndex(nodes)} />
    );
    hover(row(container, "kid"));
    expect(row(container, "kid").dataset.guideHot).toBe("true");

    const emptied = nodes.filter((candidate) => candidate.id !== "grandkid");
    rerender(<Harness index={new OutlineIndex(emptied)} />);
    hover(row(container, "kid"));
    expect(row(container, "kid").dataset.guideHot).toBe("inert");
    expect(getByTestId("list").style.cursor).toBe("");
  });
});
