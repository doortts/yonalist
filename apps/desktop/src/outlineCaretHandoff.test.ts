import { afterEach, describe, expect, it } from "vitest";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { caretHandoff } from "./outlineCaretHandoff";

const ROOT_ID = "page";

function row(id: string, sortKey: number, parentId = ROOT_ID): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
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

/**
 * The heading and one editor per row, which is what the focus request looks
 * rows up by. `value` is the row id so the caret edge reads off its length.
 */
function pane(rowIds: readonly string[]): HTMLElement {
  const scope = document.createElement("section");
  scope.className = "notes-outline";
  for (const id of [ROOT_ID, ...rowIds]) {
    const editor = document.createElement("textarea");
    editor.dataset.nodeId = id;
    editor.dataset.outlineField = "title";
    editor.value = id;
    scope.append(editor);
  }
  document.body.append(scope);
  return scope;
}

function handOff(
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[] = nodes
) {
  return caretHandoff({
    nodes,
    visibleNodes,
    outlineRootId: ROOT_ID,
    scopeRef: { current: pane(visibleNodes.map((node) => node.id)) }
  });
}

async function caret(): Promise<HTMLTextAreaElement> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const active = document.activeElement;
  expect(active).toBeInstanceOf(HTMLTextAreaElement);
  return active as HTMLTextAreaElement;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("caret handoff before a removal", () => {
  it("lands at the end of the row above a row taken from the middle", async () => {
    const nodes = [row("a", 1_024), row("b", 2_048), row("c", 3_072)];

    handOff(nodes)(["b"])();

    const landed = await caret();
    expect(landed.dataset.nodeId).toBe("a");
    expect(landed.selectionStart).toBe("a".length);
  });

  it("lands at the start of the row below when the first row goes", async () => {
    const nodes = [row("a", 1_024), row("b", 2_048)];

    handOff(nodes)(["a"])();

    const landed = await caret();
    expect(landed.dataset.nodeId).toBe("b");
    expect(landed.selectionStart).toBe(0);
  });

  it("falls back to the outline heading when every row goes", async () => {
    const nodes = [row("a", 1_024), row("b", 2_048)];

    handOff(nodes)(["a", "b"])();

    expect((await caret()).dataset.nodeId).toBe(ROOT_ID);
  });

  it("skips the removed subtree's own rows on the way down", async () => {
    const nodes = [row("a", 1_024), row("a1", 1_024, "a"), row("b", 2_048)];

    handOff(nodes)(["a"])();

    const landed = await caret();
    expect(landed.dataset.nodeId).toBe("b");
    expect(landed.selectionStart).toBe(0);
  });

  it("takes the surviving row between two rows removed apart", async () => {
    const nodes = [row("a", 1_024), row("b", 2_048), row("c", 3_072)];

    handOff(nodes)(["a", "c"])();

    expect((await caret()).dataset.nodeId).toBe("b");
  });
});
