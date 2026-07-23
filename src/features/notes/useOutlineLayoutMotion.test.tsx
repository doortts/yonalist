import { act, render } from "@testing-library/react";
import {
  useCallback,
  useRef,
  useState,
  type MutableRefObject
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as outlineMotion from "./outlineLayoutMotion";
import type {
  KeyboardInsertionDisposition,
  KeyboardInsertionPostcondition,
  KeyboardInsertionSettlement,
  PendingKeyboardInsertion
} from "./notesKeyboardInsertion";
import type { NotesProjectionPublication } from "./notesWorkspaceTypes";
import type { OutlineIdleBaselineScheduler } from "./outlineIdleBaseline";
import { shouldRecordOutlineBaselineActivity } from "./outlineInteractionEpoch";
import { useOutlineLayoutMotion } from "./useOutlineLayoutMotion";

interface TestRow {
  readonly id: string;
  readonly depth: number;
}

interface MotionProbeProps {
  readonly rows: readonly TestRow[];
  readonly activeDrag?: boolean;
  readonly initialLoading?: boolean;
  readonly isComposing?: boolean;
  readonly publication?: NotesProjectionPublication | null;
  readonly insertionDisposition?: KeyboardInsertionDisposition;
  readonly onInsertionMotionConsumed?: (intentToken: number) => void;
  readonly onSettledFirstPaint?: (generation: number) => void;
  readonly schedulerRef?: MutableRefObject<
    OutlineIdleBaselineScheduler | null
  >;
}

const ignoreInsertionMotion = (_intentToken: number) => undefined;
const ignoreSettledFirstPaint = (_generation: number) => undefined;

function MotionProbe({
  rows,
  activeDrag = false,
  initialLoading = false,
  isComposing = false,
  publication = null,
  insertionDisposition = publication?.keyboardInsertionDisposition ?? {
    kind: "unrelated"
  },
  onInsertionMotionConsumed = ignoreInsertionMotion,
  onSettledFirstPaint = ignoreSettledFirstPaint,
  schedulerRef
}: MotionProbeProps) {
  const rootRef = useRef<HTMLOListElement>(null);
  const scheduler = useOutlineLayoutMotion({
    rootRef,
    rows,
    activeDrag,
    initialLoading,
    isComposing,
    publication,
    insertionDisposition,
    onInsertionMotionConsumed,
    onSettledFirstPaint
  });
  if (schedulerRef) {
    schedulerRef.current = scheduler;
  }
  return (
    <ol ref={rootRef}>
      {rows.map((row) => (
        <li
          className="notes-outline-item"
          data-depth={row.depth}
          data-outline-motion-id={row.id}
          key={row.id}
        >
          <div className="notes-node-main" />
        </li>
      ))}
    </ol>
  );
}

function StatefulConsumeMotionProbe({
  publication,
  onInsertionMotionConsumed = ignoreInsertionMotion,
  ...props
}: MotionProbeProps) {
  const [consumedToken, setConsumedToken] = useState<number | null>(null);
  const consumeInsertionMotion = useCallback(
    (intentToken: number) => {
      setConsumedToken(intentToken);
      onInsertionMotionConsumed(intentToken);
    },
    [onInsertionMotionConsumed]
  );
  let visiblePublication = publication;
  if (
    publication?.owner.kind === "keyboard-insertion" &&
    publication.owner.intentToken === consumedToken
  ) {
    const {
      keyboardInsertionDisposition: _consumed,
      ...consumedPublication
    } = publication;
    visiblePublication = consumedPublication;
  }
  return (
    <MotionProbe
      {...props}
      publication={visiblePublication}
      onInsertionMotionConsumed={consumeInsertionMotion}
    />
  );
}

function rows(count: number): TestRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    depth: index === 0 ? 0 : 1
  }));
}

function depthShift(depth: number): TestRow[] {
  return [{ id: "node-0", depth }];
}

function insertionPostcondition(
  kind: "split" | "first-child"
): KeyboardInsertionPostcondition {
  return kind === "split"
    ? {
        kind,
        expectedSourceTitle: "before",
        expectedInsertedTitle: "after"
      }
    : {
        kind,
        expectedParentId: "source",
        expectedIndex: 0,
        expectedInsertedTitle: ""
      };
}

