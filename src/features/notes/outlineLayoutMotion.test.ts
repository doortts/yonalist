import { afterEach, describe, expect, it, vi } from "vitest";
import {
  animateOutlineMotion,
  calculateOutlineFlipDelta,
  captureOutlineMotionRects,
  collectOutlineMotionTargets,
  identifyMovedRowIds,
  SCENE_CHANGE_ENTER_RATIO,
  SCENE_CHANGE_MIN_ROWS
} from "./outlineLayoutMotion";

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildSceneTargets(rowCount: number, enteringCount: number) {
  const root = document.createElement("ol");
  const before = new Map<
    string,
    { left: number; top: number; width: number; height: number }
  >();
  const animateSpies: ReturnType<typeof vi.fn>[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const row = document.createElement("li");
    row.className = "notes-outline-item";
    row.dataset.outlineMotionId = `r${index}`;
    defineRect(row, () => ({ left: 0, top: index * 28, width: 320, height: 28 }));
    const spy = vi.fn(() => ({ cancel: vi.fn() }));
    animateSpies.push(spy);
    Object.defineProperty(row, "animate", { value: spy });
    root.append(row);
    if (index >= enteringCount) {
      // Existing (non-entering) rows carry a small delta so, absent scene-change
      // suppression, they would animate too.
      before.set(`r${index}`, {
        left: 0,
        top: index * 28 + 12,
        width: 320,
        height: 28
      });
    }
  }
  return { targets: collectOutlineMotionTargets(root, before), animateSpies };
}

function defineRect(
  element: HTMLElement,
  read: () => { left: number; top: number; width: number; height: number }
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const box = read();
      return {
        ...box,
        x: box.left,
        y: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        toJSON: () => ({})
      } as DOMRect;
    }
  });
}

describe("calculateOutlineFlipDelta", () => {
  it("returns the inverse movement from the old row rect to the new row rect", () => {
    expect(
      calculateOutlineFlipDelta(
        { left: 40, top: 120, width: 300, height: 28 },
        { left: 72, top: 164, width: 300, height: 28 }
      )
    ).toEqual({ x: -32, y: -44 });
  });
});

