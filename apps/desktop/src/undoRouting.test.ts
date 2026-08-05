import { shouldRouteUndoToApplication } from "./App";

describe("application Undo routing", () => {
  it("leaves Undo inside the Monaco outline on Monaco's native path", () => {
    const outline = document.createElement("div");
    outline.className = "notes-monaco-outline";
    const target = document.createElement("textarea");
    outline.append(target);

    expect(shouldRouteUndoToApplication(target, true)).toBe(false);
    expect(shouldRouteUndoToApplication(document.body, true)).toBe(true);
  });
});
