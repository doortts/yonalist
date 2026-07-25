import { describe, expect, it, vi } from "vitest";
import type {
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceCommandOutcome
} from "./notesWorkspaceCoordinator";
import type { NotesDraftEngine } from "./notesDraftEngine";
import type { NotesBackspaceDraftLease } from "./notesWorkspaceTypes";
import {
  createNotesBackspaceGestureRuntimeLifecycle,
  observeBackspaceGestureTerminalOutcome,
  registerCoordinatorSessionForDraftEngine,
  shutdownAfterBackspaceDrain
} from "./notesBackspaceRuntime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function session(token: number, completion: Promise<NotesWorkspaceCommandOutcome>) {
  const draftLease: NotesBackspaceDraftLease = {
    token,
    touch: vi.fn(),
    prepare: vi.fn(),
    settle: vi.fn()
  };
  const coordinator = {
    beginBackspaceGesture: vi.fn((_input, createDraftLease) => {
      expect(createDraftLease(token)).toBe(draftLease);
      return token;
    }),
    touchBackspaceGesture: vi.fn(),
    removeEmptyNodeInBackspaceGesture: vi.fn(() => true),
    finishBackspaceGesture: vi.fn(() => completion),
    cancelBackspaceGesture: vi.fn()
  } as unknown as NotesWorkspaceCoordinatorSession;
  return { coordinator, draftLease };
}

describe("Notes Backspace runtime lifecycle", () => {
  it("keeps colliding coordinator tokens bound to their origin vault and ignores a late keyup", async () => {
    const firstCompletion = deferred<NotesWorkspaceCommandOutcome>();
    const secondCompletion = deferred<NotesWorkspaceCommandOutcome>();
    const first = session(1, firstCompletion.promise);
    const second = session(1, secondCompletion.promise);
    const firstKey = {};
    const secondKey = {};
    const lifecycle = createNotesBackspaceGestureRuntimeLifecycle();
    const work = vi.fn();

    const firstHandle = lifecycle.begin(
      {
        key: firstKey,
        session: first.coordinator,
        beginDraftLease: () => first.draftLease
      },
      {
        ownerPaneId: "primary",
        nodeId: "first",
        selection: { anchorUtf16: 0, focusUtf16: 0 }
      },
      work
    );
    const secondHandle = lifecycle.begin(
      {
        key: secondKey,
        session: second.coordinator,
        beginDraftLease: () => second.draftLease
      },
      {
        ownerPaneId: "secondary",
        nodeId: "second",
        selection: { anchorUtf16: 0, focusUtf16: 0 }
      },
      work
    );

    expect(firstHandle).not.toBe(secondHandle);
    lifecycle.touch(firstHandle!, "first-next");
    lifecycle.remove(firstHandle!, "first-next", null);
    expect(first.coordinator.touchBackspaceGesture).toHaveBeenCalledWith(
      1,
      "first-next"
    );
    expect(
      first.coordinator.removeEmptyNodeInBackspaceGesture
    ).toHaveBeenCalledWith(1, "first-next", null);
    expect(second.coordinator.touchBackspaceGesture).not.toHaveBeenCalled();

    const firstFinish = lifecycle.finish(firstKey, "drain");
    const secondFinish = lifecycle.finish(secondKey, "keyup");
    firstCompletion.resolve("failed");
    secondCompletion.resolve("committed");
    await expect(firstFinish).resolves.toBe("failed");
    await expect(secondFinish).resolves.toBe("committed");
    await expect(lifecycle.finish(firstKey, "keyup")).resolves.toBe("skipped");
    expect(first.coordinator.finishBackspaceGesture).toHaveBeenCalledOnce();
    expect(second.coordinator.finishBackspaceGesture).toHaveBeenCalledOnce();
  });

  it("does not join a different pane to an active gesture with the same binding", () => {
    const completion = deferred<NotesWorkspaceCommandOutcome>();
    const active = session(1, completion.promise);
    const bindingKey = {};
    const lifecycle = createNotesBackspaceGestureRuntimeLifecycle();
    const binding = {
      key: bindingKey,
      session: active.coordinator,
      beginDraftLease: () => active.draftLease
    };

    const primaryHandle = lifecycle.begin(
      binding,
      {
        ownerPaneId: "primary",
        nodeId: "primary-empty",
        selection: { anchorUtf16: 0, focusUtf16: 0 }
      },
      vi.fn()
    );
    const secondaryHandle = lifecycle.begin(
      binding,
      {
        ownerPaneId: "secondary",
        nodeId: "secondary-empty",
        selection: { anchorUtf16: 0, focusUtf16: 0 }
      },
      vi.fn()
    );

    expect(primaryHandle).not.toBeNull();
    expect(secondaryHandle).toBeNull();
    expect(active.coordinator.beginBackspaceGesture).toHaveBeenCalledOnce();
    lifecycle.cancel(bindingKey);
  });

  it("does not shut down a draft engine until a checking Backspace drain reaches a terminal outcome", async () => {
    const completion = deferred<NotesWorkspaceCommandOutcome>();
    const finishBackspaceGesture = vi.fn(() => completion.promise);
    const coordinator = {
      finishBackspaceGesture
    } as unknown as NotesWorkspaceCoordinatorSession;
    const beginShutdown = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const engine = {
      record: { backspaceDraftLease: { active: true } },
      beginShutdown,
      dispose
    } as unknown as NotesDraftEngine;
    registerCoordinatorSessionForDraftEngine(engine, coordinator);

    const shutdown = shutdownAfterBackspaceDrain(engine);
    await Promise.resolve();
    expect(finishBackspaceGesture).toHaveBeenCalledWith("drain");
    expect(beginShutdown).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    completion.resolve("failed");
    await shutdown;
    expect(beginShutdown).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reports the real terminal outcome and leaves a checking benchmark pending", async () => {
    const checking = deferred<NotesWorkspaceCommandOutcome>();
    const mark = vi.fn();
    observeBackspaceGestureTerminalOutcome(checking.promise, mark);
    await Promise.resolve();
    expect(mark).not.toHaveBeenCalled();

    checking.resolve("skipped");
    await checking.promise;
    await Promise.resolve();
    expect(mark).toHaveBeenCalledWith("skipped");

    const rejected = Promise.reject(new Error("terminal failure"));
    observeBackspaceGestureTerminalOutcome(rejected, mark);
    await expect(rejected).rejects.toThrow("terminal failure");
    await Promise.resolve();
    expect(mark).toHaveBeenCalledWith("failed");
  });
});