describe("outline layout motion targets", () => {
  it("uses an outer motion identity without taking over the node identity attribute", () => {
    const root = document.createElement("ol");
    const item = document.createElement("li");
    item.className = "notes-outline-item";
    item.dataset.outlineMotionId = "row";
    const node = document.createElement("div");
    node.dataset.outlineId = "row";
    item.append(node);
    root.append(item);
    Object.defineProperty(item, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 300, height: 28 })
    });

    const [target] = collectOutlineMotionTargets(root, new Map());

    expect(target?.element).toBe(item);
  });

  it("slides a moving row and leaves a lone entering row unanimated", () => {
    const root = document.createElement("ol");
    const existing = document.createElement("li");
    existing.className = "notes-outline-item";
    existing.dataset.outlineMotionId = "existing";
    const entering = document.createElement("li");
    entering.className = "notes-outline-item";
    entering.dataset.outlineMotionId = "entering";
    root.append(existing, entering);

    Object.defineProperty(existing, "getBoundingClientRect", {
      value: () => ({ left: 72, top: 164, width: 300, height: 28 })
    });
    Object.defineProperty(entering, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 192, width: 300, height: 28 })
    });
    const existingAnimate = vi.fn(() => ({ cancel: vi.fn() }));
    const enteringAnimate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(existing, "animate", { value: existingAnimate });
    Object.defineProperty(entering, "animate", { value: enteringAnimate });

    const targets = collectOutlineMotionTargets(
      root,
      new Map([["existing", { left: 40, top: 120, width: 300, height: 28 }]])
    );

    animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false });

    expect(existingAnimate).toHaveBeenCalledWith(
      [
        { transform: "translate3d(-32px, -44px, 0)", opacity: 1 },
        { transform: "translate3d(0, 0, 0)", opacity: 1 }
      ],
      {
        duration: 300,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)"
      }
    );
    expect(enteringAnimate).not.toHaveBeenCalled();
  });

  it("stays scroll-invariant so a uniform viewport shift produces no motion", () => {
    const root = document.createElement("ol");
    const rowA = document.createElement("li");
    rowA.className = "notes-outline-item";
    rowA.dataset.outlineMotionId = "a";
    const rowB = document.createElement("li");
    rowB.className = "notes-outline-item";
    rowB.dataset.outlineMotionId = "b";
    root.append(rowA, rowB);

    let scroll = 0;
    defineRect(root, () => ({ left: 10, top: 100 + scroll, width: 320, height: 56 }));
    defineRect(rowA, () => ({ left: 10, top: 100 + scroll, width: 320, height: 28 }));
    defineRect(rowB, () => ({ left: 10, top: 128 + scroll, width: 320, height: 28 }));
    const animateA = vi.fn(() => ({ cancel: vi.fn() }));
    const animateB = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(rowA, "animate", { value: animateA });
    Object.defineProperty(rowB, "animate", { value: animateB });

    const before = captureOutlineMotionRects(root);
    scroll = 200;
    const targets = collectOutlineMotionTargets(root, before);

    for (const target of targets) {
      expect(calculateOutlineFlipDelta(target.before, target.after)).toEqual({
        x: 0,
        y: 0
      });
    }
    expect(
      animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false })
    ).toEqual([]);
    expect(animateA).not.toHaveBeenCalled();
    expect(animateB).not.toHaveBeenCalled();
  });

  it("teleports a row whose delta exceeds the clamp limit while still animating others", () => {
    const root = document.createElement("ol");
    const stale = document.createElement("li");
    stale.className = "notes-outline-item";
    stale.dataset.outlineMotionId = "stale";
    const normal = document.createElement("li");
    normal.className = "notes-outline-item";
    normal.dataset.outlineMotionId = "normal";
    root.append(stale, normal);
    defineRect(stale, () => ({ left: 0, top: 0, width: 320, height: 28 }));
    defineRect(normal, () => ({ left: 0, top: 40, width: 320, height: 28 }));
    const staleAnimate = vi.fn(() => ({ cancel: vi.fn() }));
    const normalAnimate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(stale, "animate", { value: staleAnimate });
    Object.defineProperty(normal, "animate", { value: normalAnimate });

    const targets = collectOutlineMotionTargets(
      root,
      new Map([
        ["stale", { left: 0, top: 5000, width: 320, height: 28 }],
        ["normal", { left: 0, top: 70, width: 320, height: 28 }]
      ])
    );

    animateOutlineMotion(targets, {
      durationMs: 180,
      reducedMotion: false,
      clampLimit: { x: 320, y: 600 }
    });

    expect(staleAnimate).not.toHaveBeenCalled();
    expect(normalAnimate).toHaveBeenCalledOnce();
  });

  it("does nothing when the runtime does not support the Web Animations API", () => {
    const root = document.createElement("ol");
    const row = document.createElement("li");
    row.className = "notes-outline-item";
    row.dataset.outlineMotionId = "row";
    root.append(row);
    Object.defineProperty(row, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 300, height: 28 })
    });

    expect(
      animateOutlineMotion(collectOutlineMotionTargets(root, new Map()), {
        durationMs: 180,
        reducedMotion: false
      })
    ).toEqual([]);
  });
});

describe("outline motion scene changes", () => {
  it("exposes the scene-change thresholds it applies", () => {
    expect(SCENE_CHANGE_ENTER_RATIO).toBe(0.5);
    expect(SCENE_CHANGE_MIN_ROWS).toBe(8);
  });

  it("suppresses all motion when most of a large outline is entering", () => {
    const { targets, animateSpies } = buildSceneTargets(10, 6);

    expect(
      animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false })
    ).toEqual([]);
    for (const spy of animateSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("still animates when only a minority of a large outline is entering", () => {
    const { targets } = buildSceneTargets(10, 4);

    expect(
      animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false })
    ).toHaveLength(10);
  });

  it("still animates a small outline even when most rows are entering", () => {
    const { targets } = buildSceneTargets(6, 4);

    expect(
      animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false })
    ).toHaveLength(6);
  });
});

