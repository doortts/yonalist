import {
  createMonacoOutlineRuntimeLoader,
  type MonacoOutlineRuntime,
  type MonacoPreloadScheduler
} from "./runtimeLoader";

describe("Monaco outline runtime loader", () => {
  it("does not schedule Monaco for the React outline", () => {
    const runtime = runtimeFixture();
    const importer = vi.fn().mockResolvedValue(runtime);
    const scheduler = schedulerFixture();
    const loader = createMonacoOutlineRuntimeLoader(importer);

    expect(loader.preload("?outline=react", scheduler.api)).toBe(false);
    expect(scheduler.pendingPaints()).toBe(0);
    expect(importer).not.toHaveBeenCalled();
  });

  it("loads Monaco after first paint and idle only when visible", async () => {
    const runtime = runtimeFixture();
    const importer = vi.fn().mockResolvedValue(runtime);
    const scheduler = schedulerFixture();
    const loader = createMonacoOutlineRuntimeLoader(importer);

    expect(loader.preload("?outline=monaco", scheduler.api)).toBe(true);
    expect(importer).not.toHaveBeenCalled();

    scheduler.runPaint();
    expect(importer).not.toHaveBeenCalled();
    scheduler.runIdle();
    await Promise.resolve();

    expect(importer).toHaveBeenCalledOnce();
    await expect(loader.load()).resolves.toBe(runtime);
  });

  it("shares one in-flight import between every caller", async () => {
    const runtime = runtimeFixture();
    let resolveRuntime!: (value: MonacoOutlineRuntime) => void;
    const pending = new Promise<MonacoOutlineRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const importer = vi.fn().mockReturnValue(pending);
    const loader = createMonacoOutlineRuntimeLoader(importer);

    const first = loader.load();
    const second = loader.load();
    expect(first).toBe(second);
    expect(importer).toHaveBeenCalledOnce();

    resolveRuntime(runtime);
    await expect(first).resolves.toBe(runtime);
  });

  it("allows an explicit retry after a failed preload", async () => {
    const runtime = runtimeFixture();
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce(runtime);
    const scheduler = schedulerFixture();
    const loader = createMonacoOutlineRuntimeLoader(importer);

    expect(loader.preload("?outline=monaco", scheduler.api)).toBe(true);
    scheduler.runPaint();
    scheduler.runIdle();
    await Promise.resolve();
    await Promise.resolve();

    await expect(loader.load()).resolves.toBe(runtime);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("cancels scheduled preload when the document becomes hidden", () => {
    const importer = vi.fn().mockResolvedValue(runtimeFixture());
    const scheduler = schedulerFixture();
    const loader = createMonacoOutlineRuntimeLoader(importer);

    expect(loader.preload("?outline=monaco", scheduler.api)).toBe(true);
    scheduler.setVisible(false);
    scheduler.runPaint();

    expect(scheduler.pendingIdles()).toBe(0);
    expect(importer).not.toHaveBeenCalled();
  });
});

function runtimeFixture(): MonacoOutlineRuntime {
  return {
    Surface: (() => null) as unknown as MonacoOutlineRuntime["Surface"],
    MonacoOutlineSessionRegistry: class {} as unknown as MonacoOutlineRuntime[
      "MonacoOutlineSessionRegistry"
    ]
  };
}

function schedulerFixture(): {
  readonly api: MonacoPreloadScheduler;
  pendingPaints(): number;
  pendingIdles(): number;
  runPaint(): void;
  runIdle(): void;
  setVisible(value: boolean): void;
} {
  const paints: Array<() => void> = [];
  const idles: Array<() => void> = [];
  let visible = true;
  return {
    api: {
      isVisible: () => visible,
      afterFirstPaint: (callback) => paints.push(callback),
      whenIdle: (callback) => idles.push(callback)
    },
    pendingPaints: () => paints.length,
    pendingIdles: () => idles.length,
    runPaint: () => paints.shift()?.(),
    runIdle: () => idles.shift()?.(),
    setVisible: (value) => {
      visible = value;
    }
  };
}
