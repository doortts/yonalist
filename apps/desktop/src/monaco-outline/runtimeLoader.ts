import { outlineSurfaceFromSearch } from "../outlineSurface";

export interface MonacoOutlineRuntime {
  readonly Surface: typeof import("../MonacoOutlineSurface").default;
  readonly MonacoOutlineSessionRegistry:
    typeof import("./sessionRegistry").MonacoOutlineSessionRegistry;
}

export interface MonacoPreloadScheduler {
  isVisible(): boolean;
  afterFirstPaint(callback: () => void): void;
  whenIdle(callback: () => void): void;
}

export interface MonacoOutlineRuntimeLoader {
  load(): Promise<MonacoOutlineRuntime>;
  preload(search: string, scheduler?: MonacoPreloadScheduler): boolean;
}

export function createMonacoOutlineRuntimeLoader(
  importRuntime: () => Promise<MonacoOutlineRuntime>
): MonacoOutlineRuntimeLoader {
  let runtimePromise: Promise<MonacoOutlineRuntime> | null = null;
  let preloadScheduled = false;

  const load = (): Promise<MonacoOutlineRuntime> => {
    preloadScheduled = false;
    runtimePromise ??= importRuntime().catch((cause) => {
      runtimePromise = null;
      throw cause;
    });
    return runtimePromise;
  };

  return {
    load,
    preload: (
      search: string,
      scheduler: MonacoPreloadScheduler = browserPreloadScheduler
    ): boolean => {
      if (
        outlineSurfaceFromSearch(search) !== "monaco" ||
        !scheduler.isVisible() ||
        preloadScheduled ||
        runtimePromise
      ) {
        return false;
      }
      preloadScheduled = true;
      scheduler.afterFirstPaint(() => {
        if (!scheduler.isVisible()) {
          preloadScheduled = false;
          return;
        }
        scheduler.whenIdle(() => {
          if (!scheduler.isVisible()) {
            preloadScheduled = false;
            return;
          }
          void load().catch(() => undefined);
        });
      });
      return true;
    }
  };
}

const browserPreloadScheduler: MonacoPreloadScheduler = {
  isVisible: () => document.visibilityState === "visible",
  afterFirstPaint: (callback) => {
    requestAnimationFrame(() => callback());
  },
  whenIdle: (callback) => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => callback(), { timeout: 1_000 });
    } else {
      setTimeout(callback, 0);
    }
  }
};

const runtimeLoader = createMonacoOutlineRuntimeLoader(
  () => import("./runtime")
);

export const loadMonacoOutlineRuntime = runtimeLoader.load;
export const preloadMonacoOutlineRuntime = runtimeLoader.preload;
