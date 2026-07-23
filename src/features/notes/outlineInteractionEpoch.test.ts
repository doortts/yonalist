import { describe, expect, it } from "vitest";
import {
  createOutlineInteractionEpoch,
  type OutlineInteractionReason
} from "./outlineInteractionEpoch";

describe("OutlineInteractionEpoch", () => {
  it("advances for every interaction that can stale command-owned focus", () => {
    const epoch = createOutlineInteractionEpoch();
    const reasons: readonly OutlineInteractionReason[] = [
      "keydown",
      "beforeinput",
      "input",
      "compositionstart",
      "pointerdown",
      "selection-command",
      "focus-command",
      "pane-switch",
      "unmount"
    ];

    reasons.forEach((reason, index) => {
      expect(epoch.advance(reason)).toBe(index + 1);
      expect(epoch.current()).toBe(index + 1);
      expect(epoch.isCurrent(index + 1)).toBe(true);
      expect(epoch.isCurrent(index)).toBe(false);
    });
  });

  it("marks command-owned focus only for the dynamic extent of the operation", () => {
    const epoch = createOutlineInteractionEpoch();

    expect(epoch.commandFocusInProgress()).toBe(false);
    const result = epoch.runCommandFocus(() => {
      expect(epoch.commandFocusInProgress()).toBe(true);
      return "focused";
    });

    expect(result).toBe("focused");
    expect(epoch.commandFocusInProgress()).toBe(false);
  });

  it("keeps nested command focus active until the outer operation completes", () => {
    const epoch = createOutlineInteractionEpoch();

    epoch.runCommandFocus(() => {
      epoch.runCommandFocus(() => {
        expect(epoch.commandFocusInProgress()).toBe(true);
      });
      expect(epoch.commandFocusInProgress()).toBe(true);
    });

    expect(epoch.commandFocusInProgress()).toBe(false);
  });

  it("restores the focus-command marker when an operation throws", () => {
    const epoch = createOutlineInteractionEpoch();

    expect(() =>
      epoch.runCommandFocus(() => {
        throw new Error("focus failed");
      })
    ).toThrow("focus failed");
    expect(epoch.commandFocusInProgress()).toBe(false);
  });

  it("disposes exactly once and permanently invalidates every epoch", () => {
    const epoch = createOutlineInteractionEpoch();
    expect(epoch.advance("keydown")).toBe(1);

    epoch.dispose();
    expect(epoch.current()).toBe(2);
    expect(epoch.isCurrent(2)).toBe(false);

    epoch.dispose();
    expect(epoch.current()).toBe(2);
    expect(epoch.advance("input")).toBe(2);
    expect(epoch.isCurrent(2)).toBe(false);
    expect(epoch.isCurrent(1)).toBe(false);
  });
});
