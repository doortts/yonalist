import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { appApi, snapshot } from "./test/appApiFixture";

/**
 * The pane asks the backend for the whole forest behind a selection from an
 * effect keyed on the selected root ids, and hands the answer back to the
 * selection hook. Answering with a fresh copy of the roots it already held used
 * to re-key that effect, which asked again, which answered again -- the query
 * ran for as long as the band stood.
 */
describe("the forest behind a live selection", () => {
  it("is asked for once, not on a loop", async () => {
    const notesApi = appApi();
    render(<App api={notesApi} />);

    fireEvent.pointerDown(await screen.findByDisplayValue("First thought"), {
      button: 0,
      pointerId: 31,
      ctrlKey: true
    });
    await waitFor(() => expect(notesApi.queryForest).toHaveBeenCalled());
    const settled = (notesApi.queryForest as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    // Long enough for a loop to run away: the defect managed 190 rounds in
    // 300ms, so even a fraction of that window separates it from a settled one.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((notesApi.queryForest as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe(settled);
    expect(settled).toBeLessThanOrEqual(2);
    // The band is still standing, so this is a settled query and not a cleared
    // selection quietly making the assertion pass.
    expect(screen.getByDisplayValue("First thought").closest(".notes-node"))
      .toHaveAttribute("data-selected", "true");
    expect(snapshot.viewport?.nodes).toHaveLength(2);
  });
});
