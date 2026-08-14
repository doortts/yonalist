import { capturePane } from "./appNavigation";
import { registerOutlinePane } from "./outline/outlinePaneRegistry";

function paneFixture(): string {
  return `
    <section data-outline-pane-id="primary">
      <div data-outline-id="primary-selected" data-selected="true"></div>
    </section>
    <section data-outline-pane-id="secondary">
      <div data-outline-id="secondary-selected" data-selected="true"></div>
      <textarea
        data-node-id="secondary-focused"
        data-outline-field="title"
      >text</textarea>
    </section>
  `;
}

describe("app navigation", () => {
  it("captures selection and focus only from the requested split pane", () => {
    document.body.innerHTML = paneFixture();
    const editor = document.querySelector<HTMLTextAreaElement>(
      "[data-node-id='secondary-focused']"
    )!;
    editor.focus();
    editor.setSelectionRange(2, 4);

    expect(capturePane("secondary")).toEqual({
      paneId: "secondary",
      selectedIds: ["secondary-selected"],
      focus: {
        nodeId: "secondary-focused",
        field: "title",
        selectionStart: 2,
        selectionEnd: 4
      }
    });
  });

  // The pane renders only the rows near the viewport, so the mounted rows are a
  // window onto the band and never the band itself.
  it("takes the band from the pane rather than from the mounted rows", () => {
    document.body.innerHTML = paneFixture();
    const scope = document.querySelector<HTMLElement>(
      "[data-outline-pane-id='primary']"
    )!;
    registerOutlinePane(scope, {
      visibleNodes: [],
      reveal: () => false,
      selectedIds: () => ["above-window", "primary-selected", "below-window"],
      replaceSelection: () => undefined
    });

    expect(capturePane("primary").selectedIds).toEqual([
      "above-window",
      "primary-selected",
      "below-window"
    ]);
  });
});
