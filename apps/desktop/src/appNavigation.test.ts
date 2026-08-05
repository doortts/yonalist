import { capturePane } from "./appNavigation";

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
      selectedIds: ["secondary-selected"],
      focus: {
        nodeId: "secondary-focused",
        field: "title",
        selectionStart: 2,
        selectionEnd: 4
      }
    });
  });
});
