import { describe, expect, it } from "vitest";
import capabilities from "../../../src-tauri/capabilities/default.json";

describe("notes attachment capabilities", () => {
  it("allows opening and saving files through the native dialog", () => {
    expect(capabilities.permissions).toEqual(
      expect.arrayContaining(["dialog:allow-open", "dialog:allow-save"])
    );
  });
});