function buildMovedRow(
  collect: typeof collectOutlineMotionTargets,
  animate: typeof animateOutlineMotion
) {
  const root = document.createElement("ol");
  const row = document.createElement("li");
  row.className = "notes-outline-item";
  row.dataset.outlineMotionId = "moved";
  defineRect(row, () => ({ left: 0, top: 40, width: 320, height: 28 }));
  const spy = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
  Object.defineProperty(row, "animate", { value: spy });
  root.append(row);
  const targets = collect(
    root,
    new Map([["moved", { left: 0, top: 0, width: 320, height: 28 }]])
  );
  animate(targets, { durationMs: 180, reducedMotion: false });
  return spy;
}

describe("outline motion easing", () => {
  it("settles moved rows with a long non-overshooting ease-out", () => {
    const spy = buildMovedRow(collectOutlineMotionTargets, animateOutlineMotion);

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        duration: 300
      })
    );
  });

  it("never uses an overshooting linear() spring, even when the engine supports it", async () => {
    vi.resetModules();
    vi.stubGlobal("CSS", { supports: () => true });
    const mod = await import("./outlineLayoutMotion");

    const spy = buildMovedRow(
      mod.collectOutlineMotionTargets,
      mod.animateOutlineMotion
    );

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        easing: expect.not.stringContaining("linear(")
      })
    );
  });

  it("uses a distinct decelerate easing for entering rows on a multi-row reveal", () => {
    const root = document.createElement("ol");
    const row = document.createElement("li");
    row.className = "notes-outline-item";
    row.dataset.outlineMotionId = "entering";
    defineRect(row, () => ({ left: 0, top: 0, width: 320, height: 28 }));
    const spy = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
    Object.defineProperty(row, "animate", { value: spy });
    // A second entering row makes this an expand — a lone entering row would
    // not animate at all (see the new-bullet test above).
    const row2 = document.createElement("li");
    row2.className = "notes-outline-item";
    row2.dataset.outlineMotionId = "entering2";
    defineRect(row2, () => ({ left: 0, top: 28, width: 320, height: 28 }));
    Object.defineProperty(row2, "animate", {
      value: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }))
    });
    root.append(row, row2);

    animateOutlineMotion(collectOutlineMotionTargets(root, new Map()), {
      durationMs: 180,
      reducedMotion: false
    });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ easing: "cubic-bezier(0, 0, 0.2, 1)" })
    );
  });
});

function buildMovedRows(count: number) {
  const root = document.createElement("ol");
  const before = new Map<
    string,
    { left: number; top: number; width: number; height: number }
  >();
  const spies: ReturnType<typeof vi.fn>[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("li");
    row.className = "notes-outline-item";
    row.dataset.outlineMotionId = `m${index}`;
    defineRect(row, () => ({ left: 0, top: index * 28, width: 320, height: 28 }));
    const spy = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
    spies.push(spy);
    Object.defineProperty(row, "animate", { value: spy });
    root.append(row);
    before.set(`m${index}`, {
      left: 0,
      top: index * 28 + 40,
      width: 320,
      height: 28
    });
  }
  return { targets: collectOutlineMotionTargets(root, before), spies };
}

describe("outline motion stagger", () => {
  it("staggers moved rows by their vertical order and holds them on the start keyframe", () => {
    const { targets, spies } = buildMovedRows(5);

    animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false });

    [0, 8, 16, 24, 32].forEach((delay, index) => {
      expect(spies[index]).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ delay, fill: "backwards" })
      );
    });
  });

  it("does not stagger two or fewer rows", () => {
    const { targets, spies } = buildMovedRows(2);

    animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false });

    for (const spy of spies) {
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ fill: "backwards" })
      );
    }
  });
});

