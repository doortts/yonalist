export interface OutlineIdleBaselineScheduler {
  suspendForPendingInsertion(intentToken: number, generation: number): void;
  afterSettledFirstPaint(intentToken: number, generation: number): void;
  noteActivity(generation: number): void;
  completeFromSynchronousCapture(generation: number): void;
  dispose(): void;
  pendingCount(): 0 | 1;
}

export function resumeOutlineIdleBaselineAfterInsertionFailure(
  scheduler: Pick<OutlineIdleBaselineScheduler, "afterSettledFirstPaint">,
  intentToken: number,
  preparedGeneration: number,
  publishedGeneration: number
): void {
  scheduler.afterSettledFirstPaint(
    intentToken,
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
  const suspendedInsertions = new Map<number, number>();
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
      suspendedInsertions.size !== 0 ||
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
        suspendedInsertions.size !== 0 ||
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
          suspendedInsertions.size !== 0 ||
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
    suspendForPendingInsertion(intentToken, generation) {
      if (disposed) return;
      cancelPending();
      latestGeneration = Math.max(latestGeneration, generation);
      suspendedInsertions.set(
        intentToken,
        Math.max(
          suspendedInsertions.get(intentToken) ??
            Number.NEGATIVE_INFINITY,
          generation
        )
      );
    },

    afterSettledFirstPaint(intentToken, generation) {
      const suspendedGeneration = suspendedInsertions.get(intentToken);
      if (
        disposed ||
        suspendedGeneration === undefined ||
        generation < suspendedGeneration
      ) {
        return;
      }
      suspendedInsertions.delete(intentToken);
      latestGeneration = Math.max(latestGeneration, generation);
      settledPaintGeneration = Math.max(
        settledPaintGeneration,
        generation
      );
      if (suspendedInsertions.size === 0) {
        arm(latestGeneration);
      }
    },

    noteActivity(generation) {
      if (disposed) return;
      cancelPending();
      latestActivityVersion += 1;
      latestGeneration = Math.max(latestGeneration, generation);
      if (
        suspendedInsertions.size === 0 &&
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
      suspendedInsertions.clear();
    },

    pendingCount() {
      return pendingGeneration === null ? 0 : 1;
    }
  };
}
