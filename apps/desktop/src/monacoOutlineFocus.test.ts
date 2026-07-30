import { shouldRestoreMonacoOutlineFocus } from "./monacoOutlineFocus";

describe("Monaco outline focus ownership", () => {
  it("restores focus only for the active pane or a pane-local caret request", () => {
    expect(shouldRestoreMonacoOutlineFocus(false, false)).toBe(false);
    expect(shouldRestoreMonacoOutlineFocus(true, false)).toBe(true);
    expect(shouldRestoreMonacoOutlineFocus(false, true)).toBe(true);
  });
});
