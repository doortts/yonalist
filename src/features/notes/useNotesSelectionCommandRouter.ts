import { useCallback, useRef, useState } from "react";
import type {
  NoteId,
  NoteSearchTag,
  NoteTagFilter
} from "../../domain/notes";
import type { NotesWorkspaceCommandOutcome } from "./notesWorkspaceCoordinator";
import type {
  NormalizedNotesWorkspace,
  NotesSelection
} from "./notesWorkspaceReducer";
import type {
  NotesSelectionActionSnapshot,
  NotesSelectionEligibility,
  NotesSelectionMoveTarget,
  NotesSelectionReorderEligibility
} from "./notesSelectionActions";
import type {
  NotesBatchCommandSettlement,
  NotesBatchOp
} from "./notesCommands";
import {
  writeNotesClipboardEvent,
  type NotesClipboardEvent,
  type NotesClipboardWriteOutcome
} from "./notesClipboard";
import {
  serializeNotesClipboardOutline,
  type NotesClipboardOutlineNode
} from "./notesClipboardOutline";
import {
  MAX_PASTE_IMPORT_DEPTH,
  MAX_PASTE_IMPORT_NODES
} from "./notesPasteImport";

export interface NotesSelectionRouterAuthority {
  readonly selectedNodeIds: readonly NoteId[];
  readonly selectionRevision: number;
  readonly workspace: NormalizedNotesWorkspace;
}

/** Ownership payload stored verbatim in Task 7's generic chooser snapshot. */
export interface NotesSelectionCommandOwnership<
  Authority extends NotesSelectionRouterAuthority
> {
  readonly actionSnapshot: NotesSelectionActionSnapshot;
  readonly authority: Authority;
}

/** Structurally matches `NotesFrozenSelectionSnapshot<Ownership>` from the
 * chooser layer without making this non-rendering router depend on Task 7. */
export interface NotesFrozenSelectionCommandContext<
  Authority extends NotesSelectionRouterAuthority
> {
  readonly nodeIds: readonly NoteId[];
  readonly ownership: NotesSelectionCommandOwnership<Authority>;
}

export interface NotesSelectionRouterFeedback {
  readonly status: string | null;
  readonly error: string | null;
}

const preparedClipboardSessionBrand: unique symbol = Symbol(
  "notes-prepared-clipboard-session"
);

/** Opaque handle whose payload remains private to its creating router. */
export type NotesPreparedClipboardSession<
  Authority extends NotesSelectionRouterAuthority = NotesSelectionRouterAuthority
> = Readonly<{
  [preparedClipboardSessionBrand]: Authority;
}>;

export type NotesPreparedClipboardIntent = "copy" | "cut";

export type NotesPreparedClipboardCommitOutcome =
  | {
      readonly kind: "committed";
      readonly intent: NotesPreparedClipboardIntent;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "busy" | "stale" | "cutUnavailable";
    }
  | { readonly kind: "failed"; readonly message: string };

export type NotesSelectionCommandIntent =
  | { readonly type: "complete" }
  | { readonly type: "addTag"; readonly tag: NoteSearchTag }
  | { readonly type: "removeTag"; readonly tag: NoteTagFilter }
  | { readonly type: "indent" }
  | { readonly type: "outdent" }
  | { readonly type: "moveUp" }
  | { readonly type: "moveDown" }
  | {
      readonly type: "reorder";
      readonly target: Readonly<NotesSelectionMoveTarget>;
      readonly expandNodeId?: NoteId;
    }
  | {
      readonly type: "moveTo";
      readonly target: Readonly<NotesSelectionMoveTarget>;
    }
  | { readonly type: "duplicate" }
  | { readonly type: "delete" }
  | { readonly type: "copy" }
  | { readonly type: "cut" };

export interface NotesSelectionCommandExecution {
  readonly outcome: NotesWorkspaceCommandOutcome | "busy";
  readonly mutationCommitted: boolean;
}

export interface NotesSelectionCommandRouterDependencies<
  Authority extends NotesSelectionRouterAuthority
