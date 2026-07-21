import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
}

function MotionProbe({
  rows,
  activeDrag = false,
  initialLoading = false,
  isComposing = false
}: MotionProbeProps) {
  const rootRef = useRef<HTMLOListElement>(null);
  useOutlineLayoutMotion({
    rootRef,
    rows,
    activeDrag,
    initialLoading,
    isComposing
  });
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

function rows(count: number): TestRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    depth: index === 0 ? 0 : 1
  }));
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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
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

describe("useOutlineLayoutMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} />);
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
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} />);
    });
    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} {...skip} />);
    });

    expect(animate).toHaveBeenCalledOnce();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it("cancels an active animation on resize", () => {
    const { animate, cancels } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} />);
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(animate).toHaveBeenCalledOnce();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it("cancels an active animation when reduced motion becomes preferred", () => {
    const motion = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} />);
    });
    act(() => {
      motion.setReducedMotion(true);
    });

    expect(motion.animate).toHaveBeenCalledOnce();
    expect(motion.cancels[0]).toHaveBeenCalledOnce();
  });

  it("cancels an active animation on unmount", () => {
    const { animate, cancels } = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} />);
    });
    rendered.unmount();

    expect(animate).toHaveBeenCalledOnce();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it("releases completed animations before a later skip condition", async () => {
    const motion = installMotionEnvironment();
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} />);
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
    const rendered = render(<MotionProbe rows={rows(1)} />);

    act(() => {
      rendered.rerender(<MotionProbe rows={rows(2)} />);
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
    expect(motion.cancels[1]).toHaveBeenCalledOnce();
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
