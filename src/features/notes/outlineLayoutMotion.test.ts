import { describe, expect, it, vi } from "vitest";
import {
  animateOutlineMotion,
  calculateOutlineFlipDelta,
  captureOutlineMotionRects,
  collectOutlineMotionTargets
} from "./outlineLayoutMotion";

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

  it("animates existing rows from their inverse position and entering rows from a short fade", () => {
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
        duration: 180,
        easing: "cubic-bezier(0.2, 0, 0, 1)"
      }
    );
    expect(enteringAnimate).toHaveBeenCalledWith(
      [
        { transform: "translate3d(0, -4px, 0)", opacity: 0 },
        { transform: "translate3d(0, 0, 0)", opacity: 1 }
      ],
      {
        duration: 180,
        easing: "cubic-bezier(0.2, 0, 0, 1)"
      }
    );
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
