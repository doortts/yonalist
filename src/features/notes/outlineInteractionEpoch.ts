export type OutlineInteractionReason =
  | "keydown"
  | "beforeinput"
  | "input"
  | "compositionstart"
  | "pointerdown"
  | "selection-command"
  | "focus-command"
  | "pane-switch"
  | "unmount";

export interface OutlineInteractionEpoch {
  current(): number;
  advance(reason: OutlineInteractionReason): number;
  isCurrent(epoch: number): boolean;
  runCommandFocus<T>(operation: () => T): T;
  commandFocusInProgress(): boolean;
  dispose(): void;
}

export function createOutlineInteractionEpoch(): OutlineInteractionEpoch {
  let currentEpoch = 0;
  let commandFocusDepth = 0;
  let disposed = false;

  return {
    current: () => currentEpoch,
    advance(_reason) {
      if (!disposed) currentEpoch += 1;
      return currentEpoch;
    },
    isCurrent: (epoch) => !disposed && epoch === currentEpoch,
    runCommandFocus(operation) {
      commandFocusDepth += 1;
      try {
        return operation();
      } finally {
        commandFocusDepth -= 1;
      }
    },
    commandFocusInProgress: () => commandFocusDepth > 0,
    dispose() {
      if (disposed) return;
      currentEpoch += 1;
      disposed = true;
    }
  };
}
