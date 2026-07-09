import { afterEach, describe, expect, it, vi } from "vitest";
import { notesLoadWorkspace } from "./notesStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock
}));

describe("notesStore outside Tauri", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.localStorage.clear();
    invokeMock.mockReset();
  });

  it("rejects Notes access outside Tauri instead of writing localStorage", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    await expect(
      notesLoadWorkspace("/vault", { kind: "active" })
    ).rejects.toThrow("Notes requires Tauri desktop storage.");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("yonalist.notes.v1")).toBeNull();
  });
});