> {
  readonly getSnapshot: () => NotesSelectionActionSnapshot | null;
  readonly getSelectionRevision: () => number;
  /** Monotonic editor/navigation epoch, independent from selection currency. */
  readonly getNavigationVersion: () => number;
  /** Derives pane-visible IDs synchronously from the exact projected result,
   * using the pane's current zoom/expansion rules without waiting for render. */
  readonly getVisibleNodeIds: (
    projectedWorkspace: NormalizedNotesWorkspace
  ) => readonly NoteId[];
  readonly flushDrafts: () => Promise<boolean>;
  /** `nodeIds` is the exact operation target subset, not the whole visible
   * range. Indent/outdent may therefore prepare fewer IDs than selected. */
  readonly prepareAuthority: (
    nodeIds: readonly NoteId[]
  ) => Promise<Authority>;
  readonly isAuthorityCurrent: (authority: Authority) => boolean;
  readonly applyBatch: (
    authority: Authority,
    op: NotesBatchOp,
    options?: {
      focusNodeId?: NoteId | null;
      expandNodeId?: NoteId;
      expectedNavigationVersion?: number;
    }
  ) => Promise<NotesBatchCommandSettlement>;
  readonly replaceSelection: (
    selection: NotesSelection | null,
    expectedRevision: number
  ) => boolean;
  /** Applies survivor navigation synchronously after the range was cleared at
   * the same frozen revision. It must not enqueue another structural command. */
  readonly focusNode: (nodeId: NoteId) => void;
  readonly writeClipboard: (
    text: string
  ) => Promise<NotesClipboardWriteOutcome>;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onFeedback?: (feedback: NotesSelectionRouterFeedback) => void;
}

export interface NotesSelectionCommandRouter<
  Authority extends NotesSelectionRouterAuthority = NotesSelectionRouterAuthority
> {
  readonly execute: (
    intent: NotesSelectionCommandIntent,
    frozenContext?: NotesFrozenSelectionCommandContext<Authority>
  ) => Promise<NotesSelectionCommandExecution>;
  readonly prepareClipboard: () => Promise<
    NotesPreparedClipboardSession<Authority> | null
  >;
  readonly commitPreparedClipboardEvent: (
    intent: NotesPreparedClipboardIntent,
    event: NotesClipboardEvent,
    session: NotesPreparedClipboardSession<Authority>
  ) => NotesPreparedClipboardCommitOutcome;
  readonly invalidatePreparedClipboard: () => void;
  readonly isBusy: () => boolean;
}

interface ResolvedCommand {
  readonly kind: "batch" | "copy" | "cut";
  readonly nodeIds: readonly NoteId[];
  readonly op?: NotesBatchOp;
  readonly focusNodeId?: NoteId | null;
  readonly expandNodeId?: NoteId;
  readonly successStatus: string;
}

type CommandResolution =
  | { readonly command: ResolvedCommand }
  | { readonly error: string };

function exactIds(left: readonly NoteId[], right: readonly NoteId[]): boolean {
  return (
    left.length === right.length &&
    left.every((nodeId, index) => nodeId === right[index])
  );
}

function eligibleCommand(
  eligibility: NotesSelectionEligibility,
  build: (nodeIds: readonly NoteId[]) => ResolvedCommand
): CommandResolution {
  return eligibility.eligible
    ? { command: build(eligibility.nodeIds) }
    : { error: eligibility.reason };
}

function reorderCommand(
  eligibility: NotesSelectionReorderEligibility
): CommandResolution {
  return eligibility.eligible
    ? {
        command: {
          kind: "batch",
          nodeIds: eligibility.nodeIds,
          op: { type: "move", ...eligibility.target },
          successStatus: "Moved selection."
        }
      }
    : { error: eligibility.reason };
}

