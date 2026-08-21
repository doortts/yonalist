import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

interface FakeViewport {
  height: number;
  offsetTop: number;
  listeners: Map<string, () => void>;
}

function fakeViewport(height: number): FakeViewport {
  const listeners = new Map<string, () => void>();
  const viewport = {
    height,
    offsetTop: 0,
    listeners,
    addEventListener: (kind: string, listener: () => void) => listeners.set(kind, listener),
    removeEventListener: (kind: string) => listeners.delete(kind)
  };
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  return viewport as unknown as FakeViewport;
}

function resizeTo(viewport: FakeViewport, height: number) {
  viewport.height = height;
  act(() => {
    viewport.listeners.get("resize")?.();
    viewport.listeners.get("scroll")?.();
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
});

describe("useKeyboardInset", () => {
  it("covers nothing while no keyboard is up", () => {
    fakeViewport(window.innerHeight);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toBe(0);
  });

  it("reports what the keyboard took, so the rows can move above it", () => {
    const viewport = fakeViewport(window.innerHeight);
    const { result } = renderHook(() => useKeyboardInset());

    resizeTo(viewport, window.innerHeight - 318);

    expect(result.current).toBe(318);
  });

  it("gives the space back when the keyboard goes", () => {
    const viewport = fakeViewport(window.innerHeight);
    const { result } = renderHook(() => useKeyboardInset());
    resizeTo(viewport, window.innerHeight - 318);

    resizeTo(viewport, window.innerHeight);

    expect(result.current).toBe(0);
  });

  it("ignores the few pixels a toolbar or rounding leaves behind", () => {
    const viewport = fakeViewport(window.innerHeight);
    const { result } = renderHook(() => useKeyboardInset());

    resizeTo(viewport, window.innerHeight - 12);

    expect(result.current).toBe(0);
  });

  it("answers zero where the browser has no visual viewport to ask", () => {
    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toBe(0);
  });
});
