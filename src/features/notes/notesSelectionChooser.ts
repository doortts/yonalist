import type { NoteId } from "../../domain/notes";
import { useLayoutEffect, useRef } from "react";

/**
 * Router-owned identity captured when an asynchronous selection chooser opens.
 * Choosers preserve this object verbatim; the router remains responsible for
 * validating ownership immediately before a command is submitted.
 */
export interface NotesFrozenSelectionSnapshot<Ownership = unknown> {
  readonly nodeIds: readonly NoteId[];
  readonly ownership: Ownership;
}

/**
 * Retains the value from the first committed render of an open session.
 * Render only derives the opening value; refs are updated in a layout effect so
 * an interrupted concurrent render cannot leak a different session payload.
 */
export function useFrozenOpenValue<Value>(
  open: boolean,
  value: Value
): Value {
  const frozenRef = useRef(value);
  const wasOpenRef = useRef(false);
  const isOpening = open && !wasOpenRef.current;
  const frozenValue = isOpening ? value : frozenRef.current;

  useLayoutEffect(() => {
    if (isOpening) {
      frozenRef.current = value;
    }
    wasOpenRef.current = open;
  }, [isOpening, open, value]);

  return frozenValue;
}

/**
 * Freezes the first ready value in an open session. This lets a chooser open in
 * a loading state without allowing later workspace refreshes to retarget it.
 */
export function useFrozenReadyOpenValue<Value>(
  open: boolean,
  ready: boolean,
  value: Value,
  fallback: Value
): Value {
  const frozenRef = useRef(value);
  const wasOpenRef = useRef(false);
  const lockedRef = useRef(false);
  const isOpening = open && !wasOpenRef.current;
  const shouldCapture =
    open && ready && (isOpening || !lockedRef.current);
  const frozenValue = shouldCapture
    ? value
    : open && lockedRef.current
      ? frozenRef.current
      : fallback;

  useLayoutEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      lockedRef.current = false;
      return;
    }
    if (ready && (isOpening || !lockedRef.current)) {
      frozenRef.current = value;
      lockedRef.current = true;
    }
    wasOpenRef.current = true;
  }, [isOpening, open, ready, value]);

  return frozenValue;
}
