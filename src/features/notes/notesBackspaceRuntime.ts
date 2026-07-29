import type { NoteId } from "../../domain/notes";
import type { NotesHistoryPrimarySelection } from "./notesHistory";
import type { NotesPaneId } from "./notesPaneSession";
import type {
  NotesBackspaceGestureQueueWork,
  NotesWorkspaceCommandOutcome,
  NotesWorkspaceCoordinatorSession
} from "./notesWorkspaceCoordinator";
import type { NotesDraftEngine } from "./notesDraftEngine";
import type { NotesBackspaceDraftLease } from "./notesWorkspaceTypes";

export interface NotesBackspaceGestureRuntimeBinding {
  readonly key: object;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly beginDraftLease: (
    token: number,
    nodeId: NoteId
  ) => NotesBackspaceDraftLease | null;
}

interface NotesBackspaceGestureOrigin {
  readonly bindingKey: object;
  readonly ownerPaneId: NotesPaneId;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly coordinatorToken: number;
  finishing: Promise<NotesWorkspaceCommandOutcome> | null;
}

export function createNotesBackspaceGestureRuntimeLifecycle() {
  let nextHandle = 0;
  const origins = new Map<number, NotesBackspaceGestureOrigin>();
  const activeHandleByBinding = new WeakMap<object, number>();

  const origin = (handle: number): NotesBackspaceGestureOrigin | null =>
    origins.get(handle) ?? null;
  const forget = (handle: number, current: NotesBackspaceGestureOrigin): void => {
    if (origins.get(handle) !== current) return;
    origins.delete(handle);
    if (activeHandleByBinding.get(current.bindingKey) === handle) {
      activeHandleByBinding.delete(current.bindingKey);
    }
  };

  return {
    begin(
      binding: NotesBackspaceGestureRuntimeBinding,
      input: {
        readonly ownerPaneId: NotesPaneId;
        readonly nodeId: NoteId;
        readonly selection: NotesHistoryPrimarySelection;
      },
      work: NotesBackspaceGestureQueueWork
    ): number | null {
      const activeHandle = activeHandleByBinding.get(binding.key);
      if (activeHandle !== undefined && origins.has(activeHandle)) {
        return origin(activeHandle)?.ownerPaneId === input.ownerPaneId
          ? activeHandle
          : null;
      }
      const coordinatorToken = binding.session.beginBackspaceGesture(
        input,
        (token) => binding.beginDraftLease(token, input.nodeId),
        work
      );
      if (coordinatorToken === null) return null;
      const handle = ++nextHandle;
      origins.set(handle, {
        bindingKey: binding.key,
        ownerPaneId: input.ownerPaneId,
        session: binding.session,
        coordinatorToken,
        finishing: null
      });
      activeHandleByBinding.set(binding.key, handle);
      return handle;
    },
    touch(handle: number, nodeId: NoteId, renderedTitle: string): void {
      const current = origin(handle);
      current?.session.touchBackspaceGesture(current.coordinatorToken, nodeId, renderedTitle);
    },
    remove(
      handle: number,
      nodeId: NoteId,
      focusNodeId: NoteId | null
    ): boolean {
      const current = origin(handle);
      return (
        current?.session.removeEmptyNodeInBackspaceGesture(
          current.coordinatorToken,
          nodeId,
          focusNodeId
        ) ?? false
      );
    },
    finish(
      bindingKey: object,
      reason: "keyup" | "blur" | "hidden" | "drain"
    ): Promise<NotesWorkspaceCommandOutcome> {
      const handle = activeHandleByBinding.get(bindingKey);
      if (handle === undefined) return Promise.resolve("skipped");
      const current = origin(handle);
      if (!current) return Promise.resolve("skipped");
      if (current.finishing) return current.finishing;
      const completion = current.session
        .finishBackspaceGesture(reason)
        .finally(() => forget(handle, current));
      current.finishing = completion;
      return completion;
    },
    cancel(bindingKey: object): void {
      const handle = activeHandleByBinding.get(bindingKey);
      if (handle === undefined) return;
      const current = origin(handle);
      if (!current || current.finishing) return;
      current.session.cancelBackspaceGesture();
      forget(handle, current);
    }
  };
}

const coordinatorSessionByDraftEngine = new WeakMap<
  NotesDraftEngine,
  NotesWorkspaceCoordinatorSession
>();

export function registerCoordinatorSessionForDraftEngine(
  engine: NotesDraftEngine,
  session: NotesWorkspaceCoordinatorSession
): void {
  coordinatorSessionByDraftEngine.set(engine, session);
}

export async function shutdownAfterBackspaceDrain(
  engine: NotesDraftEngine
): Promise<void> {
  const session = coordinatorSessionByDraftEngine.get(engine);
  if (
    engine.record.backspaceDraftLease?.active === true &&
    session !== undefined
  ) {
    try {
      await session.finishBackspaceGesture("drain");
    } catch {
      // Shutdown still owns disposal after a terminal drain failure.
    }
  }
  try {
    await engine.beginShutdown();
  } finally {
    engine.dispose();
  }
}

export function observeBackspaceGestureTerminalOutcome(
  completion: Promise<NotesWorkspaceCommandOutcome>,
  observer: (outcome: NotesWorkspaceCommandOutcome) => void
): void {
  void completion.then(observer, () => observer("failed"));
}
