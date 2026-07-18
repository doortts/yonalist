import { describe, expect, it, vi } from "vitest";
import {
  createNotesImageAtomEditorRegistry,
  type ActiveImageAtomEditor
} from "./notesImageAtomEditorRegistry";

function editor(overrides: Partial<ActiveImageAtomEditor> = {}): ActiveImageAtomEditor {
  return {
    nodeId: "image-node",
    flush: vi.fn().mockResolvedValue("flushed"),
    flushAndGetSelection: vi.fn().mockResolvedValue({
      anchorUtf16: 0,
      focusUtf16: 0
    }),
    claimPaste: vi.fn().mockReturnValue(false),
    ...overrides
  };
}

describe("Notes image atom editor registry", () => {
  it("does not expose a raw synchronous selection reader from its active editor", () => {
    const registry = createNotesImageAtomEditorRegistry();
    registry.register(editor());

    expect(registry.active()).not.toHaveProperty("selection");
  });

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

  it("awaits the captured latest editor's combined selection barrier", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    const order: string[] = [];
    const active = editor({
      nodeId: "selected",
      flushAndGetSelection: vi.fn(async () => {
        order.push("flushAndGetSelection");
        return { anchorUtf16: 2, focusUtf16: 5 };
      })
    });
    registry.register(active);

    await expect(registry.activeSelection()).resolves.toEqual({
      nodeId: "selected",
      selection: { anchorUtf16: 2, focusUtf16: 5 }
    });
    expect(order).toEqual(["flushAndGetSelection"]);
    expect(active.flush).not.toHaveBeenCalled();
    expect(active.flushAndGetSelection).toHaveBeenCalledOnce();
  });

  it("does not publish a stale, disconnected, or cancelled editor selection", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    let resolveSelection!: (selection: { anchorUtf16: number; focusUtf16: number }) => void;
    const stale = editor({
      nodeId: "stale",
      flushAndGetSelection: vi.fn().mockReturnValue(
        new Promise<{ anchorUtf16: number; focusUtf16: number }>((resolve) => {
          resolveSelection = resolve;
        })
      )
    });
    const removeStale = registry.register(stale);
    const selection = registry.activeSelection();
    const current = editor({ nodeId: "current" });
    registry.register(current);
    resolveSelection({ anchorUtf16: 1, focusUtf16: 1 });

    await expect(selection).resolves.toBeNull();
    removeStale();

    const cancelled = editor({
      nodeId: "cancelled",
      flushAndGetSelection: vi.fn().mockResolvedValue(null)
    });
    registry.register(cancelled);
    await expect(registry.activeSelection()).resolves.toBeNull();

    const throwing = editor({
      nodeId: "throwing",
      flushAndGetSelection: vi.fn().mockRejectedValue(new Error("editor disconnected"))
    });
    registry.register(throwing);
    await expect(registry.activeSelection()).resolves.toBeNull();
  });

  it("fails closed when the active selection flush rejects", async () => {
    const registry = createNotesImageAtomEditorRegistry();
    const rejected = editor({
      flushAndGetSelection: vi.fn().mockRejectedValue(
        new Error("composition interrupted")
      )
    });
    registry.register(rejected);

    await expect(registry.activeSelection()).resolves.toBeNull();
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
