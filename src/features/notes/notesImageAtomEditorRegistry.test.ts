import { describe, expect, it, vi } from "vitest";
import {
  createNotesImageAtomEditorRegistry,
  type ActiveImageAtomEditor
} from "./notesImageAtomEditorRegistry";

function editor(overrides: Partial<ActiveImageAtomEditor> = {}): ActiveImageAtomEditor {
  return {
    nodeId: "image-node",
    flush: vi.fn().mockResolvedValue("flushed"),
    claimPaste: vi.fn().mockReturnValue(false),
    ...overrides
  };
}

describe("Notes image atom editor registry", () => {
  it("makes the latest registered editor active and restores the prior editor on cleanup", () => {
    const registry = createNotesImageAtomEditorRegistry();
    const first = editor({ nodeId: "first" });
    const second = editor({ nodeId: "second" });

    const removeFirst = registry.register(first);
    const removeSecond = registry.register(second);

    expect(registry.active()).toBe(second);
    removeSecond();
    expect(registry.active()).toBe(first);
    removeFirst();
    expect(registry.active()).toBeNull();
  });

  it("keeps a newer registration alive when a stale cleanup uses the same editor identity", () => {
    const registry = createNotesImageAtomEditorRegistry();
    const shared = editor();

    const removeStale = registry.register(shared);
    const removeCurrent = registry.register(shared);
    removeStale();

    expect(registry.active()).toBe(shared);
    removeCurrent();
    expect(registry.active()).toBeNull();
  });

  it("flushes every active editor and fails closed when one composition is cancelled", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    const saved = editor({ nodeId: "saved" });
    const interrupted = editor({
      nodeId: "interrupted",
      flush: vi.fn().mockResolvedValue("cancelled")
    });
    registry.register(saved);
    registry.register(interrupted);

    await expect(registry.flushAll()).resolves.toBe(false);
    expect(saved.flush).toHaveBeenCalledOnce();
    expect(interrupted.flush).toHaveBeenCalledOnce();
  });

  it("treats a composition settled after deferral as a successful flush", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    registry.register(
      editor({
        flush: vi.fn().mockResolvedValue("deferred")
      })
    );

    await expect(registry.flushAll()).resolves.toBe(true);
  });

  it("coalesces concurrent registry flushes and permits a later fresh flush", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    let resolve!: (result: "flushed") => void;
    const pending = new Promise<"flushed">((settle) => {
      resolve = settle;
    });
    const active = editor({ flush: vi.fn().mockReturnValue(pending) });
    registry.register(active);

    const first = registry.flushAll();
    const second = registry.flushAll();
    expect(first).toBe(second);
    expect(active.flush).toHaveBeenCalledOnce();

    resolve("flushed");
    await expect(first).resolves.toBe(true);
    await expect(registry.flushAll()).resolves.toBe(true);
    expect(active.flush).toHaveBeenCalledTimes(2);
  });

  it("includes an editor registered while the current barrier is in flight", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    let settleFirst!: (result: "flushed") => void;
    const first = editor({
      nodeId: "first",
      flush: vi.fn().mockReturnValue(
        new Promise<"flushed">((resolve) => {
          settleFirst = resolve;
        })
      )
    });
    const late = editor({ nodeId: "late" });
    registry.register(first);

    const barrier = registry.flushAll();
    registry.register(late);
    settleFirst("flushed");

    await expect(barrier).resolves.toBe(true);
    expect(late.flush).toHaveBeenCalledOnce();
  });

  it("fails closed when an editor flush rejects", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    registry.register(
      editor({ flush: vi.fn().mockRejectedValue(new Error("editor lost")) })
    );

    await expect(registry.flushAll()).resolves.toBe(false);
  });

  it("lets only the current editor claim a paste event", () => {
    const registry = createNotesImageAtomEditorRegistry();
    const first = editor({ nodeId: "first", claimPaste: vi.fn().mockReturnValue(true) });
    const second = editor({ nodeId: "second", claimPaste: vi.fn().mockReturnValue(false) });
    registry.register(first);
    registry.register(second);
    const event = new Event("paste") as ClipboardEvent;

    expect(registry.claimPaste(event)).toBe(false);
    expect(first.claimPaste).not.toHaveBeenCalled();
    expect(second.claimPaste).toHaveBeenCalledWith(event);
  });
});