function insertionPublication(options: {
  readonly disposition?: "exact" | "mixed" | "mismatch";
  readonly insertionKind?: "split" | "first-child";
  readonly token?: number;
  readonly projectionGeneration?: number;
  readonly layoutGeneration?: number;
} = {}): NotesProjectionPublication {
  const token = options.token ?? 7;
  const projectionGeneration = options.projectionGeneration ?? 24;
  const layoutGeneration = options.layoutGeneration ?? 13;
  const pending: PendingKeyboardInsertion = {
    intent: {
      token,
      ownerSessionGeneration: 3,
      sourceId: "source",
      expectedNodeId: "inserted",
      postcondition: insertionPostcondition(options.insertionKind ?? "split")
    },
    ownerSessionId: "session-a",
    ownerPaneId: "pane-a",
    interactionEpochAtDispatch: 11,
    expectedStructuralHistoryEpoch: "history-epoch",
    expectedStructuralHistoryEntryId: "history-entry",
    projectionGenerationAtDispatch: 20,
    layoutGenerationAtDispatch: 9,
    paneSnapshotAtDispatch: {
      paneId: "pane-a",
      sessionId: "session-a",
      scope: { kind: "active" },
      zoomedNodeId: null,
      showCompleted: true,
      collapsedNodeIds: new Set(),
      locallyExpandedNodeIds: new Set(),
      interactionEpoch: 11,
      visibleSignature: "before",
      geometryGeneration: 4,
      activeDrag: false
    },
    dragGenerationAtDispatch: 0
  };
  const settlement: KeyboardInsertionSettlement = {
    intentToken: token,
    expectedNodeId: "inserted",
    ownerSessionId: "session-a",
    ownerPaneId: "pane-a",
    ownerSessionGeneration: 3,
    interactionEpochAtDispatch: 11,
    baseProjectionGeneration: 20,
    acceptedProjectionGeneration: projectionGeneration,
    baseLayoutGeneration: 9,
    acceptedLayoutGeneration: layoutGeneration,
    authorityOutcome:
      options.disposition === "mismatch"
        ? "mismatch"
        : "postconditionAccepted",
    focusEligible: options.disposition !== "mismatch"
  };
  return {
    projectionGeneration,
    layoutGeneration,
    owner: { kind: "keyboard-insertion", intentToken: token },
    keyboardInsertionDisposition: {
      kind: options.disposition ?? "exact",
      pending,
      settlement
    }
  };
}

function draftPublication(
  token = 7,
  projectionGeneration = 23
): NotesProjectionPublication {
  return {
    projectionGeneration,
    layoutGeneration: 9,
    owner: { kind: "keyboard-draft", intentToken: token }
  };
}

function unrelatedPublication(
  projectionGeneration: number,
  layoutGeneration: number
): NotesProjectionPublication {
  return {
    projectionGeneration,
    layoutGeneration,
    owner: { kind: "other" }
  };
}

function installMotionEnvironment(reducedMotion = false) {
  let matches = reducedMotion;
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const finishers: (() => void)[] = [];
  const effects: { active: boolean }[] = [];
  const activeTransforms = new Map<string, { x: number; y: number }>();
  const animationCalls: {
    readonly element: HTMLElement;
    readonly keyframes: Keyframe[];
    readonly options: KeyframeAnimationOptions;
  }[] = [];
  const animate = vi.fn(function animate(
    this: HTMLElement,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ) {
    const cancel = vi.fn();
    cancels.push(cancel);
    const effect = { active: true };
    effects.push(effect);
    animationCalls.push({ element: this, keyframes, options });
    const initialTransform = String(keyframes[0]?.transform ?? "");
    const [x, y] = Array.from(
      initialTransform.matchAll(/(-?\d+(?:\.\d+)?)px/g),
      (match) => Number(match[1])
    );
    const motionId = this.dataset.outlineMotionId!;
    const clearEffect = () => {
      effect.active = false;
      activeTransforms.delete(motionId);
    };
    if (x !== undefined && y !== undefined) {
      activeTransforms.set(motionId, { x, y });
    }
    cancel.mockImplementation(clearEffect);
    let finish!: () => void;
    return {
      cancel,
      finished: new Promise<void>((resolve) => {
        finish = () => {
          if (options.fill !== "both") {
            clearEffect();
          }
          resolve();
        };
        finishers.push(finish);
      })
    } as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          mediaListeners.add(listener);
        }
      ),
      removeEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          mediaListeners.delete(listener);
        }
      ),
      addListener: vi.fn(),
      removeListener: vi.fn()
    }))
  );
  const rectRead = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      const row = this.classList.contains("notes-node-main")
        ? this.parentElement
        : this;
      const index = Array.from(
        row?.parentElement?.querySelectorAll(".notes-outline-item") ?? []
      ).indexOf(row as Element);
      const naturalLeft = this.classList.contains("notes-node-main")
        ? Number(row?.dataset.depth ?? 0) * 24
        : 0;
      const transform = activeTransforms.get(row?.dataset.outlineMotionId ?? "") ?? {
        x: 0,
        y: 0
      };
      return {
        x: naturalLeft + transform.x,
        y: index * 28 + transform.y,
        left: naturalLeft + transform.x,
        top: index * 28 + transform.y,
        right: naturalLeft + transform.x + 320,
        bottom: index * 28 + transform.y + 28,
        width: 320,
        height: 28,
        toJSON: () => ({})
      } as DOMRect;
    }
  );
  return {
    animate,
    rectRead,
    cancels,
    effects,
    finishers,
    animationCalls,
    activeTransform(id: string) {
      return activeTransforms.get(id);
    },
    setReducedMotion(next: boolean) {
      matches = next;
      for (const listener of mediaListeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    }
  };
}

