import { describe, expect, it } from "vitest";
import capabilities from "../../../src-tauri/capabilities/default.json";

describe("notes desktop capabilities", () => {
  it("allows the strict close path to destroy the drained main window", () => {
    expect(capabilities.permissions).toContain("core:window:allow-destroy");
  });
});
