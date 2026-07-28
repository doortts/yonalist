import { act, render, screen } from "@testing-library/react";
import { readyRealStore } from "./test/notesStoreFixture";
import { useNotesNode } from "./useNotesNode";

describe("useNotesNode", () => {
  it("rerenders only the probe whose node draft changed", async () => {
    const store = await readyRealStore();
    const renders = new Map<string, number>();
    function Probe({ id }: { readonly id: string }) {
      const state = useNotesNode(store, id);
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return <output data-testid={id}>{state.title}</output>;
    }
    render(
      <>
        <Probe id="one" />
        <Probe id="two" />
      </>
    );

    act(() => store.setDraft("one", "Focused edit"));

    expect(screen.getByTestId("one")).toHaveTextContent("Focused edit");
    expect(screen.getByTestId("two")).toHaveTextContent("two");
    expect(renders).toEqual(new Map([["one", 2], ["two", 1]]));
  });
});
