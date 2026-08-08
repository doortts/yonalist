/**
 * The three browser APIs Monaco reaches for at editor construction and jsdom
 * does not implement. Stubbing them is what lets an integration test run the
 * real editor instead of a mock of it.
 */
export function installMonacoDomStubs(): void {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn()
  }));
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  HTMLCanvasElement.prototype.getContext = (() => ({
    measureText: (text: string) => ({ width: text.length * 8 }),
    fillText: () => undefined,
    clearRect: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray(4) })
  })) as unknown as HTMLCanvasElement["getContext"];
}
