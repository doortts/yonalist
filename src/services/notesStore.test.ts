import { afterEach, describe, expect, it, vi } from "vitest";
import { notesLoadWorkspace } from "./notesStore";

const tauriCoreFactoryEvaluated = vi.hoisted(() => ({ current: false }));
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => {
  tauriCoreFactoryEvaluated.current = true;
  return {
    invoke: invokeMock
  };
});

describe("notesStore outside Tauri", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.localStorage.clear();
    tauriCoreFactoryEvaluated.current = false;
    invokeMock.mockReset();
  });

  it("rejects Notes access outside Tauri instead of writing localStorage", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    tauriCoreFactoryEvaluated.current = false;

    const error = await notesLoadWorkspace("/vault", {
      kind: "active"
    }).catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Notes requires Tauri desktop storage."
    );
    expect(tauriCoreFactoryEvaluated.current).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("yonalist.notes.v1")).toBeNull();
  });
});