function resolveCommand(
  intent: NotesSelectionCommandIntent,
  snapshot: NotesSelectionActionSnapshot
): CommandResolution {
  switch (intent.type) {
    case "complete":
      return {
        command: {
          kind: "batch",
          nodeIds: snapshot.selectedNodeIds,
          op: { type: "complete" },
          successStatus:
            snapshot.completion === "all"
              ? "Uncompleted selection."
              : "Completed selection."
        }
      };
    case "addTag":
      return {
        command: {
          kind: "batch",
          nodeIds: snapshot.selectedNodeIds,
          op: { type: "addTag", tag: intent.tag },
          successStatus: "Tag added."
        }
      };
    case "removeTag":
      return {
        command: {
          kind: "batch",
          nodeIds: snapshot.selectedNodeIds,
          op: { type: "removeTag", tag: intent.tag },
          successStatus: "Tag removed."
        }
      };
    case "indent":
      return eligibleCommand(snapshot.eligibility.indent, (nodeIds) => ({
        kind: "batch",
        nodeIds,
        op: { type: "indent" },
        successStatus: "Indented selection."
      }));
    case "outdent":
      return eligibleCommand(snapshot.eligibility.outdent, (nodeIds) => ({
        kind: "batch",
        nodeIds,
        op: { type: "outdent" },
        successStatus: "Outdented selection."
      }));
    case "moveUp":
      return reorderCommand(snapshot.eligibility.moveUp);
    case "moveDown":
      return reorderCommand(snapshot.eligibility.moveDown);
    case "reorder":
      return snapshot.structuralRootIds.length > 0 &&
        (intent.expandNodeId === undefined ||
          intent.expandNodeId === intent.target.parentId)
        ? {
            command: {
              kind: "batch",
              nodeIds: snapshot.structuralRootIds,
              op: { type: "move", ...intent.target },
              expandNodeId: intent.expandNodeId,
              successStatus: "Moved selection."
            }
          }
        : { error: "The selected range cannot be moved." };
    case "moveTo":
      return eligibleCommand(snapshot.eligibility.moveTo, (nodeIds) => ({
        kind: "batch",
        nodeIds,
        op: { type: "move", ...intent.target },
        successStatus: "Moved selection."
      }));
    case "duplicate":
      return eligibleCommand(snapshot.eligibility.duplicate, (nodeIds) => ({
        kind: "batch",
        nodeIds,
        op: { type: "duplicate" },
        successStatus: "Duplicated selection."
      }));
    case "delete":
      return eligibleCommand(snapshot.eligibility.delete, (nodeIds) => ({
        kind: "batch",
        nodeIds,
        op: { type: "delete" },
        focusNodeId: snapshot.deleteFocusNodeId,
        successStatus: "Deleted selection."
      }));
    case "copy":
      return eligibleCommand(snapshot.eligibility.copy, (nodeIds) => ({
        kind: "copy",
        nodeIds,
        successStatus: "Copied."
      }));
    case "cut":
      return eligibleCommand(snapshot.eligibility.cut, (nodeIds) => ({
        kind: "cut",
        nodeIds,
        focusNodeId: snapshot.deleteFocusNodeId,
        successStatus: "Cut selection."
      }));
  }
}

interface MutableClipboardNode extends NotesClipboardOutlineNode {
  readonly children: MutableClipboardNode[];
}

function clipboardForest(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): readonly NotesClipboardOutlineNode[] | null {
  if (
    rootIds.length === 0 ||
    rootIds.length > MAX_PASTE_IMPORT_NODES
  ) {
    return null;
  }
  const forest: MutableClipboardNode[] = [];
  const visited = new Set<NoteId>();
  let scheduledNodeCount = rootIds.length;
  for (const rootId of rootIds) {
    const root = workspace.nodesById[rootId];
    if (!root || visited.has(rootId)) {
      return null;
    }
    const output: MutableClipboardNode = {
      title: root.title,
      children: []
    };
    forest.push(output);
    visited.add(rootId);
    const stack: Array<{
      nodeId: NoteId;
      output: MutableClipboardNode;
      nextChildIndex: number;
      depth: number;
    }> = [{ nodeId: rootId, output, nextChildIndex: 0, depth: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const childIds = workspace.childIdsByParent[frame.nodeId] ?? [];
      if (frame.nextChildIndex === 0 && childIds.length > 0) {
        if (
          frame.depth + 1 >= MAX_PASTE_IMPORT_DEPTH ||
          scheduledNodeCount + childIds.length > MAX_PASTE_IMPORT_NODES
        ) {
          return null;
        }
        scheduledNodeCount += childIds.length;
      }
      if (frame.nextChildIndex >= childIds.length) {
        stack.pop();
        continue;
      }
      const childId = childIds[frame.nextChildIndex];
      frame.nextChildIndex += 1;
      const child = workspace.nodesById[childId];
      if (!child || visited.has(childId)) {
        return null;
      }
      const childOutput: MutableClipboardNode = {
        title: child.title,
        children: []
      };
      frame.output.children.push(childOutput);
      visited.add(childId);
      stack.push({
        nodeId: childId,
        output: childOutput,
        nextChildIndex: 0,
        depth: frame.depth + 1
      });
    }
  }
  return forest;
}

function cutForestIsLossless(
  rootIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): boolean {
  const pending = [...rootIds];
  const visited = new Set<NoteId>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    const current = workspace.nodesById[nodeId];
    if (!current || visited.has(nodeId)) {
      return false;
    }
    visited.add(nodeId);
    if (
      current.note.length > 0 ||
      /[\r\n]/.test(current.title) ||
      (workspace.attachmentsByNodeId[nodeId]?.length ?? 0) > 0
    ) {
      return false;
    }
    const childIds = workspace.childIdsByParent[nodeId] ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      pending.push(childIds[index]);
    }
  }
  return true;
}

function isDescendantOrSelf(
  nodeId: NoteId,
  rootId: NoteId,
  workspace: NormalizedNotesWorkspace
): boolean {
  const visited = new Set<NoteId>();
  let currentId: NoteId | null = nodeId;
  while (currentId !== null && !visited.has(currentId)) {
    if (currentId === rootId) {
      return true;
    }
    visited.add(currentId);
    currentId = workspace.nodesById[currentId]?.parentId ?? null;
  }
  return false;
}

