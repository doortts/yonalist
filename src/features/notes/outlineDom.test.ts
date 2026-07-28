import { describe, expect, it } from "vitest";
import { outlineTitleEditor } from "./outlineDom";

describe("outlineDom", () => {
  it("finds the title textarea for the matching outline row", () => {
    const root = document.createElement("section");
    root.innerHTML = `
      <div data-outline-id="first">
        <textarea class="notes-node-title"></textarea>
      </div>
      <div data-outline-id="second">
        <textarea class="notes-node-title"></textarea>
      </div>
    `;

    const secondTitle = root.querySelectorAll("textarea")[1];

    expect(outlineTitleEditor(root, "second")).toBe(secondTitle);
    expect(outlineTitleEditor(root, "missing")).toBeNull();
  });

  it("prefers the live title root over a specialized textarea", () => {
    const root = document.createElement("section");
    root.innerHTML = `
      <div data-outline-id="row">
        <textarea class="notes-node-title"></textarea>
        <div data-notes-bullet-title></div>
      </div>
    `;

    expect(outlineTitleEditor(root, "row")).toBe(
      root.querySelector("[data-notes-bullet-title]"),
    );
  });
});