function installFrameEnvironment() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled = new Set<number>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancelAnimationFrame = vi.fn((handle: number) => {
    cancelled.add(handle);
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    pendingCount: () =>
      [...callbacks.keys()].filter((handle) => !cancelled.has(handle)).length,
    nextCallback: () => {
      const entry = [...callbacks.entries()].find(
        ([handle]) => !cancelled.has(handle)
      );
      if (!entry) return;
      callbacks.delete(entry[0]);
      entry[1](0);
    },
    callback(handle: number) {
      const callback = callbacks.get(handle);
      return callback
        ? (time: number) => {
            callbacks.delete(handle);
            callback(time);
          }
        : undefined;
    }
  };
}

describe("useOutlineLayoutMotion", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["split", "first-child"] as const)(
    "performs zero rect reads and zero animations for an exact %s settlement",
    (insertionKind) => {
      const motion = installMotionEnvironment();
      const frames = installFrameEnvironment();
      const consumed = vi.fn();
      const painted = vi.fn();
      const rendered = render(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "sibling", depth: 0 }
          ]}
          onInsertionMotionConsumed={consumed}
          onSettledFirstPaint={painted}
        />
      );
      motion.rectRead.mockClear();
      motion.animate.mockClear();
      const publication = insertionPublication({ insertionKind });

      act(() => {
        rendered.rerender(
          <MotionProbe
            rows={[
              { id: "source", depth: 0 },
              { id: "inserted", depth: insertionKind === "split" ? 0 : 1 },
              { id: "sibling", depth: 0 }
            ]}
            publication={publication}
            onInsertionMotionConsumed={consumed}
            onSettledFirstPaint={painted}
          />
        );
      });
      act(() => {
        rendered.rerender(
          <MotionProbe
            rows={[
              { id: "source", depth: 0 },
              { id: "inserted", depth: insertionKind === "split" ? 0 : 1 },
              { id: "sibling", depth: 0 }
            ]}
            publication={publication}
            onInsertionMotionConsumed={consumed}
            onSettledFirstPaint={painted}
          />
        );
      });

      expect(motion.rectRead).not.toHaveBeenCalled();
      expect(motion.animate).not.toHaveBeenCalled();
      expect(consumed).toHaveBeenCalledOnce();
      expect(consumed).toHaveBeenCalledWith(7);
      expect(painted).not.toHaveBeenCalled();
      act(() => {
        frames.nextCallback();
      });
      expect(painted).not.toHaveBeenCalled();
      act(() => {
        frames.nextCallback();
      });
      expect(painted).toHaveBeenCalledOnce();
      expect(painted).toHaveBeenCalledWith(13);
    }
  );

  it("keeps the settled baseline frames after a stateful insertion consume", () => {
    const frames = installFrameEnvironment();
    const motion = installMotionEnvironment();
    const consumed = vi.fn();
    const painted = vi.fn();
    const rendered = render(
      <StatefulConsumeMotionProbe
        rows={[{ id: "source", depth: 0 }]}
        publication={null}
        onInsertionMotionConsumed={consumed}
        onSettledFirstPaint={painted}
      />
    );
    motion.rectRead.mockClear();
    motion.animate.mockClear();

    act(() => {
      rendered.rerender(
        <StatefulConsumeMotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 }
          ]}
          publication={insertionPublication()}
          onInsertionMotionConsumed={consumed}
          onSettledFirstPaint={painted}
        />
      );
    });

    expect(consumed).toHaveBeenCalledOnce();
    expect(frames.pendingCount()).toBe(1);
    expect(motion.rectRead).not.toHaveBeenCalled();
    expect(motion.animate).not.toHaveBeenCalled();

    act(() => {
      frames.nextCallback();
      frames.nextCallback();
    });

    expect(painted).toHaveBeenCalledOnce();
    expect(painted).toHaveBeenCalledWith(13);
  });

  it("re-arms terminal paint after a synchronous capture cancels its second frame", () => {
    const frames = installFrameEnvironment();
    installMotionEnvironment();
    const painted = vi.fn();
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        schedulerRef={schedulerRef}
        onSettledFirstPaint={painted}
      />
    );

    act(() => {
      schedulerRef.current?.suspendForPendingInsertion(7, 9);
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 }
          ]}
          publication={insertionPublication()}
          schedulerRef={schedulerRef}
          onSettledFirstPaint={painted}
        />
      );
    });
    act(() => {
      frames.nextCallback();
    });
    act(() => {
      schedulerRef.current?.completeFromSynchronousCapture(13);
    });

    expect(painted).not.toHaveBeenCalled();
    expect(frames.pendingCount()).toBe(1);
    act(() => {
      frames.nextCallback();
      frames.nextCallback();
    });

    expect(painted).toHaveBeenCalledOnce();
    expect(painted).toHaveBeenCalledWith(13);
  });

  it("re-arms terminal paint after mismatch motion captures synchronously", () => {
    const frames = installFrameEnvironment();
    installMotionEnvironment();
    const painted = vi.fn();
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        schedulerRef={schedulerRef}
        onSettledFirstPaint={painted}
      />
    );
    const publication = insertionPublication({
      disposition: "mismatch"
    });

    act(() => {
      schedulerRef.current?.suspendForPendingInsertion(7, 9);
      rendered.rerender(
        <MotionProbe
          rows={[{ id: "source", depth: 1 }]}
          publication={publication}
          insertionDisposition={publication.keyboardInsertionDisposition}
          schedulerRef={schedulerRef}
          onSettledFirstPaint={painted}
        />
      );
    });

    expect(frames.pendingCount()).toBe(1);
    act(() => {
      frames.nextCallback();
      frames.nextCallback();
    });

    expect(painted).toHaveBeenCalledOnce();
    expect(painted).toHaveBeenCalledWith(13);
  });

  it("arms one idle baseline only after two generation-matched frames", () => {
    vi.useFakeTimers();
    const frames = installFrameEnvironment();
    const motion = installMotionEnvironment();
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleHandle = 1;
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        const handle = nextIdleHandle++;
        idleCallbacks.set(handle, callback);
        return handle;
      })
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((handle: number) => idleCallbacks.delete(handle))
    );
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        schedulerRef={schedulerRef}
      />
    );
    motion.rectRead.mockClear();

    act(() => {
      schedulerRef.current?.suspendForPendingInsertion(7, 9);
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 }
          ]}
          publication={insertionPublication()}
          schedulerRef={schedulerRef}
        />
      );
    });
    expect(schedulerRef.current?.pendingCount()).toBe(0);
    expect(frames.pendingCount()).toBe(1);

    act(() => {
      frames.nextCallback();
    });
    expect(schedulerRef.current?.pendingCount()).toBe(0);
    expect(motion.rectRead).not.toHaveBeenCalled();

    act(() => {
      frames.nextCallback();
    });
    expect(schedulerRef.current?.pendingCount()).toBe(1);
    expect(motion.rectRead).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(idleCallbacks.size).toBe(1);
    act(() => {
      const callback = idleCallbacks.values().next().value;
      callback?.({
        didTimeout: false,
        timeRemaining: () => 8
      });
      idleCallbacks.clear();
    });

    expect(motion.rectRead).toHaveBeenCalled();
    expect(schedulerRef.current?.pendingCount()).toBe(0);
  });

  it("cancels pending idle work when the next Enter is prepared", () => {
    vi.useFakeTimers();
    const frames = installFrameEnvironment();
    const motion = installMotionEnvironment();
    const requestIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdle);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        schedulerRef={schedulerRef}
      />
    );
    act(() => {
      schedulerRef.current?.suspendForPendingInsertion(7, 9);
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 }
          ]}
          publication={insertionPublication()}
          schedulerRef={schedulerRef}
        />
      );
    });
    act(() => {
      frames.nextCallback();
      frames.nextCallback();
    });
    expect(schedulerRef.current?.pendingCount()).toBe(1);
    motion.rectRead.mockClear();

    act(() => {
      schedulerRef.current?.suspendForPendingInsertion(8, 13);
      vi.advanceTimersByTime(2_000);
    });

    expect(schedulerRef.current?.pendingCount()).toBe(0);
    expect(requestIdle).not.toHaveBeenCalled();
    expect(motion.rectRead).not.toHaveBeenCalled();
  });

  it("invalidates nested frames on a newer settlement and on unmount", () => {
    vi.useFakeTimers();
    const frames = installFrameEnvironment();
    installMotionEnvironment();
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        schedulerRef={schedulerRef}
      />
    );
    act(() => {
      schedulerRef.current?.suspendForPendingInsertion(7, 9);
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 }
          ]}
          publication={insertionPublication({ token: 7 })}
          schedulerRef={schedulerRef}
        />
      );
    });
    const staleFirstFrame = frames.callback(1);
    act(() => {
      schedulerRef.current?.suspendForPendingInsertion(8, 13);
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 },
            { id: "newer", depth: 0 }
          ]}
          publication={insertionPublication({
            token: 8,
            projectionGeneration: 25,
            layoutGeneration: 14
          })}
          schedulerRef={schedulerRef}
        />
      );
      staleFirstFrame?.(0);
    });
    expect(schedulerRef.current?.pendingCount()).toBe(0);
    expect(frames.pendingCount()).toBe(1);

    act(() => {
      frames.nextCallback();
      frames.nextCallback();
    });
    expect(schedulerRef.current?.pendingCount()).toBe(1);
    rendered.unmount();
    vi.advanceTimersByTime(1_000);

    expect(schedulerRef.current?.pendingCount()).toBe(0);
  });

  it("rejects prepared insertion termination and activity callbacks after unmount", () => {
    vi.useFakeTimers();
    const frames = installFrameEnvironment();
    const motion = installMotionEnvironment();
    const requestIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdle);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        schedulerRef={schedulerRef}
      />
    );
    const retainedScheduler = schedulerRef.current;

    act(() => {
      retainedScheduler?.suspendForPendingInsertion(7, 13);
    });
    rendered.unmount();
    frames.requestAnimationFrame.mockClear();
    motion.rectRead.mockClear();

    act(() => {
      retainedScheduler?.afterSettledFirstPaint(7, 13);
      retainedScheduler?.noteActivity(13);
      vi.advanceTimersByTime(2_000);
    });

    expect(retainedScheduler?.pendingCount()).toBe(0);
    expect(frames.requestAnimationFrame).not.toHaveBeenCalled();
    expect(requestIdle).not.toHaveBeenCalled();
    expect(motion.rectRead).not.toHaveBeenCalled();
  });

  it("ignores old Vault termination without poisoning the live hook", () => {
    vi.useFakeTimers();
    installFrameEnvironment();
    installMotionEnvironment();
    vi.stubGlobal("requestIdleCallback", vi.fn());
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        schedulerRef={schedulerRef}
      />
    );
    const controller = schedulerRef.current as OutlineIdleBaselineScheduler & {
      resetForVaultReplacement(): void;
    };

    act(() => {
      controller.suspendForPendingInsertion(7, 13);
      controller.afterSettledFirstPaint(7, 13);
    });
    expect(controller.pendingCount()).toBe(1);

    act(() => {
      controller.resetForVaultReplacement();
    });
    expect(controller.pendingCount()).toBe(0);

    act(() => {
      controller.afterSettledFirstPaint(7, 13);
      controller.suspendForPendingInsertion(8, 1);
      controller.afterSettledFirstPaint(8, 1);
    });
    expect(controller.pendingCount()).toBe(1);
  });

  it("does not carry a replaced Vault generation into the new idle baseline", () => {
    vi.useFakeTimers();
    const frames = installFrameEnvironment();
    const motion = installMotionEnvironment();
    const idleCallbacks: IdleRequestCallback[] = [];
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      })
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const schedulerRef = {
      current: null
    } as MutableRefObject<OutlineIdleBaselineScheduler | null>;
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        publication={unrelatedPublication(24, 13)}
        schedulerRef={schedulerRef}
      />
    );
    const controller = schedulerRef.current as OutlineIdleBaselineScheduler & {
      resetForVaultReplacement(): void;
    };

    act(() => {
      controller.resetForVaultReplacement();
      if (shouldRecordOutlineBaselineActivity("pane-switch")) {
        controller.noteActivity(13);
      }
      rendered.rerender(
        <MotionProbe
          rows={[{ id: "source", depth: 0 }]}
          publication={unrelatedPublication(1, 1)}
          schedulerRef={schedulerRef}
        />
      );
      controller.suspendForPendingInsertion(8, 1);
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 }
          ]}
          publication={insertionPublication({
            token: 8,
            projectionGeneration: 2,
            layoutGeneration: 1
          })}
          schedulerRef={schedulerRef}
        />
      );
    });
    motion.rectRead.mockClear();

    act(() => {
      frames.nextCallback();
      frames.nextCallback();
      vi.advanceTimersByTime(150);
      idleCallbacks.shift()?.({
        didTimeout: false,
        timeRemaining: () => 8
      });
    });

    expect(motion.rectRead).toHaveBeenCalled();
    expect(controller.pendingCount()).toBe(0);
  });

  it("performs zero rect reads and zero animations for an ownership-proven mixed settlement", () => {
    const motion = installMotionEnvironment();
    const consumed = vi.fn();
    const rendered = render(
      <MotionProbe
        rows={[
          { id: "source", depth: 0 },
          { id: "sibling", depth: 0 }
        ]}
        onInsertionMotionConsumed={consumed}
      />
    );
    motion.rectRead.mockClear();
    const publication = insertionPublication({ disposition: "mixed" });

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 },
            { id: "sibling", depth: 1 }
          ]}
          publication={publication}
          onInsertionMotionConsumed={consumed}
        />
      );
    });

    expect(motion.rectRead).not.toHaveBeenCalled();
    expect(motion.animate).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledOnce();
  });

  it("keeps an exact Enter settlement at zero reads under reduced motion", () => {
    const motion = installMotionEnvironment(true);
    const consumed = vi.fn();
    const rendered = render(
      <MotionProbe
        rows={[{ id: "source", depth: 0 }]}
        onInsertionMotionConsumed={consumed}
      />
    );
    motion.rectRead.mockClear();
    const publication = insertionPublication();

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "source", depth: 0 },
            { id: "inserted", depth: 0 }
          ]}
          publication={publication}
          onInsertionMotionConsumed={consumed}
        />
      );
    });

    expect(motion.rectRead).not.toHaveBeenCalled();
    expect(motion.animate).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledOnce();
  });

  it("does not capture or consume a same-intent non-layout draft publication", () => {
    const motion = installMotionEnvironment();
    const consumed = vi.fn();
    const stableRows = [{ id: "source", depth: 0 }];
    const rendered = render(
      <MotionProbe
        rows={stableRows}
        onInsertionMotionConsumed={consumed}
      />
    );
    motion.rectRead.mockClear();

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={stableRows}
          publication={draftPublication()}
          onInsertionMotionConsumed={consumed}
        />
      );
    });

    expect(motion.rectRead).not.toHaveBeenCalled();
    expect(motion.animate).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
  });

  it("captures the first unrelated structural transition after Enter and animates the next", () => {
    const motion = installMotionEnvironment();
    const insertedRows = [
      { id: "source", depth: 0 },
      { id: "inserted", depth: 0 },
      { id: "sibling", depth: 0 }
    ];
    const rendered = render(
      <MotionProbe
        rows={[
          { id: "source", depth: 0 },
          { id: "sibling", depth: 0 }
        ]}
      />
    );
    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={insertedRows}
          publication={insertionPublication()}
        />
      );
    });
    motion.rectRead.mockClear();
    motion.animate.mockClear();

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={insertedRows.map((row) =>
            row.id === "sibling" ? { ...row, depth: 1 } : row
          )}
          publication={unrelatedPublication(25, 14)}
        />
      );
    });
    expect(motion.rectRead).toHaveBeenCalled();
    expect(motion.animate).not.toHaveBeenCalled();
    motion.rectRead.mockClear();

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={insertedRows}
          publication={unrelatedPublication(26, 15)}
        />
      );
    });
    expect(motion.rectRead).toHaveBeenCalled();
    expect(motion.animate).toHaveBeenCalled();
  });

  it("cancels a queued idle read when the first unrelated transition captures synchronously", () => {
    vi.useFakeTimers();
    const frames = installFrameEnvironment();
    const motion = installMotionEnvironment();
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.set(1, callback);
        return 1;
      })
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((handle: number) => idleCallbacks.delete(handle))
    );
    const insertedRows = [
      { id: "source", depth: 0 },
      { id: "inserted", depth: 0 }
    ];
    const rendered = render(
      <MotionProbe rows={[{ id: "source", depth: 0 }]} />
    );
    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={insertedRows}
          publication={insertionPublication()}
        />
      );
    });
    act(() => {
      frames.nextCallback();
      frames.nextCallback();
      vi.advanceTimersByTime(150);
    });
    const staleIdle = idleCallbacks.get(1);
    motion.rectRead.mockClear();

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={insertedRows.map((row) => ({ ...row, depth: 1 }))}
          publication={unrelatedPublication(25, 14)}
        />
      );
    });
    const readsAfterSynchronousCapture = motion.rectRead.mock.calls.length;
    act(() => {
      staleIdle?.({
        didTimeout: false,
        timeRemaining: () => 8
      });
    });

    expect(readsAfterSynchronousCapture).toBeGreaterThan(0);
    expect(motion.rectRead).toHaveBeenCalledTimes(
      readsAfterSynchronousCapture
    );
  });

  it("retains normal layout motion for a mismatched insertion publication", () => {
    const motion = installMotionEnvironment();
    const rendered = render(
      <MotionProbe rows={[{ id: "source", depth: 0 }]} />
    );
    motion.rectRead.mockClear();

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={[{ id: "source", depth: 1 }]}
          publication={insertionPublication({ disposition: "mismatch" })}
          insertionDisposition={
            insertionPublication({ disposition: "mismatch" })
              .keyboardInsertionDisposition
          }
        />
      );
    });

    expect(motion.rectRead).toHaveBeenCalled();
    expect(motion.animate).toHaveBeenCalledOnce();
  });

  it("animates the lone entering child of an unrelated expand", () => {
    const motion = installMotionEnvironment();
    const rendered = render(
      <MotionProbe rows={[{ id: "parent", depth: 0 }]} />
    );
    motion.animate.mockClear();

    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "parent", depth: 0 },
            { id: "child", depth: 1 }
          ]}
          publication={unrelatedPublication(25, 14)}
        />
      );
    });

    expect(motion.animate).toHaveBeenCalledOnce();
    expect(motion.animationCalls[0]?.element.dataset.outlineMotionId).toBe(
      "child"
    );
  });

  it.each([
    ["active drag", { activeDrag: true }],
    ["IME composition", { isComposing: true }],
    ["initial load", { initialLoading: true }]
  ])("skips layout animation during %s", (_label, skip) => {
    const { animate } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} {...skip} />);
    });

    expect(animate).not.toHaveBeenCalled();
  });

  it("skips layout animation when reduced motion is preferred", () => {
    const { animate } = installMotionEnvironment(true);
    const rendered = render(<MotionProbe rows={depthShift(0)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={depthShift(1)} />);
    });

    expect(animate).not.toHaveBeenCalled();
  });

  it("skips layout animation when the visible row limit is exceeded", () => {
    const { animate } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={rows(120)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(121)} />);
    });

    expect(animate).not.toHaveBeenCalled();
  });

  it("re-establishes a baseline after returning below the visible row limit", () => {
    const { animate } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={rows(120)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(121)} />);
    });
    act(() => {
      rendered.rerender(<MotionProbe rows={rows(120)} />);
    });
    act(() => {
      rendered.rerender(
        <MotionProbe
          rows={rows(120).map((row) => ({ ...row, depth: row.depth + 1 }))}
        />
      );
    });

    expect(animate).not.toHaveBeenCalled();
  });

  it.each([
    ["a drag starts", { activeDrag: true }],
    ["IME composition starts", { isComposing: true }]
  ])("cancels an active animation when %s", (_label, skip) => {
    const { animate, cancels } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={depthShift(0)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={depthShift(1)} />);
    });
    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} {...skip} />);
    });

    expect(animate).toHaveBeenCalledOnce();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it("cancels an active animation on resize", () => {
    const { animate, cancels } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={depthShift(0)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={depthShift(1)} />);
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(animate).toHaveBeenCalledOnce();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it("recaptures the outline motion baseline after a resize settles", () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    installMotionEnvironment();
    const capture = vi.spyOn(outlineMotion, "captureOutlineMotionRects");
    render(<MotionProbe rows={rows(2)} />);
    capture.mockClear();

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(capture).not.toHaveBeenCalled();

    act(() => {
      for (const callback of rafCallbacks) callback(0);
    });
    expect(capture).toHaveBeenCalled();
  });

  it("clamps moved rows against the viewport, not the root content height", () => {
    const motion = installMotionEnvironment();
    // Long outline: the root's content height dwarfs the viewport. A clamp
    // sourced from root.clientHeight (5000) would never fire; one sourced from
    // the viewport (768) teleports a row that jumped ~900px.
    const tops: Record<string, number> = { a: 0, b: 28 };
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        const row = this.classList.contains("notes-node-main")
          ? this.parentElement
          : this;
        const id = (row as HTMLElement | null)?.dataset.outlineMotionId;
        const top = id ? (tops[id] ?? 0) : 0;
        return {
          x: 0,
          y: top,
          left: 0,
          top,
          right: 320,
          bottom: top + 28,
          width: 320,
          height: 28,
          toJSON: () => ({})
        } as DOMRect;
      }
    );
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });

    const rendered = render(
      <MotionProbe
        rows={[
          { id: "a", depth: 0 },
          { id: "b", depth: 0 }
        ]}
      />
    );
    const ol = rendered.container.querySelector("ol")!;
    Object.defineProperty(ol, "clientHeight", { configurable: true, value: 5000 });
    Object.defineProperty(ol, "clientWidth", { configurable: true, value: 5000 });

    act(() => {
      tops.a = 900;
      tops.b = 100;
      rendered.rerender(
        <MotionProbe
          rows={[
            { id: "a", depth: 1 },
            { id: "b", depth: 0 }
          ]}
        />
      );
    });

    const animatedIds = motion.animationCalls.map(
      (call) => call.element.dataset.outlineMotionId
    );
    expect(animatedIds).not.toContain("a");
    expect(animatedIds).toContain("b");
  });

  it("cancels an active animation when reduced motion becomes preferred", () => {
    const motion = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={depthShift(0)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={depthShift(1)} />);
    });
    act(() => {
      motion.setReducedMotion(true);
    });

    expect(motion.animate).toHaveBeenCalledOnce();
    expect(motion.cancels[0]).toHaveBeenCalledOnce();
  });

  it("cancels an active animation on unmount", () => {
    const { animate, cancels } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={depthShift(0)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={depthShift(1)} />);
    });
    rendered.unmount();

    expect(animate).toHaveBeenCalledOnce();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it("releases completed animations before a later skip condition", async () => {
    const motion = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={depthShift(0)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={depthShift(1)} />);
    });
    await act(async () => {
      motion.finishers[0]!();
      await Promise.resolve();
    });
    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} activeDrag />);
    });

    expect(motion.cancels[0]).not.toHaveBeenCalled();
  });

  it("leaves no retained WAAPI effect after a successful animation", async () => {
    const motion = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={depthShift(0)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={depthShift(1)} />);
    });
    await act(async () => {
      motion.finishers[0]!();
      await Promise.resolve();
    });

    expect(motion.effects[0]?.active).toBe(false);
    expect(motion.animationCalls[0]?.options.fill).not.toBe("both");
  });

  it("uses the node-main anchor to animate a depth change horizontally", () => {
    const motion = installMotionEnvironment();
    const rendered = render(
      <MotionProbe rows={[{ id: "node-0", depth: 0 }]} />
    );

    act(() => {
      rendered.rerender(<MotionProbe rows={[{ id: "node-0", depth: 1 }]} />);
    });

    expect(motion.animate).toHaveBeenCalledOnce();
    expect(motion.animationCalls[0]?.keyframes[0]).toMatchObject({
      transform: "translate3d(-24px, 0px, 0)"
    });
  });

  it("cancels the prior FLIP run during a rapid expand and collapse", () => {
    const motion = installMotionEnvironment();
    const collapsed = [
      { id: "node-0", depth: 0 },
      { id: "node-2", depth: 0 }
    ];
    const expanded = [
      { id: "node-0", depth: 0 },
      { id: "node-1", depth: 1 },
      { id: "node-2", depth: 0 }
    ];
    const rendered = render(<MotionProbe rows={collapsed} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={expanded} />);
    });
    act(() => {
      rendered.rerender(<MotionProbe rows={collapsed} />);
    });

    expect(motion.animate).toHaveBeenCalledTimes(3);
    expect(motion.cancels[0]).toHaveBeenCalledOnce();
  });

  it("cancels a prior transform before reading the next rapid projection", () => {
    const motion = installMotionEnvironment();
    const collapsed = [
      { id: "node-0", depth: 0 },
      { id: "node-2", depth: 0 }
    ];
    const expanded = [
      { id: "node-0", depth: 0 },
      { id: "node-1", depth: 1 },
      { id: "node-2", depth: 0 }
    ];
    const rendered = render(<MotionProbe rows={collapsed} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={expanded} />);
    });
    expect(motion.cancels).toHaveLength(2);
    expect(motion.cancels.every((cancel) => cancel.mock.calls.length === 0)).toBe(
      true
    );
    expect(motion.activeTransform("node-2")).toEqual({ x: 0, y: -28 });
    act(() => {
      rendered.rerender(<MotionProbe rows={collapsed} />);
    });

    const nodeTwoCalls = motion.animationCalls.filter(
      ({ element }) => element.dataset.outlineMotionId === "node-2"
    );
    expect(nodeTwoCalls).toHaveLength(2);
    expect(nodeTwoCalls[1]?.keyframes[0]).toMatchObject({
      transform: "translate3d(0px, 28px, 0)"
    });
  });
});