function buildUnfoldChild(options: {
  parentTop: number;
  childTop: number;
  parentEntering?: boolean;
  parentId?: string;
}) {
  const root = document.createElement("ol");
  const parent = document.createElement("li");
  parent.className = "notes-outline-item";
  parent.dataset.outlineMotionId = "p";
  const child = document.createElement("li");
  child.className = "notes-outline-item";
  child.dataset.outlineMotionId = "c";
  // A second entering sibling keeps this a multi-row reveal (an expand), the
  // only case that unfolds — a lone entering row uses the calm fade instead.
  const sibling = document.createElement("li");
  sibling.className = "notes-outline-item";
  sibling.dataset.outlineMotionId = "c2";
  defineRect(parent, () => ({ left: 0, top: options.parentTop, width: 320, height: 28 }));
  defineRect(child, () => ({ left: 0, top: options.childTop, width: 320, height: 28 }));
  defineRect(sibling, () => ({ left: 0, top: options.childTop + 28, width: 320, height: 28 }));
  const parentAnimate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
  const childAnimate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
  const siblingAnimate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
  Object.defineProperty(parent, "animate", { value: parentAnimate });
  Object.defineProperty(child, "animate", { value: childAnimate });
  Object.defineProperty(sibling, "animate", { value: siblingAnimate });
  root.append(parent, child, sibling);
  const before = new Map<
    string,
    { left: number; top: number; width: number; height: number }
  >();
  if (!options.parentEntering) {
    before.set("p", { left: 0, top: options.parentTop, width: 320, height: 28 });
  }
  const parentById =
    options.parentId === undefined
      ? new Map()
      : new Map([
          ["c", options.parentId],
          ["c2", options.parentId]
        ]);
  const targets = collectOutlineMotionTargets(root, before, parentById);
  animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false });
  return childAnimate;
}

function buildSoloEnteringChild(options: { parentId?: string }) {
  const root = document.createElement("ol");
  const parent = document.createElement("li");
  parent.className = "notes-outline-item";
  parent.dataset.outlineMotionId = "p";
  const child = document.createElement("li");
  child.className = "notes-outline-item";
  child.dataset.outlineMotionId = "c";
  defineRect(parent, () => ({ left: 0, top: 0, width: 320, height: 28 }));
  defineRect(child, () => ({ left: 0, top: 28, width: 320, height: 28 }));
  Object.defineProperty(parent, "animate", {
    value: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }))
  });
  const childAnimate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }));
  Object.defineProperty(child, "animate", { value: childAnimate });
  root.append(parent, child);
  const before = new Map([
    ["p", { left: 0, top: 0, width: 320, height: 28 }]
  ]);
  const parentById =
    options.parentId === undefined ? new Map() : new Map([["c", options.parentId]]);
  const targets = collectOutlineMotionTargets(root, before, parentById);
  animateOutlineMotion(targets, { durationMs: 180, reducedMotion: false });
  return childAnimate;
}

describe("outline motion unfold from parent", () => {
  it("starts an entering row at its parent's position", () => {
    const childAnimate = buildUnfoldChild({
      parentTop: 0,
      childTop: 28,
      parentId: "p"
    });

    expect(childAnimate).toHaveBeenCalledWith(
      [
        { transform: "translate3d(0, -28px, 0)", opacity: 0 },
        { transform: "translate3d(0, 0, 0)", opacity: 1 }
      ],
      expect.anything()
    );
  });

  it("clamps the unfold offset for a deep entering row", () => {
    const childAnimate = buildUnfoldChild({
      parentTop: 0,
      childTop: 300,
      parentId: "p"
    });

    expect(childAnimate).toHaveBeenCalledWith(
      [
        { transform: "translate3d(0, -160px, 0)", opacity: 0 },
        { transform: "translate3d(0, 0, 0)", opacity: 1 }
      ],
      expect.anything()
    );
  });

  it("falls back to a short fade when the row has no parent on screen", () => {
    const childAnimate = buildUnfoldChild({
      parentTop: 0,
      childTop: 28,
      parentId: undefined
    });

    expect(childAnimate).toHaveBeenCalledWith(
      [
        { transform: "translate3d(0, -4px, 0)", opacity: 0 },
        { transform: "translate3d(0, 0, 0)", opacity: 1 }
      ],
      expect.anything()
    );
  });

  it("falls back to a short fade when the parent is itself entering", () => {
    const childAnimate = buildUnfoldChild({
      parentTop: 0,
      childTop: 28,
      parentEntering: true,
      parentId: "p"
    });

    expect(childAnimate).toHaveBeenCalledWith(
      [
        { transform: "translate3d(0, -4px, 0)", opacity: 0 },
        { transform: "translate3d(0, 0, 0)", opacity: 1 }
      ],
      expect.anything()
    );
  });

  it("does not animate a lone entering row (new bullet) so its caret lands instantly", () => {
    const childAnimate = buildSoloEnteringChild({ parentId: "p" });

    expect(childAnimate).not.toHaveBeenCalled();
  });
});