function copiedSelection(
  duplicatedRootIds: readonly NoteId[] | undefined,
  visibleNodeIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NotesSelection | null {
  if (!duplicatedRootIds || duplicatedRootIds.length === 0) {
    return null;
  }
  const anchorId = duplicatedRootIds[0];
  const lastRootId = duplicatedRootIds[duplicatedRootIds.length - 1];
  const anchorIndex = visibleNodeIds.indexOf(anchorId);
  const lastRootIndex = visibleNodeIds.indexOf(lastRootId);
  if (anchorIndex < 0 || lastRootIndex < anchorIndex) {
    return null;
  }
  let headId = lastRootId;
  for (let index = lastRootIndex + 1; index < visibleNodeIds.length; index += 1) {
    const candidateId = visibleNodeIds[index];
    if (isDescendantOrSelf(candidateId, lastRootId, workspace)) {
      headId = candidateId;
    }
  }
  return { anchorId, headId };
}

function selectionEndpointsVisible(
  snapshot: NotesSelectionActionSnapshot,
  visibleNodeIds: readonly NoteId[]
): boolean {
  const visible = new Set(visibleNodeIds);
  return (
    visible.has(snapshot.selection.anchorId) &&
    visible.has(snapshot.selection.headId)
  );
}

function freshOneStepMove(
  nodeIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace,
  direction: "up" | "down"
): NotesBatchOp | null {
  if (nodeIds.length === 0 || new Set(nodeIds).size !== nodeIds.length) {
    return null;
  }
  const first = workspace.nodesById[nodeIds[0]];
  if (
    !first ||
    nodeIds.some(
      (nodeId) => workspace.nodesById[nodeId]?.parentId !== first.parentId
    )
  ) {
    return null;
  }
  const siblings =
    first.parentId === null
      ? workspace.rootIds
      : (workspace.childIdsByParent[first.parentId] ?? []);
  const positions = nodeIds.map((nodeId) => siblings.indexOf(nodeId));
  if (
    positions.some(
      (position, index) =>
        position < 0 ||
        (index > 0 && position !== positions[index - 1] + 1)
    )
  ) {
    return null;
  }
  const firstIndex = positions[0];
  const lastIndex = positions[positions.length - 1];
  if (
    (direction === "up" && firstIndex === 0) ||
    (direction === "down" && lastIndex === siblings.length - 1)
  ) {
    return null;
  }
  if (direction === "down") {
    return {
      type: "move",
      parentId: first.parentId,
      afterId: siblings[lastIndex + 1]
    };
  }
  if (firstIndex === 1) {
    return {
      type: "move",
      parentId: first.parentId,
      afterId: null,
      beforeId: siblings[0]
    };
  }
  return {
    type: "move",
    parentId: first.parentId,
    afterId: siblings[firstIndex - 2] ?? null
  };
}

function authoritySuccessStatus(
  intent: NotesSelectionCommandIntent,
  command: ResolvedCommand,
  authority: NotesSelectionRouterAuthority
): string {
  if (intent.type !== "complete") {
    return command.successStatus;
  }
  const allComplete = command.nodeIds.every((nodeId) => {
    const current = authority.workspace.nodesById[nodeId];
    return current !== undefined && current.completedAt !== null;
  });
  return allComplete
    ? "Uncompleted selection."
    : "Completed selection.";
}

function feedback<Authority extends NotesSelectionRouterAuthority>(
  dependencies: NotesSelectionCommandRouterDependencies<Authority>,
  status: string | null,
  error: string | null
): void {
  dependencies.onFeedback?.({ status, error });
}

function execution(
  outcome: NotesSelectionCommandExecution["outcome"],
  mutationCommitted = false
): NotesSelectionCommandExecution {
  return { outcome, mutationCommitted };
}

const PROJECTION_REFRESH_ERROR =
  "The command completed, but the current view could not be refreshed.";

interface ActivePreparedClipboardSession<
  Authority extends NotesSelectionRouterAuthority
> {
  readonly handle: NotesPreparedClipboardSession<Authority>;
  readonly authority: Authority;
  readonly revision: number;
  readonly text: string;
  readonly cutAllowed: boolean;
  readonly focusNodeId: NoteId | null;
}

export function createNotesSelectionCommandRouter<
  Authority extends NotesSelectionRouterAuthority
>(
  dependencies: NotesSelectionCommandRouterDependencies<Authority>
): NotesSelectionCommandRouter<Authority> {
  let busy = false;
  let clipboardEpoch = 0;
  let activeClipboardSession:
    | ActivePreparedClipboardSession<Authority>
    | null = null;

  const setBusy = (next: boolean): void => {
    busy = next;
    dependencies.onBusyChange?.(next);
  };

  const invalidatePreparedClipboard = (): void => {
    clipboardEpoch += 1;
    activeClipboardSession = null;
  };

  const finalizePreparedCut = async (
    prepared: ActivePreparedClipboardSession<Authority>,
    expectedNavigationVersion: number
  ): Promise<void> => {
    try {
      if (
        dependencies.getSelectionRevision() !== prepared.revision ||
        !dependencies.isAuthorityCurrent(prepared.authority)
      ) {
        feedback(
          dependencies,
          "Copied.",
          "Notes changed, so nothing was removed."
        );
        return;
      }
      const settlement = await dependencies.applyBatch(
        prepared.authority,
        { type: "delete" },
        {
          focusNodeId: prepared.focusNodeId,
          expectedNavigationVersion
        }
      );
      const committed =
        settlement.outcome === "committed" || settlement.mutationCommitted;
      if (!committed) {
        feedback(
          dependencies,
          "Copied.",
          settlement.outcome === "failed"
            ? "Copied, but couldn't remove."
            : "Notes changed, so nothing was removed."
        );
        return;
      }
      if (!settlement.projectedWorkspace) {
        feedback(dependencies, "Cut selection.", PROJECTION_REFRESH_ERROR);
        return;
      }
      const selectionCleared = dependencies.replaceSelection(
        null,
        prepared.revision
      );
      if (
        selectionCleared &&
        settlement.navigationOwned !== false &&
        prepared.focusNodeId !== null &&
        settlement.projectedWorkspace.nodesById[prepared.focusNodeId]
      ) {
        dependencies.focusNode(prepared.focusNodeId);
      }
      feedback(dependencies, "Cut selection.", null);
    } catch {
      feedback(dependencies, "Copied.", "Copied, but couldn't remove.");
    } finally {
      setBusy(false);
    }
  };

  const prepareClipboard = async (): Promise<
    NotesPreparedClipboardSession<Authority> | null
  > => {
    invalidatePreparedClipboard();
    if (busy) {
      return null;
    }
    const preparationEpoch = clipboardEpoch;
    const revision = dependencies.getSelectionRevision();
    try {
      const draftsFlushed = await dependencies.flushDrafts();
      if (preparationEpoch !== clipboardEpoch) {
        return null;
      }
      if (!draftsFlushed) {
        feedback(
          dependencies,
          null,
          "Save pending changes before continuing."
        );
        return null;
      }
      if (dependencies.getSelectionRevision() !== revision) {
        feedback(dependencies, null, "The selection changed. Try again.");
        return null;
      }
      const snapshot = dependencies.getSnapshot();
      if (!snapshot) {
        feedback(dependencies, null, "Select one or more notes first.");
        return null;
      }
      const copy = snapshot.eligibility.copy;
      if (!copy.eligible) {
        feedback(dependencies, null, copy.reason);
        return null;
      }
      const nodeIds = [...copy.nodeIds];
      if (nodeIds.length === 0) {
        feedback(
          dependencies,
          null,
          "The selected range is no longer available."
        );
        return null;
      }
      const authority = await dependencies.prepareAuthority(nodeIds);
      if (preparationEpoch !== clipboardEpoch) {
        return null;
      }
      if (
        dependencies.getSelectionRevision() !== revision ||
        authority.selectionRevision !== revision ||
        !exactIds(authority.selectedNodeIds, nodeIds) ||
        !dependencies.isAuthorityCurrent(authority)
      ) {
        feedback(dependencies, null, "The selection changed. Try again.");
        return null;
      }
      const forest = clipboardForest(nodeIds, authority.workspace);
      const text = forest ? serializeNotesClipboardOutline(forest) : null;
      if (text === null) {
        feedback(
          dependencies,
          null,
          "The selected outline is too large or invalid to copy."
        );
        return null;
      }
      const handle = Object.freeze({
        [preparedClipboardSessionBrand]: authority
      }) as NotesPreparedClipboardSession<Authority>;
      activeClipboardSession = {
        handle,
        authority,
        revision,
        text,
        cutAllowed: cutForestIsLossless(nodeIds, authority.workspace),
        focusNodeId: snapshot.deleteFocusNodeId
      };
      return handle;
    } catch {
      if (preparationEpoch !== clipboardEpoch) {
        return null;
      }
      feedback(dependencies, null, "The command couldn't be completed.");
      return null;
    }
  };

  const commitPreparedClipboardEvent = (
    intent: NotesPreparedClipboardIntent,
    event: NotesClipboardEvent,
    session: NotesPreparedClipboardSession<Authority>
  ): NotesPreparedClipboardCommitOutcome => {
    const prepared = activeClipboardSession;
    if (!prepared || prepared.handle !== session) {
      return { kind: "rejected", reason: "stale" };
    }
    if (busy) {
      return { kind: "rejected", reason: "busy" };
    }
    if (
      dependencies.getSelectionRevision() !== prepared.revision ||
      !dependencies.isAuthorityCurrent(prepared.authority)
    ) {
      invalidatePreparedClipboard();
      return { kind: "rejected", reason: "stale" };
    }
    if (intent === "cut" && !prepared.cutAllowed) {
      feedback(
        dependencies,
        null,
        "Cut is unavailable because the flushed selection contains rich content. Use Move To to preserve it."
      );
      return { kind: "rejected", reason: "cutUnavailable" };
    }
    const write = writeNotesClipboardEvent(event, prepared.text);
    if (write.kind === "failure") {
      feedback(dependencies, null, write.message);
      return { kind: "failed", message: write.message };
    }
    if (intent === "copy") {
      feedback(dependencies, "Copied.", null);
      return { kind: "committed", intent };
    }

    const expectedNavigationVersion = dependencies.getNavigationVersion();
    activeClipboardSession = null;
    clipboardEpoch += 1;
    feedback(dependencies, "Copied.", null);
    setBusy(true);
    void finalizePreparedCut(prepared, expectedNavigationVersion);
    return { kind: "committed", intent };
  };

  const execute = async (
    intent: NotesSelectionCommandIntent,
    frozenContext?: NotesFrozenSelectionCommandContext<Authority>
  ): Promise<NotesSelectionCommandExecution> => {
    if (busy) {
      return execution("busy");
    }
    const expectedNavigationVersion = dependencies.getNavigationVersion();
    invalidatePreparedClipboard();
    const snapshot =
      frozenContext?.ownership.actionSnapshot ?? dependencies.getSnapshot();
    if (!snapshot) {
      feedback(dependencies, null, "Select one or more notes first.");
      return execution("skipped");
    }
    const resolution = resolveCommand(intent, snapshot);
    if ("error" in resolution) {
      feedback(dependencies, null, resolution.error);
      return execution("skipped");
    }
    const command = resolution.command;
    if (
      frozenContext &&
      !exactIds(command.nodeIds, frozenContext.nodeIds)
    ) {
      feedback(dependencies, null, "The chooser selection is no longer valid.");
      return execution("skipped");
    }
    const openedAuthority = frozenContext?.ownership.authority;
    if (
      openedAuthority &&
      (!exactIds(openedAuthority.selectedNodeIds, command.nodeIds) ||
        !dependencies.isAuthorityCurrent(openedAuthority))
    ) {
      feedback(dependencies, null, "The chooser selection is no longer valid.");
      return execution("skipped");
    }
    if (command.nodeIds.length === 0) {
      feedback(dependencies, null, "The selected range is no longer available.");
      return execution("skipped");
    }

    const frozenRevision =
      openedAuthority?.selectionRevision ?? dependencies.getSelectionRevision();
    setBusy(true);
    feedback(dependencies, null, null);
    try {
      if (!(await dependencies.flushDrafts())) {
        feedback(
          dependencies,
          null,
          "Save pending changes before continuing."
        );
        return execution("skipped");
      }
      if (dependencies.getSelectionRevision() !== frozenRevision) {
        feedback(dependencies, null, "The selection changed. Try again.");
        return execution("skipped");
      }
      if (
        openedAuthority &&
        !dependencies.isAuthorityCurrent(openedAuthority)
      ) {
        feedback(
          dependencies,
          null,
          "The chooser selection is no longer valid."
        );
        return execution("skipped");
      }

      const authority = await dependencies.prepareAuthority(command.nodeIds);
      if (
        authority.selectionRevision !== frozenRevision ||
        !exactIds(authority.selectedNodeIds, command.nodeIds)
      ) {
        feedback(dependencies, null, "The selection changed. Try again.");
        return execution("skipped");
      }
      const successStatus = authoritySuccessStatus(
        intent,
        command,
        authority
      );
      const oneStepOp =
        intent.type === "moveUp" || intent.type === "moveDown"
          ? freshOneStepMove(
              command.nodeIds,
              authority.workspace,
              intent.type === "moveUp" ? "up" : "down"
            )
          : undefined;
      if (
        (intent.type === "moveUp" || intent.type === "moveDown") &&
        !oneStepOp
      ) {
        feedback(dependencies, null, "The selection changed. Try again.");
        return execution("skipped");
      }
      if (command.kind === "copy" || command.kind === "cut") {
        const forest = clipboardForest(command.nodeIds, authority.workspace);
        const text = forest ? serializeNotesClipboardOutline(forest) : null;
        if (text === null) {
          feedback(
            dependencies,
            null,
            "The selected outline is too large or invalid to copy."
          );
          return execution("failed");
        }
        if (
          command.kind === "cut" &&
          !cutForestIsLossless(command.nodeIds, authority.workspace)
        ) {
          feedback(
            dependencies,
            null,
            "Cut is unavailable because the flushed selection contains rich content. Use Move To to preserve it."
          );
          return execution("skipped");
        }
        const clipboard = await dependencies.writeClipboard(text);
        if (clipboard.kind === "failure") {
          feedback(dependencies, null, clipboard.message);
          return execution("failed");
        }
        if (command.kind === "copy") {
          feedback(dependencies, successStatus, null);
          return execution("committed");
        }
        if (!dependencies.isAuthorityCurrent(authority)) {
          feedback(
            dependencies,
            "Copied.",
            "Notes changed, so nothing was removed."
          );
          return execution("skipped");
        }
        const settlement = await dependencies.applyBatch(
          authority,
          { type: "delete" },
          {
            focusNodeId: command.focusNodeId ?? null,
            expectedNavigationVersion
          }
        );
        const committed =
          settlement.outcome === "committed" || settlement.mutationCommitted;
        if (!committed) {
          feedback(
            dependencies,
            "Copied.",
            settlement.outcome === "failed"
              ? "Copied, but couldn't remove."
              : "Notes changed, so nothing was removed."
          );
          return execution(
            settlement.outcome,
            settlement.mutationCommitted
          );
        }
        if (!settlement.projectedWorkspace) {
          feedback(dependencies, successStatus, PROJECTION_REFRESH_ERROR);
          return execution(settlement.outcome, settlement.mutationCommitted);
        }
        const selectionCleared = dependencies.replaceSelection(
          null,
          frozenRevision
        );
        if (
          selectionCleared &&
          settlement.navigationOwned !== false &&
          command.focusNodeId != null &&
          settlement.projectedWorkspace.nodesById[command.focusNodeId]
        ) {
          dependencies.focusNode(command.focusNodeId);
        }
        feedback(dependencies, successStatus, null);
        return execution(settlement.outcome, settlement.mutationCommitted);
      }

      if (!dependencies.isAuthorityCurrent(authority)) {
        feedback(dependencies, null, "The selection changed. Try again.");
        return execution("skipped");
      }
      const settlement = await dependencies.applyBatch(
        authority,
        oneStepOp ?? command.op!,
        intent.type === "delete"
          ? {
              focusNodeId: command.focusNodeId ?? null,
              expectedNavigationVersion
            }
          : command.expandNodeId === undefined
            ? undefined
            : { expandNodeId: command.expandNodeId }
      );
      const committed =
        settlement.outcome === "committed" || settlement.mutationCommitted;
      if (!committed) {
        feedback(
          dependencies,
          null,
          settlement.outcome === "failed"
            ? "The command couldn't be completed."
            : "The selection changed. Try again."
        );
        return execution(settlement.outcome, settlement.mutationCommitted);
      }

      if (intent.type === "duplicate") {
        if (!settlement.projectedWorkspace) {
          feedback(
            dependencies,
            successStatus,
            PROJECTION_REFRESH_ERROR
          );
          return execution(settlement.outcome, settlement.mutationCommitted);
        }
        if (
          !settlement.duplicatedRootIds ||
          settlement.duplicatedRootIds.length === 0
        ) {
          feedback(
            dependencies,
            successStatus,
            "The copied selection could not be resolved."
          );
          return execution(settlement.outcome, settlement.mutationCommitted);
        }
        const nextSelection = copiedSelection(
          settlement.duplicatedRootIds,
          dependencies.getVisibleNodeIds(settlement.projectedWorkspace),
          settlement.projectedWorkspace
        );
        if (!nextSelection) {
          feedback(
            dependencies,
            successStatus,
            "The copied selection could not be resolved."
          );
          return execution(settlement.outcome, settlement.mutationCommitted);
        }
        dependencies.replaceSelection(nextSelection, frozenRevision);
      } else if (
        intent.type === "delete" &&
        settlement.projectedWorkspace
      ) {
        const selectionCleared = dependencies.replaceSelection(
          null,
          frozenRevision
        );
        if (
          selectionCleared &&
          settlement.navigationOwned !== false &&
          command.focusNodeId != null &&
          settlement.projectedWorkspace.nodesById[command.focusNodeId]
        ) {
          dependencies.focusNode(command.focusNodeId);
        }
      } else if (
        settlement.projectedWorkspace &&
        !selectionEndpointsVisible(
          snapshot,
          dependencies.getVisibleNodeIds(settlement.projectedWorkspace)
        )
      ) {
        dependencies.replaceSelection(null, frozenRevision);
      }
      feedback(
        dependencies,
        successStatus,
        settlement.projectedWorkspace ? null : PROJECTION_REFRESH_ERROR
      );
      return execution(settlement.outcome, settlement.mutationCommitted);
    } catch {
      feedback(dependencies, null, "The command couldn't be completed.");
      return execution("failed");
    } finally {
      setBusy(false);
    }
  };

  return {
    execute,
    prepareClipboard,
    commitPreparedClipboardEvent,
    invalidatePreparedClipboard,
    isBusy: () => busy
  };
}

export interface UseNotesSelectionCommandRouterResult<
  Authority extends NotesSelectionRouterAuthority = NotesSelectionRouterAuthority
> {
  readonly execute: NotesSelectionCommandRouter<Authority>["execute"];
  readonly prepareClipboard: NotesSelectionCommandRouter<Authority>["prepareClipboard"];
  readonly commitPreparedClipboardEvent: NotesSelectionCommandRouter<Authority>["commitPreparedClipboardEvent"];
  readonly invalidatePreparedClipboard: NotesSelectionCommandRouter<Authority>["invalidatePreparedClipboard"];
  readonly busy: boolean;
  readonly status: string | null;
  readonly error: string | null;
  readonly clearFeedback: () => void;
}

export function useNotesSelectionCommandRouter<
  Authority extends NotesSelectionRouterAuthority
>(
  dependencies: NotesSelectionCommandRouterDependencies<Authority>
): UseNotesSelectionCommandRouterResult<Authority> {
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;
  const [state, setState] = useState({
    busy: false,
    status: null as string | null,
    error: null as string | null
  });
  const routerRef = useRef<NotesSelectionCommandRouter<Authority> | null>(null);
  if (routerRef.current === null) {
    routerRef.current = createNotesSelectionCommandRouter<Authority>({
      getSnapshot: () => dependenciesRef.current.getSnapshot(),
      getSelectionRevision: () =>
        dependenciesRef.current.getSelectionRevision(),
      getNavigationVersion: () =>
        dependenciesRef.current.getNavigationVersion(),
      getVisibleNodeIds: (workspace) =>
        dependenciesRef.current.getVisibleNodeIds(workspace),
      flushDrafts: () => dependenciesRef.current.flushDrafts(),
      prepareAuthority: (nodeIds) =>
        dependenciesRef.current.prepareAuthority(nodeIds),
      isAuthorityCurrent: (authority) =>
        dependenciesRef.current.isAuthorityCurrent(authority),
      applyBatch: (authority, op, options) =>
        dependenciesRef.current.applyBatch(authority, op, options),
      replaceSelection: (selection, expectedRevision) =>
        dependenciesRef.current.replaceSelection(
          selection,
          expectedRevision
        ),
      focusNode: (nodeId) => dependenciesRef.current.focusNode(nodeId),
      writeClipboard: (text) =>
        dependenciesRef.current.writeClipboard(text),
      onBusyChange: (busy) => {
        setState((current) => ({ ...current, busy }));
        dependenciesRef.current.onBusyChange?.(busy);
      },
      onFeedback: ({ status, error }) => {
        setState((current) => ({ ...current, status, error }));
        dependenciesRef.current.onFeedback?.({ status, error });
      }
    });
  }

  const execute = useCallback(
    (
      intent: NotesSelectionCommandIntent,
      frozenContext?: NotesFrozenSelectionCommandContext<Authority>
    ) => routerRef.current!.execute(intent, frozenContext),
    []
  );
  const prepareClipboard = useCallback(
    () => routerRef.current!.prepareClipboard(),
    []
  );
  const commitPreparedClipboardEvent = useCallback(
    (
      intent: NotesPreparedClipboardIntent,
      event: NotesClipboardEvent,
      session: NotesPreparedClipboardSession<Authority>
    ) =>
      routerRef.current!.commitPreparedClipboardEvent(
        intent,
        event,
        session
      ),
    []
  );
  const invalidatePreparedClipboard = useCallback(
    () => routerRef.current!.invalidatePreparedClipboard(),
    []
  );
  const clearFeedback = useCallback(() => {
    setState((current) => ({ ...current, status: null, error: null }));
  }, []);
  return {
    execute,
    prepareClipboard,
    commitPreparedClipboardEvent,
    invalidatePreparedClipboard,
    ...state,
    clearFeedback
  };
}
