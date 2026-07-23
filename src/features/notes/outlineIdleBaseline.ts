export interface OutlineIdleBaselineScheduler {
  suspendForPendingInsertion(generation: number): void;
  afterSettledFirstPaint(generation: number): void;
  noteActivity(generation: number): void;
  completeFromSynchronousCapture(generation: number): void;
  dispose(): void;
  pendingCount(): 0 | 1;
}

export function resumeOutlineIdleBaselineAfterInsertionFailure(
  scheduler: Pick<OutlineIdleBaselineScheduler, "afterSettledFirstPaint">,
  preparedGeneration: number,
  publishedGeneration: number
): void {
  scheduler.afterSettledFirstPaint(
    Math.max(preparedGeneration, publishedGeneration)
  );
}

export function createOutlineIdleBaselineScheduler(options: {
  readonly quietMs: 150;
  readonly idleTimeoutMs: 500;
  readonly requestIdle: (
    callback: IdleRequestCallback,
    timeoutMs: number
  ) => unknown;
  readonly cancelIdle: (handle: unknown) => void;
  readonly captureLatest: (generation: number) => void;
}): OutlineIdleBaselineScheduler {
  let disposed = false;
  let latestGeneration = Number.NEGATIVE_INFINITY;
  let settledPaintGeneration = Number.NEGATIVE_INFINITY;
  let completedGeneration = Number.NEGATIVE_INFINITY;
  let latestActivityVersion = 0;
  let completedActivityVersion = Number.NEGATIVE_INFINITY;
  let suspendedGeneration: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let idleHandle: unknown | null = null;
  let pendingGeneration: number | null = null;
  let callbackToken = 0;

  const isCompleted = (
    generation: number,
    activityVersion: number
  ): boolean =>
    completedGeneration > generation ||
    (completedGeneration === generation &&
      completedActivityVersion >= activityVersion);

  const recordCompletion = (
    generation: number,
    activityVersion: number
  ): void => {
    if (generation > completedGeneration) {
      completedGeneration = generation;
      completedActivityVersion = activityVersion;
      return;
    }
    if (generation === completedGeneration) {
      completedActivityVersion = Math.max(
        completedActivityVersion,
        activityVersion
      );
    }
  };

  const cancelPending = (): void => {
    callbackToken += 1;
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (idleHandle !== null) {
      options.cancelIdle(idleHandle);
      idleHandle = null;
    }
    pendingGeneration = null;
  };

  const arm = (
    generation: number,
    activityVersion = latestActivityVersion
  ): void => {
    cancelPending();
    if (
      disposed ||
      suspendedGeneration !== null ||
      generation !== latestGeneration ||
      settledPaintGeneration === Number.NEGATIVE_INFINITY ||
      isCompleted(generation, activityVersion)
    ) {
      return;
    }
    const token = callbackToken;
    pendingGeneration = generation;
    quietTimer = setTimeout(() => {
      quietTimer = null;
      if (
        disposed ||
        token !== callbackToken ||
        pendingGeneration !== generation ||
        suspendedGeneration !== null ||
        latestGeneration !== generation ||
        latestActivityVersion !== activityVersion ||
        isCompleted(generation, activityVersion)
      ) {
        return;
      }
      const handle = options.requestIdle(() => {
        if (
          disposed ||
          token !== callbackToken ||
          pendingGeneration !== generation ||
          suspendedGeneration !== null ||
          latestGeneration !== generation ||
          latestActivityVersion !== activityVersion ||
          isCompleted(generation, activityVersion)
        ) {
          return;
        }
        idleHandle = null;
        pendingGeneration = null;
        recordCompletion(generation, activityVersion);
        options.captureLatest(generation);
      }, options.idleTimeoutMs);
      if (
        token === callbackToken &&
        pendingGeneration === generation
      ) {
        idleHandle = handle;
      }
    }, options.quietMs);
  };

  return {
    suspendForPendingInsertion(generation) {
      if (disposed) return;
      cancelPending();
      latestGeneration = Math.max(latestGeneration, generation);
      suspendedGeneration = Math.max(
        suspendedGeneration ?? Number.NEGATIVE_INFINITY,
        generation
      );
    },

    afterSettledFirstPaint(generation) {
      if (disposed || generation < latestGeneration) return;
      latestGeneration = generation;
      settledPaintGeneration = Math.max(
        settledPaintGeneration,
        generation
      );
      if (suspendedGeneration !== null) {
        if (generation < suspendedGeneration) return;
        suspendedGeneration = null;
      }
      arm(generation);
    },

    noteActivity(generation) {
      if (disposed) return;
      cancelPending();
      latestActivityVersion += 1;
      latestGeneration = Math.max(latestGeneration, generation);
      if (
        suspendedGeneration === null &&
        settledPaintGeneration !== Number.NEGATIVE_INFINITY
      ) {
        arm(latestGeneration);
      }
    },

    completeFromSynchronousCapture(generation) {
      if (disposed) return;
      recordCompletion(generation, latestActivityVersion);
      latestGeneration = Math.max(latestGeneration, generation);
      settledPaintGeneration = Math.max(
        settledPaintGeneration,
        generation
      );
      if (
        pendingGeneration !== null &&
        pendingGeneration <= generation
      ) {
        cancelPending();
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPending();
    },

    pendingCount() {
      return pendingGeneration === null ? 0 : 1;
    }
  };
}
