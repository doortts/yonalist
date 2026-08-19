import type { IpcMarkerKind } from "../../../../packages/contracts/generated/IpcMarkerKind";
import type { NotesState } from "../notesState";
import type { StoreCommands } from "./storeCommands";
import {
  projectCreateNode,
  projectMergeNodeBackward,
  projectRemoveEmptyNode,
  projectSplitNode
} from "../optimisticOutline";
import { orderOutline } from "../outline/outlineModel";
import { omitKeys, subtreeIds } from "./storeState";
import { freshId } from "./storeSupport";

export interface PendingOutlineMutation {
  readonly committed: Promise<void>;
}

// The draft the user just blanked, when the backend still holds non-blank
// text: the debounce has not flushed it and removeEmptyNode would reject.
function blankedDraft(
  draft: string | undefined,
  committed: string | undefined
): string | null {
  if (draft === undefined || draft.trim().length > 0) return null;
  return (committed ?? "").trim().length > 0 ? draft : null;
}

export interface PendingCreatedNode extends PendingOutlineMutation {
  readonly id: string;
}

export interface StoreOutlineMutationHost {
  readonly read: () => NotesState;
  readonly write: (patch: Partial<NotesState>) => void;
  readonly execute: StoreCommands["execute"];
  readonly cancelTitle: (id: string) => void;
  readonly cancelNote: (id: string) => void;
  readonly cancelDrafts: (ids: readonly string[]) => void;
}

interface SplitNodeInput {
  readonly id: string;
  readonly parentId: string;
  readonly beforeId: string | null;
  readonly prefix: string;
  readonly suffix: string;
}

interface MergeNodeInput {
  readonly id: string;
  readonly previousId: string;
  readonly previousText: string;
  readonly currentText: string;
  readonly historyGroup?: string | null;
}

export interface MergeIntoParentInput {
  readonly id: string;
  readonly parentId: string;
  readonly parentText: string;
  readonly currentText: string;
  readonly historyGroup: string | null;
}

export class StoreOutlineMutations {
  constructor(private readonly host: StoreOutlineMutationHost) {}

  async createNode(
    parentId: string,
    text = "",
    beforeId: string | null = null
  ): Promise<string> {
    const pending = this.beginCreateNode(parentId, text, beforeId);
    await pending.committed;
    return pending.id;
  }

  /**
   * `marker` makes the row in the kind the caller asks for. The create command
   * carries no marker, so the kind follows as its own command under a shared
   * history group: the coalescer folds the two into the one undo step the
   * gesture reads as, the way the marker menu item already does.
   */
  beginCreateNode(
    parentId: string,
    text = "",
    beforeId: string | null = null,
    marker: IpcMarkerKind = "bullet"
  ): PendingCreatedNode {
    const id = freshId();
    const state = this.host.read();
    this.host.write(projectCreateNode(state, {
      id,
      parentId,
      beforeId,
      text,
      marker
    }));
    const historyGroup = marker === "bullet" ? null : `create:${id}`;
    const committed = this.host.execute({
      kind: "createNode",
      id,
      parent_id: parentId,
      before_id: beforeId,
      text
    }, historyGroup).then(async () => {
      if (marker === "bullet") return;
      await this.host.execute({ kind: "setMarker", id, marker }, historyGroup);
    }).then(() => undefined).catch((cause) => {
      const current = this.host.read();
      const removedIds = subtreeIds(current.nodes, [id]);
      this.host.write({
        nodes: current.nodes.filter((node) => !removedIds.includes(node.id)),
        drafts: omitKeys(current.drafts, removedIds),
        noteDrafts: omitKeys(current.noteDrafts, removedIds)
      });
      throw cause;
    });
    return { id, committed };
  }

  async splitNode(input: SplitNodeInput): Promise<string> {
    const pending = this.beginSplitNode(input);
    await pending.committed;
    return pending.id;
  }

