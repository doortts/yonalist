import { describe, expect, it } from "vitest";
import { outlineTitleEditor } from "./outlineDom";

describe("outlineDom", () => {
  it("finds the live title editor for the matching outline row", () => {
    const root = document.createElement("section");
    root.innerHTML = `
      <div data-outline-id="first">
        <div data-notes-bullet-title></div>
      </div>
      <div data-outline-id="second">
        <div data-notes-bullet-title></div>
      </div>
    `;

    const secondTitle = root.querySelectorAll("[data-notes-bullet-title]")[1];

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
