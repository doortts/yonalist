import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { focusAfterCommit } from "./outlineFocus";
import { subtreeIds } from "./storeState";

/**
 * The caret is standing in one of the rows about to go, so removal hands it
 * to the row above -- the row below when there is none, the heading when the
 * outline is emptied. Read before the command, off the rows as they still
 * stand.
 */
export function caretHandoff({
  nodes, visibleNodes, outlineRootId, scopeRef
}: {
  readonly nodes: readonly NoteView[];
  readonly visibleNodes: readonly NoteView[];
  readonly outlineRootId: string;
  readonly scopeRef: { readonly current: HTMLElement | null };
}): (rootIds: readonly string[]) => () => void {
  return (rootIds) => {
    const removed = new Set(subtreeIds(nodes, rootIds));
    const first = visibleNodes.findIndex((node) => removed.has(node.id));
    const previous = first > 0 ? visibleNodes[first - 1] : undefined;
    const next = first < 0
      ? undefined
      : visibleNodes.slice(first + 1).find((node) => !removed.has(node.id));
    const target = previous ?? next;
    return () => {
      const scope = scopeRef.current;
      if (!scope) return;
      focusAfterCommit(
        scope,
        target?.id ?? outlineRootId,
        previous ? "end" : "start"
      );
    };
  };
}