  beginSplitNode(input: SplitNodeInput): PendingCreatedNode {
    const state = this.host.read();
    const previousDraft = state.drafts[input.id];
    const previousText = state.nodes
      .find((node) => node.id === input.id)?.text;
    const newId = freshId();
    this.host.cancelTitle(input.id);
    this.host.write(projectSplitNode(this.host.read(), { ...input, newId }));
    const committed = this.host.execute({
      kind: "splitNode",
      id: input.id,
      new_id: newId,
      parent_id: input.parentId,
      before_id: input.beforeId,
      prefix: input.prefix,
      suffix: input.suffix
    }).then(() => {
      const current = this.host.read();
      if (current.drafts[input.id] === input.prefix) {
        const drafts = { ...current.drafts };
        delete drafts[input.id];
        this.host.write({ drafts });
      }
    }).catch((cause) => {
      const current = this.host.read();
      const removedIds = subtreeIds(current.nodes, [newId]);
      if (current.drafts[input.id] === input.prefix) {
        const drafts = { ...current.drafts };
        if (previousDraft === undefined) delete drafts[input.id];
        else drafts[input.id] = previousDraft;
        this.host.write({
          nodes: current.nodes
            .filter((node) => !removedIds.includes(node.id))
            .map((node) => node.id === input.id && previousText !== undefined
              ? { ...node, text: previousText }
              : node),
          drafts,
          noteDrafts: omitKeys(current.noteDrafts, removedIds)
        });
      }
      throw cause;
    });
    return { id: newId, committed };
  }

  async removeEmptyNode(id: string): Promise<void> {
    await this.beginRemoveEmptyNode(id).committed;
  }

  beginRemoveEmptyNode(
    id: string,
    historyGroup: string | null = null
  ): PendingOutlineMutation {
    const entry = this.host.read();
    const node = entry.nodes.find((candidate) => candidate.id === id);
    const blankedText = blankedDraft(entry.drafts[id], node?.text);
    const blankedNote = blankedDraft(entry.noteDrafts[id], node?.note);
    if (blankedText === null && blankedNote === null) {
      return this.commitRemoveEmptyNode(id, historyGroup);
    }
    this.host.cancelDrafts([id]);
    const committed = (async () => {
      if (blankedText !== null) {
        await this.host.execute(
          { kind: "updateText", id, text: blankedText },
          historyGroup
        );
      }
      if (blankedNote !== null) {
        await this.host.execute(
          { kind: "updateNote", id, note: blankedNote },
          historyGroup
        );
      }
      await this.commitRemoveEmptyNode(id, historyGroup).committed;
    })();
    return { committed };
  }

  private commitRemoveEmptyNode(
    id: string,
    historyGroup: string | null
  ): PendingOutlineMutation {
    const state = this.host.read();
    const previousDraft = state.drafts[id];
    const previousNoteDraft = state.noteDrafts[id];
    const affectedNodes = state.nodes.filter(
      (node) => node.id === id || node.parentId === id
    );
    this.host.cancelDrafts([id]);
    this.host.write(projectRemoveEmptyNode(state, id));
    const committed = this.host.execute(
      { kind: "removeEmptyNode", id },
      historyGroup
    ).then(() => undefined).catch((cause) => {
      const current = this.host.read();
      const restoredDrafts = previousDraft !== undefined &&
        current.drafts[id] === undefined
        ? { ...current.drafts, [id]: previousDraft }
        : current.drafts;
      const restoredNoteDrafts = previousNoteDraft !== undefined &&
        current.noteDrafts[id] === undefined
        ? { ...current.noteDrafts, [id]: previousNoteDraft }
        : current.noteDrafts;
      const affectedIds = new Set(affectedNodes.map((node) => node.id));
      const nodes = [
        ...current.nodes.filter((node) => !affectedIds.has(node.id)),
        ...affectedNodes
      ];
      this.host.write({
        nodes: orderOutline(nodes, current.activePageId),
        drafts: restoredDrafts,
        noteDrafts: restoredNoteDrafts
      });
      throw cause;
    });
    return { committed };
  }

