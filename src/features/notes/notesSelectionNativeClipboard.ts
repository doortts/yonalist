import type { NotesClipboardEvent } from "./notesClipboard";
import type {
  NotesPreparedClipboardCommitOutcome,
  NotesPreparedClipboardIntent
} from "./useNotesSelectionCommandRouter";

export interface NotesSelectionNativeClipboardRouter<Session> {
  readonly prepareClipboard: () => Promise<Session | null>;
  readonly commitPreparedClipboardEvent: (
    intent: NotesPreparedClipboardIntent,
    event: NotesClipboardEvent,
    session: Session
  ) => NotesPreparedClipboardCommitOutcome;
  readonly invalidatePreparedClipboard: () => void;
}

export interface NotesNativeClipboardEvent extends NotesClipboardEvent {
  readonly target?: unknown;
}

export interface NotesNativeClipboardEventOptions {
  /** Non-input/textarea targets stay native unless the pane opts in. */
  readonly allowNonTextTarget?: boolean;
  /** Claims eligible unprepared/repeat events for a live outline selection. */
  readonly claimUnprepared?: boolean;
  /** Lets an event boundary provide composition state without using trackers. */
  readonly isComposing?: boolean;
  /** Lets an event boundary provide repeat state without using trackers. */
  readonly repeatedPrimaryShortcut?: boolean;
}

export interface NotesNativeClipboardKeyEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
}

export type NotesNativeClipboardUnownedReason =
  | "disposed"
  | "composition"
  | "repeat"
  | "nativeTextSelection"
  | "unsupportedTarget"
  | "unprepared";

export type NotesNativeClipboardHandleOutcome =
  | NotesPreparedClipboardCommitOutcome
  | {
      readonly kind: "claimed";
      readonly reason: "unprepared" | "repeat";
      readonly intent: NotesPreparedClipboardIntent;
    }
  | {
      readonly kind: "unowned";
      readonly reason: NotesNativeClipboardUnownedReason;
    };

export interface NotesSelectionNativeClipboardControllerOptions {
  readonly onPreparationPending?: (
    intent: NotesPreparedClipboardIntent
  ) => void;
}

export interface NotesSelectionNativeClipboardController<Session> {
  /** Coalesces callers until the current lifecycle generation settles. */
  readonly prewarm: () => Promise<Session | null>;
  /** Lets outer lifecycle guards preserve the controller's IME exception. */
  readonly isCompositionActive: () => boolean;
  /** Invalidates the old lifecycle generation, then starts a fresh prewarm. */
  readonly refresh: () => Promise<Session | null>;
  /** Call for selection, scope, visibility, draft, or command lifecycle changes. */
  readonly invalidate: () => void;
  readonly dispose: () => void;
  readonly handleCompositionStart: () => void;
  readonly handleCompositionEnd: () => void;
  /** Tracking only: this method never claims or cancels the key event. */
  readonly handleKeyDown: (event: NotesNativeClipboardKeyEvent) => void;
  readonly handleKeyUp: (
    event: Pick<NotesNativeClipboardKeyEvent, "key" | "isComposing">
  ) => void;
  readonly handleCopy: (
    event: NotesNativeClipboardEvent,
    options?: NotesNativeClipboardEventOptions
  ) => NotesNativeClipboardHandleOutcome;
  readonly handleCut: (
    event: NotesNativeClipboardEvent,
    options?: NotesNativeClipboardEventOptions
  ) => NotesNativeClipboardHandleOutcome;
}

interface Preparation<Session> {
  readonly generation: number;
  readonly promise: Promise<Session | null>;
}

interface TextControlTarget {
  readonly tagName?: unknown;
  readonly selectionStart?: unknown;
  readonly selectionEnd?: unknown;
}

function textControlTarget(target: unknown): TextControlTarget | null {
  if (typeof target !== "object" || target === null) {
    return null;
  }
  const candidate = target as TextControlTarget;
  const tagName =
    typeof candidate.tagName === "string"
      ? candidate.tagName.toUpperCase()
      : null;
  return tagName === "INPUT" || tagName === "TEXTAREA" ? candidate : null;
}

function targetBlockReason(
  target: unknown,
  allowNonTextTarget: boolean
): "nativeTextSelection" | "unsupportedTarget" | null {
  const textControl = textControlTarget(target);
  if (textControl === null) {
    return allowNonTextTarget ? null : "unsupportedTarget";
  }

  const { selectionStart, selectionEnd } = textControl;
  if (
    typeof selectionStart !== "number" ||
    typeof selectionEnd !== "number"
  ) {
    return "unsupportedTarget";
  }
  return selectionStart === selectionEnd ? null : "nativeTextSelection";
}

