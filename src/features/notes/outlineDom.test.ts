import { describe, expect, it } from "vitest";
import { outlineTitleTextarea } from "./outlineDom";

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

    expect(outlineTitleTextarea(root, "second")).toBe(secondTitle);
    expect(outlineTitleTextarea(root, "missing")).toBeNull();
  });
});