  // Backspace at the head of a first child folds it into the parent above it.
  // One backend command, because it is one keystroke: spelled as three, any
  // write landing between them -- another row's debounce is enough -- tore the
  // gesture out of its history entry, and one undo answered for part of it.
  // The note is the one thing that still goes ahead of it: a reader who erased
  // it made a separate edit, and the domain refuses to drop a row still
  // carrying one.
  beginMergeNodeIntoParent(
    input: MergeIntoParentInput
  ): PendingOutlineMutation {
    const state = this.host.read();
    const node = state.nodes.find((candidate) => candidate.id === input.id);
    const mergedText = input.parentText + input.currentText;
    const blankedNote = blankedDraft(state.noteDrafts[input.id], node?.note);
    this.host.cancelTitle(input.parentId);
    this.host.cancelDrafts([input.id]);
    const removal = projectRemoveEmptyNode(state, input.id);
    this.host.write({
      nodes: removal.nodes.map((candidate) => candidate.id === input.parentId
        ? { ...candidate, text: mergedText }
        : candidate),
      drafts: { ...removal.drafts, [input.parentId]: mergedText },
      noteDrafts: removal.noteDrafts
    });
    const committed = (async () => {
      try {
        if (blankedNote !== null) {
          await this.host.execute(
            { kind: "updateNote", id: input.id, note: blankedNote },
            input.historyGroup
          );
        }
        await this.host.execute(
          {
            kind: "mergeNodeIntoParent",
            id: input.id,
            parent_id: input.parentId,
            parent_text: input.parentText,
            current_text: input.currentText
          },
          input.historyGroup
        );
      } catch (cause) {
        // ponytail: the whole optimistic tree goes back, which would clobber
        // an edit landed since. The command queue serializes writes, so that
        // window is one failed round trip; per-node restore if it ever bites.
        this.host.write({
          nodes: state.nodes,
          drafts: state.drafts,
          noteDrafts: state.noteDrafts
        });
        throw cause;
      }
      const current = this.host.read();
      if (current.drafts[input.parentId] === mergedText) {
        const drafts = { ...current.drafts };
        delete drafts[input.parentId];
        this.host.write({ drafts });
      }
    })();
    return { committed };
  }

  beginMergeNodeBackward(input: MergeNodeInput): PendingOutlineMutation {
    const state = this.host.read();
    const previousNode = state.nodes.find(
      (node) => node.id === input.previousId
    );
    const currentNode = state.nodes.find((node) => node.id === input.id);
    const previousDraft = state.drafts[input.previousId];
    const currentDraft = state.drafts[input.id];
    const mergedText = input.previousText + input.currentText;
    this.host.cancelTitle(input.previousId);
    this.host.cancelTitle(input.id);
    this.host.cancelNote(input.previousId);
    this.host.write(projectMergeNodeBackward(state, input));
    const committed = this.host.execute({
      kind: "mergeNodeBackward",
      id: input.id,
      previous_id: input.previousId,
      previous_text: input.previousText,
      current_text: input.currentText
    }, input.historyGroup ?? null).then(() => {
      const current = this.host.read();
      if (current.drafts[input.id] === mergedText) {
        const drafts = { ...current.drafts };
        delete drafts[input.id];
        this.host.write({ drafts });
      }
    }).catch((cause) => {
      const current = this.host.read();
      const nodes = current.nodes
        .filter((node) => node.id !== input.previousId && node.id !== input.id);
      if (previousNode) nodes.push(previousNode);
      if (currentNode) nodes.push(currentNode);
      const drafts = { ...current.drafts };
      if (drafts[input.id] === mergedText) {
        if (currentDraft === undefined) delete drafts[input.id];
        else drafts[input.id] = currentDraft;
      }
      if (previousDraft !== undefined) {
        drafts[input.previousId] = previousDraft;
      }
      this.host.write({
        nodes: orderOutline(nodes, current.activePageId),
        drafts
      });
      throw cause;
    });
    return { committed };
  }
}
