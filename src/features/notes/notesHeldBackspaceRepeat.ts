export const NOTES_HELD_BACKSPACE_INITIAL_DELAY_MS = 400;
export const NOTES_HELD_BACKSPACE_REPEAT_INTERVAL_MS = 50;

export interface NotesHeldBackspaceRepeatController {
  handleKeyDown(token: number, repeat: boolean): "native" | "consume";
  stop(): void;
  dispose(): void;
}

export function previousGraphemeBoundary(
  value: string,
  endUtf16: number,
): number {
  const boundedEnd = Math.max(0, Math.min(value.length, endUtf16));
  if (boundedEnd === 0) return 0;
  const prefix = value.slice(0, boundedEnd);
  if (typeof Intl.Segmenter === "function") {
    let previous = 0;
    for (const segment of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(prefix)) {
      previous = segment.index;
    }
    return previous;
  }
  const lastCodePoint = Array.from(prefix).at(-1);
  return lastCodePoint === undefined ? 0 : boundedEnd - lastCodePoint.length;
}

export function createNotesHeldBackspaceRepeatController(options: {
  readonly repeat: () => boolean;
  readonly initialDelayMs?: number;
  readonly repeatIntervalMs?: number;
}): NotesHeldBackspaceRepeatController {
  const initialDelayMs =
    options.initialDelayMs ?? NOTES_HELD_BACKSPACE_INITIAL_DELAY_MS;
  const repeatIntervalMs =
    options.repeatIntervalMs ?? NOTES_HELD_BACKSPACE_REPEAT_INTERVAL_MS;
  let disposed = false;
  let activeToken: number | null = null;
  let fallbackActive = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const cancelPending = (): void => {
    generation += 1;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number): void => {
    cancelPending();
    if (disposed || activeToken === null) return;
    const scheduledGeneration = generation;
    const scheduledToken = activeToken;
    timer = setTimeout(() => {
      timer = null;
      if (
        disposed ||
        generation !== scheduledGeneration ||
        activeToken !== scheduledToken
      ) {
        return;
      }
      fallbackActive = true;
      if (options.repeat()) {
        schedule(repeatIntervalMs);
      }
    }, delayMs);
  };

  const stop = (): void => {
    cancelPending();
    activeToken = null;
    fallbackActive = false;
  };

  return {
    handleKeyDown(token, repeat) {
      if (disposed) return "native";
      if (!repeat || activeToken !== token) {
        activeToken = token;
        fallbackActive = false;
        schedule(initialDelayMs);
        return "native";
      }
      if (fallbackActive) {
        return "consume";
      }
      schedule(initialDelayMs);
      return "native";
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
    },
  };
}
