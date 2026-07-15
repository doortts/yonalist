import { describe, expect, it, vi } from "vitest";
import type { NotesClipboardEvent } from "./notesClipboard";
import {
  createNotesSelectionNativeClipboardController,
  type NotesSelectionNativeClipboardRouter
} from "./notesSelectionNativeClipboard";
import type {
  NotesPreparedClipboardCommitOutcome,
  NotesPreparedClipboardIntent
} from "./useNotesSelectionCommandRouter";

interface TestSession {
  readonly id: string;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nativeEvent(
  target: unknown = {
    tagName: "TEXTAREA",
    selectionStart: 3,
    selectionEnd: 3
  }
) {
  const setData = vi.fn();
  const preventDefault = vi.fn();
  const event = {
    target,
    clipboardData: { setData },
    preventDefault
  } satisfies NotesClipboardEvent & { readonly target: unknown };
  return { event, setData, preventDefault };
}

function router(
  overrides: Partial<NotesSelectionNativeClipboardRouter<TestSession>> = {}
) {
  const prepareClipboard = vi.fn(async () => ({ id: "session" }));
  const commitPreparedClipboardEvent = vi.fn(
    (
      intent: NotesPreparedClipboardIntent,
      event: NotesClipboardEvent,
      _session: TestSession
    ): NotesPreparedClipboardCommitOutcome => {
      event.clipboardData?.setData("text/plain", "- Selected");
      event.clipboardData?.setData("text/markdown", "- Selected");
      event.preventDefault();
      return { kind: "committed", intent };
    }
  );
  const invalidatePreparedClipboard = vi.fn();
  return {
    prepareClipboard,
    commitPreparedClipboardEvent,
    invalidatePreparedClipboard,
    ...overrides
  } satisfies NotesSelectionNativeClipboardRouter<TestSession>;
}

describe("createNotesSelectionNativeClipboardController", () => {
  it("claims an eligible Copy while selection clipboard preparation is pending", () => {
    const selectionRouter = router();
    const onPreparationPending = vi.fn();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter,
      { onPreparationPending }
    );
    const clipboard = nativeEvent();

    const outcome = controller.handleCopy(clipboard.event, {
      claimUnprepared: true
    });

    expect(outcome).toEqual({
      kind: "claimed",
      reason: "unprepared",
      intent: "copy"
    });
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
    expect(onPreparationPending).toHaveBeenCalledWith("copy");
    expect(selectionRouter.prepareClipboard).toHaveBeenCalledTimes(1);
    expect(selectionRouter.commitPreparedClipboardEvent).not.toHaveBeenCalled();
  });

  it("never commits an unprepared Cut after its asynchronous preparation completes", async () => {
    const pending = deferred<TestSession | null>();
    const selectionRouter = router({
      prepareClipboard: vi.fn(() => pending.promise)
    });
    const onPreparationPending = vi.fn();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter,
      { onPreparationPending }
    );
    const clipboard = nativeEvent();

    expect(
      controller.handleCut(clipboard.event, { claimUnprepared: true })
    ).toEqual({
      kind: "claimed",
      reason: "unprepared",
      intent: "cut"
    });
    const preparation = controller.prewarm();
    pending.resolve({ id: "ready" });
    await expect(preparation).resolves.toEqual({ id: "ready" });

    expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
    expect(clipboard.setData).not.toHaveBeenCalled();
    expect(onPreparationPending).toHaveBeenCalledWith("cut");
    expect(selectionRouter.commitPreparedClipboardEvent).not.toHaveBeenCalled();
  });