function shortcutIntent(
  event: NotesNativeClipboardKeyEvent
): NotesPreparedClipboardIntent | null {
  if (!event.metaKey && !event.ctrlKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  return key === "c" ? "copy" : key === "x" ? "cut" : null;
}

/**
 * Owns only the synchronous native copy/cut boundary. Draft flushing,
 * authority validation, clipboard serialization, and Cut mutation remain in
 * the selection command router.
 */
export function createNotesSelectionNativeClipboardController<Session>(
  router: NotesSelectionNativeClipboardRouter<Session>,
  controllerOptions: NotesSelectionNativeClipboardControllerOptions = {}
): NotesSelectionNativeClipboardController<Session> {
  let generation = 0;
  let disposed = false;
  let activeSession: Session | null = null;
  let preparation: Preparation<Session> | null = null;
  let compositionActive = false;
  let processKeyActive = false;
  let repeatedShortcut: NotesPreparedClipboardIntent | null = null;

  const invalidateCurrent = (): void => {
    generation += 1;
    activeSession = null;
    preparation = null;
    router.invalidatePreparedClipboard();
  };

  const invalidate = (): void => {
    if (!disposed) {
      invalidateCurrent();
    }
  };

  const prewarm = (): Promise<Session | null> => {
    if (disposed) {
      return Promise.resolve(null);
    }
    if (activeSession !== null) {
      return Promise.resolve(activeSession);
    }
    if (preparation?.generation === generation) {
      return preparation.promise;
    }

    const preparationGeneration = generation;
    let requested: Promise<Session | null>;
    try {
      requested = router.prepareClipboard();
    } catch {
      requested = Promise.resolve(null);
    }
    let entry!: Preparation<Session>;
    const promise = requested
      .then(
        (session) => {
          if (disposed || preparationGeneration !== generation) {
            return null;
          }
          activeSession = session;
          return session;
        },
        () => null
      )
      .finally(() => {
        if (preparation === entry) {
          preparation = null;
        }
      });
    entry = {
      generation: preparationGeneration,
      promise
    };
    preparation = entry;
    return promise;
  };

  const refresh = (): Promise<Session | null> => {
    invalidate();
    return prewarm();
  };

  const handleClipboard = (
    intent: NotesPreparedClipboardIntent,
    event: NotesNativeClipboardEvent,
    options: NotesNativeClipboardEventOptions = {}
  ): NotesNativeClipboardHandleOutcome => {
    if (disposed) {
      return { kind: "unowned", reason: "disposed" };
    }
    if (
      options.isComposing === true ||
      compositionActive ||
      processKeyActive
    ) {
      return { kind: "unowned", reason: "composition" };
    }
    const repeated =
      options.repeatedPrimaryShortcut === true ||
      repeatedShortcut === intent;
    if (repeated && options.claimUnprepared === true) {
      const blockedTarget = targetBlockReason(
        event.target,
        options.allowNonTextTarget === true
      );
      if (blockedTarget !== null) {
        return { kind: "unowned", reason: blockedTarget };
      }
      event.preventDefault();
      return { kind: "claimed", reason: "repeat", intent };
    }
    if (repeated) {
      return { kind: "unowned", reason: "repeat" };
    }
    const blockedTarget = targetBlockReason(
      event.target,
      options.allowNonTextTarget === true
    );
    if (blockedTarget !== null) {
      return { kind: "unowned", reason: blockedTarget };
    }
    const session = activeSession;
    if (session === null) {
      if (options.claimUnprepared === true) {
        event.preventDefault();
        void prewarm();
        controllerOptions.onPreparationPending?.(intent);
        return { kind: "claimed", reason: "unprepared", intent };
      }
      return { kind: "unowned", reason: "unprepared" };
    }

    const outcome = router.commitPreparedClipboardEvent(intent, event, session);
    if (outcome.kind === "committed" && intent === "cut") {
      generation += 1;
      activeSession = null;
      preparation = null;
      return outcome;
    }
    if (outcome.kind === "rejected" && outcome.reason === "stale") {
      if (options.claimUnprepared === true) {
        event.preventDefault();
        invalidateCurrent();
        void prewarm();
        controllerOptions.onPreparationPending?.(intent);
      } else {
        generation += 1;
        activeSession = null;
        preparation = null;
      }
      return outcome;
    }
    if (options.claimUnprepared === true && outcome.kind !== "committed") {
      // Once the pane opts in for a live outline selection, every eligible
      // clipboard event remains pane-owned even if the prepared session races
      // with another command or the synchronous clipboard write fails. Native
      // Cut must never edit the focused textarea as a fallback.
      event.preventDefault();
      if (outcome.kind === "rejected" && outcome.reason === "busy") {
        controllerOptions.onPreparationPending?.(intent);
      }
    }
    return outcome;
  };

  return {
    prewarm,
    isCompositionActive: () => compositionActive || processKeyActive,
    refresh,
    invalidate,
    dispose() {
      if (disposed) {
        return;
      }
      invalidateCurrent();
      disposed = true;
      compositionActive = false;
      processKeyActive = false;
      repeatedShortcut = null;
    },
    handleCompositionStart() {
      compositionActive = true;
    },
    handleCompositionEnd() {
      compositionActive = false;
      processKeyActive = false;
    },
    handleKeyDown(event) {
      if (event.key === "Process" || event.isComposing === true) {
        processKeyActive = true;
      }
      const intent = shortcutIntent(event);
      if (intent !== null) {
        repeatedShortcut = event.repeat === true ? intent : null;
      }
    },
    handleKeyUp(event) {
      if (event.key === "Process") {
        processKeyActive = false;
      }
      const key = event.key.toLowerCase();
      if (
        (key === "c" && repeatedShortcut === "copy") ||
        (key === "x" && repeatedShortcut === "cut")
      ) {
        repeatedShortcut = null;
      }
    },
    handleCopy(event, options) {
      return handleClipboard("copy", event, options);
    },
    handleCut(event, options) {
      return handleClipboard("cut", event, options);
    }
  };
}