describe("identifyMovedRowIds", () => {
  it("returns no movers when the order is unchanged", () => {
    expect(identifyMovedRowIds(["a", "b", "c"], ["a", "b", "c"])).toEqual(
      new Set()
    );
  });

  it("returns no movers when every row is replaced", () => {
    expect(identifyMovedRowIds(["a", "b"], ["c", "d"])).toEqual(new Set());
  });

  it("identifies a single displaced row as the mover", () => {
    expect(
      identifyMovedRowIds(["a", "b", "c", "d"], ["a", "c", "d", "b"])
    ).toEqual(new Set(["b"]));
  });

  it("identifies a relocated block as the movers", () => {
    expect(
      identifyMovedRowIds(
        ["a", "b", "c", "d", "e", "f"],
        ["e", "f", "a", "b", "c", "d"]
      )
    ).toEqual(new Set(["e", "f"]));
  });
});

describe("outline motion lift", () => {
  it("adds the lift class to a moved row and clears it when the animation settles", async () => {
    const root = document.createElement("ol");
    const row = document.createElement("li");
    row.className = "notes-outline-item";
    row.dataset.outlineMotionId = "m";
    defineRect(row, () => ({ left: 0, top: 40, width: 320, height: 28 }));
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const animate = vi.fn(() => ({ cancel: vi.fn(), finished }));
    Object.defineProperty(row, "animate", { value: animate });
    root.append(row);
    const targets = collectOutlineMotionTargets(
      root,
      new Map([["m", { left: 0, top: 0, width: 320, height: 28 }]])
    );

    animateOutlineMotion(targets, {
      durationMs: 180,
      reducedMotion: false,
      liftIds: new Set(["m"])
    });
    expect(row.classList.contains("notes-outline-item--motion-lift")).toBe(true);

    settle();
    await finished;
    await Promise.resolve();

    expect(row.classList.contains("notes-outline-item--motion-lift")).toBe(
      false
    );
  });

  it("keeps the lift class when a row is re-moved before the prior lift settles", async () => {
    const root = document.createElement("ol");
    const row = document.createElement("li");
    row.className = "notes-outline-item";
    row.dataset.outlineMotionId = "m";
    defineRect(row, () => ({ left: 0, top: 40, width: 320, height: 28 }));
    const rejects: ((reason?: unknown) => void)[] = [];
    const animate = vi.fn(() => {
      let reject!: (reason?: unknown) => void;
      const finished = new Promise<void>((_resolve, rejectFn) => {
        reject = rejectFn;
      });
      rejects.push(reject);
      return { cancel: vi.fn(), finished };
    });
    Object.defineProperty(row, "animate", { value: animate });
    root.append(row);
    const collectMoved = () =>
      collectOutlineMotionTargets(
        root,
        new Map([["m", { left: 0, top: 0, width: 320, height: 28 }]])
      );

    // First move attaches the lift (animation A).
    animateOutlineMotion(collectMoved(), {
      durationMs: 180,
      reducedMotion: false,
      liftIds: new Set(["m"])
    });
    // Re-move before A settles reattaches the lift (animation B).
    animateOutlineMotion(collectMoved(), {
      durationMs: 180,
      reducedMotion: false,
      liftIds: new Set(["m"])
    });
    expect(row.classList.contains("notes-outline-item--motion-lift")).toBe(true);

    // A's finished rejects (as on cancel); its cleanup must not strip B's lift.
    rejects[0]!(new Error("cancelled"));
    await Promise.resolve();
    await Promise.resolve();

    expect(row.classList.contains("notes-outline-item--motion-lift")).toBe(true);
  });
});