  it("coalesces preparation inside one lifecycle generation", async () => {
    const pending = deferred<TestSession | null>();
    const selectionRouter = router({
      prepareClipboard: vi.fn(() => pending.promise)
    });
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );

    const first = controller.prewarm();
    const second = controller.prewarm();

    expect(second).toBe(first);
    expect(selectionRouter.prepareClipboard).toHaveBeenCalledTimes(1);
    pending.resolve({ id: "ready" });
    await expect(first).resolves.toEqual({ id: "ready" });
  });

  it("lets the latest overlapping refresh win when the first succeeds late", async () => {
    const first = deferred<TestSession | null>();
    const second = deferred<TestSession | null>();
    const selectionRouter = router({
      prepareClipboard: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );

    const stalePreparation = controller.refresh();
    const latestPreparation = controller.refresh();
    second.resolve({ id: "latest" });
    await expect(latestPreparation).resolves.toEqual({ id: "latest" });
    first.resolve({ id: "stale" });
    await expect(stalePreparation).resolves.toBeNull();

    controller.handleCopy(nativeEvent().event);
    expect(selectionRouter.commitPreparedClipboardEvent).toHaveBeenCalledWith(
      "copy",
      expect.anything(),
      { id: "latest" }
    );
    expect(selectionRouter.invalidatePreparedClipboard).toHaveBeenCalledTimes(2);
  });

  it("silently discards a stale failed refresh after the latest succeeds", async () => {
    const first = deferred<TestSession | null>();
    const selectionRouter = router({
      prepareClipboard: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ id: "latest" })
    });
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );

    const stalePreparation = controller.refresh();
    await expect(controller.refresh()).resolves.toEqual({ id: "latest" });
    first.reject(new Error("late failure"));

    await expect(stalePreparation).resolves.toBeNull();
    controller.handleCopy(nativeEvent().event);
    expect(selectionRouter.commitPreparedClipboardEvent).toHaveBeenLastCalledWith(
      "copy",
      expect.anything(),
      { id: "latest" }
    );
  });

  it("invalidates a pending preparation so its completion cannot be installed", async () => {
    const pending = deferred<TestSession | null>();
    const selectionRouter = router({
      prepareClipboard: vi.fn(() => pending.promise)
    });
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    const preparation = controller.prewarm();

    controller.invalidate();
    pending.resolve({ id: "stale" });

    await expect(preparation).resolves.toBeNull();
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "unprepared"
    });
    expect(selectionRouter.commitPreparedClipboardEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["INPUT", 1, 4],
    ["TEXTAREA", 0, 8]
  ])(
    "leaves a non-collapsed %s native selection unowned",
    async (tagName, selectionStart, selectionEnd) => {
      const selectionRouter = router();
      const controller = createNotesSelectionNativeClipboardController(
        selectionRouter
      );
      await controller.prewarm();
      const clipboard = nativeEvent({
        tagName,
        selectionStart,
        selectionEnd
      });

      expect(
        controller.handleCopy(clipboard.event, {
          allowNonTextTarget: true
        })
      ).toEqual({ kind: "unowned", reason: "nativeTextSelection" });
      expect(selectionRouter.commitPreparedClipboardEvent).not.toHaveBeenCalled();
      expect(clipboard.preventDefault).not.toHaveBeenCalled();
    }
  );

  it.each(["INPUT", "TEXTAREA"])(
    "accepts a collapsed caret in a %s",
    async (tagName) => {
      const selectionRouter = router();
      const controller = createNotesSelectionNativeClipboardController(
        selectionRouter
      );
      await controller.prewarm();
      const clipboard = nativeEvent({
        tagName,
        selectionStart: 2,
        selectionEnd: 2
      });

      expect(controller.handleCopy(clipboard.event)).toEqual({
        kind: "committed",
        intent: "copy"
      });
      expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
    }
  );

  it("requires explicit support before owning a non-text target", async () => {
    const selectionRouter = router();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();
    const unsupported = nativeEvent({ tagName: "DIV" });

    expect(controller.handleCopy(unsupported.event)).toEqual({
      kind: "unowned",
      reason: "unsupportedTarget"
    });
    expect(
      controller.handleCopy(nativeEvent({ tagName: "DIV" }).event, {
        allowNonTextTarget: true
      })
    ).toEqual({ kind: "committed", intent: "copy" });
  });

  it("leaves clipboard events unowned during composition or a Process key", async () => {
    const selectionRouter = router();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();

    controller.handleCompositionStart();
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "composition"
    });
    controller.handleCompositionEnd();
    controller.handleKeyDown({ key: "Process" });
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "composition"
    });
    controller.handleKeyUp({ key: "c" });
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "composition"
    });
    controller.handleKeyUp({ key: "Process" });
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "committed",
      intent: "copy"
    });
  });

  it("gates repeated primary C/X clipboard events without owning keydown", async () => {
    const selectionRouter = router();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();

    controller.handleKeyDown({ key: "c", metaKey: true, repeat: false });
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "committed",
      intent: "copy"
    });
    controller.handleKeyDown({ key: "c", ctrlKey: true, repeat: true });
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "repeat"
    });
    controller.handleKeyUp({ key: "c" });
    controller.handleKeyDown({ key: "x", metaKey: true, repeat: true });
    expect(controller.handleCut(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "repeat"
    });
    expect(selectionRouter.commitPreparedClipboardEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "Copy", key: "c", intent: "copy" as const },
    { label: "Cut", key: "x", intent: "cut" as const }
  ])(
    "claims repeated outline $label events until keyup without committing",
    async ({ key, intent }) => {
      const selectionRouter = router();
      const controller = createNotesSelectionNativeClipboardController(
        selectionRouter
      );
      await controller.prewarm();
      const handle =
        intent === "copy" ? controller.handleCopy : controller.handleCut;

      controller.handleKeyDown({ key, metaKey: true, repeat: true });
      for (let index = 0; index < 2; index += 1) {
        const clipboard = nativeEvent();
        expect(handle(clipboard.event, { claimUnprepared: true })).toEqual({
          kind: "claimed",
          reason: "repeat",
          intent
        });
        expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
        expect(clipboard.setData).not.toHaveBeenCalled();
      }
      expect(
        selectionRouter.commitPreparedClipboardEvent
      ).not.toHaveBeenCalled();

      controller.handleKeyUp({ key });
      const afterKeyup = nativeEvent();
      expect(handle(afterKeyup.event, { claimUnprepared: true })).toEqual({
        kind: "committed",
        intent
      });
      expect(
        selectionRouter.commitPreparedClipboardEvent
      ).toHaveBeenCalledOnce();
    }
  );

  it("keeps composition and native text selection ahead of an outline repeat claim", async () => {
    const selectionRouter = router();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();
    controller.handleKeyDown({ key: "c", metaKey: true, repeat: true });

    const composing = nativeEvent();
    expect(
      controller.handleCopy(composing.event, {
        claimUnprepared: true,
        isComposing: true
      })
    ).toEqual({ kind: "unowned", reason: "composition" });
    expect(composing.preventDefault).not.toHaveBeenCalled();

    const nativeSelection = nativeEvent({
      tagName: "TEXTAREA",
      selectionStart: 0,
      selectionEnd: 4
    });
    expect(
      controller.handleCopy(nativeSelection.event, {
        claimUnprepared: true
      })
    ).toEqual({ kind: "unowned", reason: "nativeTextSelection" });
    expect(nativeSelection.preventDefault).not.toHaveBeenCalled();
    expect(
      selectionRouter.commitPreparedClipboardEvent
    ).not.toHaveBeenCalled();
  });

  it("leaves missing and router-rejected sessions unowned", async () => {
    const missingRouter = router();
    const missing = createNotesSelectionNativeClipboardController(missingRouter);
    expect(missing.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "unprepared"
    });

    const rejectedRouter = router({
      commitPreparedClipboardEvent: vi.fn(() => ({
        kind: "rejected" as const,
        reason: "stale" as const
      }))
    });
    const stale = createNotesSelectionNativeClipboardController(rejectedRouter);
    await stale.prewarm();
    const clipboard = nativeEvent();

    expect(stale.handleCopy(clipboard.event)).toEqual({
      kind: "rejected",
      reason: "stale"
    });
    expect(clipboard.preventDefault).not.toHaveBeenCalled();
    expect(stale.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "unprepared"
    });
  });

  it.each(["stale", "busy"] as const)(
    "claims a %s prepared-session rejection and never leaks native Cut",
    async (reason) => {
      const selectionRouter = router({
        commitPreparedClipboardEvent: vi.fn(() => ({
          kind: "rejected" as const,
          reason
        }))
      });
      const onPreparationPending = vi.fn();
      const controller = createNotesSelectionNativeClipboardController(
        selectionRouter,
        { onPreparationPending }
      );
      await controller.prewarm();
      const clipboard = nativeEvent();

      expect(
        controller.handleCut(clipboard.event, { claimUnprepared: true })
      ).toEqual({ kind: "rejected", reason });
      expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
      expect(clipboard.setData).not.toHaveBeenCalled();
      expect(onPreparationPending).toHaveBeenCalledWith("cut");
      expect(selectionRouter.prepareClipboard).toHaveBeenCalledTimes(
        reason === "stale" ? 2 : 1
      );
      expect(
        selectionRouter.invalidatePreparedClipboard
      ).toHaveBeenCalledTimes(reason === "stale" ? 1 : 0);
    }
  );

  it.each([
    {
      label: "unavailable Cut",
      outcome: {
        kind: "rejected" as const,
        reason: "cutUnavailable" as const
      }
    },
    {
      label: "clipboard failure",
      outcome: { kind: "failed" as const, message: "write failed" }
    }
  ])(
    "claims a prepared $label instead of falling through to native Cut",
    async ({ outcome }) => {
      const selectionRouter = router({
        commitPreparedClipboardEvent: vi.fn(() => outcome)
      });
      const controller = createNotesSelectionNativeClipboardController(
        selectionRouter
      );
      await controller.prewarm();
      const clipboard = nativeEvent();

      expect(
        controller.handleCut(clipboard.event, { claimUnprepared: true })
      ).toEqual(outcome);
      expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
      expect(clipboard.setData).not.toHaveBeenCalled();
    }
  );

  it("delegates synchronous dual-MIME Copy to the prepared router session", async () => {
    const selectionRouter = router();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();
    const clipboard = nativeEvent();

    const outcome = controller.handleCopy(clipboard.event);

    expect(outcome).toEqual({ kind: "committed", intent: "copy" });
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(clipboard.setData.mock.calls).toEqual([
      ["text/plain", "- Selected"],
      ["text/markdown", "- Selected"]
    ]);
    expect(clipboard.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("commits a prepared native Cut at most once", async () => {
    const selectionRouter = router();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();
    const first = nativeEvent();
    const repeated = nativeEvent();

    expect(controller.handleCut(first.event)).toEqual({
      kind: "committed",
      intent: "cut"
    });
    expect(controller.handleCut(repeated.event)).toEqual({
      kind: "unowned",
      reason: "unprepared"
    });
    expect(selectionRouter.commitPreparedClipboardEvent).toHaveBeenCalledTimes(1);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(repeated.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves a failed synchronous router commit unowned", async () => {
    const selectionRouter = router({
      commitPreparedClipboardEvent: vi.fn(() => ({
        kind: "failed" as const,
        message: "write failed"
      }))
    });
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();
    const clipboard = nativeEvent();

    expect(controller.handleCopy(clipboard.event)).toEqual({
      kind: "failed",
      message: "write failed"
    });
    expect(clipboard.preventDefault).not.toHaveBeenCalled();
  });

  it("cleanup invalidates the router and prevents later preparation or ownership", async () => {
    const selectionRouter = router();
    const controller = createNotesSelectionNativeClipboardController(
      selectionRouter
    );
    await controller.prewarm();

    controller.dispose();

    expect(selectionRouter.invalidatePreparedClipboard).toHaveBeenCalledTimes(1);
    await expect(controller.prewarm()).resolves.toBeNull();
    expect(controller.handleCopy(nativeEvent().event)).toEqual({
      kind: "unowned",
      reason: "disposed"
    });
    expect(selectionRouter.prepareClipboard).toHaveBeenCalledTimes(1);
  });
});
