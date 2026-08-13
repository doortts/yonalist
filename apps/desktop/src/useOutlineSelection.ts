import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ClipboardEvent
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import {
  buildOutlineClipboardFormats,
  CUT_OVER_CLIPBOARD_BOUNDS,
  normalizeSelectedRoots,
  SELECTION_INCOMPLETE,
  writeOutlineClipboard,
  writeOutlineClipboardEvent
} from "./outlineClipboard";

const WRITE_FAILED = "Could not write the selected outline to the clipboard.";

export function useOutlineSelection(
  nodes: readonly NoteView[],
  allNodes: readonly NoteView[],
  store: NotesStore,
  resetKey: string,
  outlineComplete: boolean,
  revision: number
) {
  const [directIds, setDirectIds] = useState<readonly string[]>([]);
  const [authoritativeNodes, setAuthoritativeNodes] =
    useState<readonly NoteView[]>([]);
  const [forestStatus, setForestStatus] =
    useState<"idle" | "complete" | "incomplete">("idle");
  const [forestRevision, setForestRevision] = useState<number | null>(null);
  const [headId, setHeadId] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    setDirectIds([]);
    setAuthoritativeNodes([]);
    setForestStatus("idle");
    setForestRevision(null);
    setHeadId(null);
    anchor.current = null;
  }, [resetKey]);

  const replaceDirect = (ids: readonly string[]) => {
    setDirectIds(ids);
    setAuthoritativeNodes([]);
    setForestStatus("idle");
    setForestRevision(null);
  };
  const select = (id: string, extend: boolean, toggle: boolean) => {
    if (extend && anchor.current) {
      const start = nodes.findIndex((node) => node.id === anchor.current);
      const end = nodes.findIndex((node) => node.id === id);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        replaceDirect(nodes.slice(from, to + 1).map((node) => node.id));
        setHeadId(id);
        return;
      }
    }
    anchor.current = id;
    setHeadId(id);
    setAuthoritativeNodes([]);
    setForestStatus("idle");
    setForestRevision(null);
    setDirectIds((current) => {
      return toggle
        ? current.includes(id)
          ? current.filter((candidate) => candidate !== id)
          : [...current, id]
        : [id];
    });
  };

  const extend = (originId: string, nextHeadId: string) => {
    // A band grows from its own anchor, but with no band up there is nothing to
    // grow: the sweep starts here. A plain click leaves an anchor behind with
    // nothing selected, and extending from that one would hand back a band
    // reaching all the way to whichever row was last clicked.
    if (!anchor.current || directIds.length === 0) anchor.current = originId;
    const start = nodes.findIndex((node) => node.id === anchor.current);
    const end = nodes.findIndex((node) => node.id === nextHeadId);
    if (start < 0 || end < 0) return;
    const [from, to] = start < end ? [start, end] : [end, start];
    replaceDirect(nodes.slice(from, to + 1).map((node) => node.id));
    setHeadId(nextHeadId);
  };

  const clear = () => {
    anchor.current = null;
    setHeadId(null);
    replaceDirect([]);
  };
  const beginPointer = (id: string) => {
    anchor.current = id;
    setHeadId(null);
    replaceDirect([]);
  };
  const replace = (ids: readonly string[]) => {
    anchor.current = ids[0] ?? null;
    setHeadId(ids.at(-1) ?? null);
    replaceDirect(ids);
  };

  const selectedRootIds = useMemo(
    () => normalizeSelectedRoots(allNodes, directIds),
    [allNodes, directIds]
  );
  const localSelectedIds = useMemo(() => {
    if (selectedRootIds.length === 0) return [];
    const roots = new Set(selectedRootIds);
    const byId = new Map(allNodes.map((node) => [node.id, node]));
    return allNodes.filter((node) => {
      let current: NoteView | undefined = node;
      const visited = new Set<string>();
      while (current && visited.add(current.id)) {
        if (roots.has(current.id)) return true;
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return false;
    }).map((node) => node.id);
  }, [allNodes, selectedRootIds]);
  const forestComplete =
    forestStatus === "complete" && forestRevision === revision;
  const selectionComplete = forestComplete ||
    (forestRevision !== revision && outlineComplete);
  const selectedIds = useMemo(
    () => forestComplete
      ? authoritativeNodes.map((node) => node.id)
      : localSelectedIds,
    [authoritativeNodes, forestComplete, localSelectedIds]
  );
  const selectedEpoch = useSyncExternalStore(
    useCallback(
      (listener) => store.subscribeNodes(selectedIds, listener),
      [selectedIds, store]
    ),
    useCallback(
      () => store.getNodeEpoch(selectedIds),
      [selectedIds, store]
    )
  );
  const selectedContentNodes = useMemo(() => {
    void selectedEpoch;
    if (selectedIds.length === 0) return [];
    const currentById = new Map(
      store.getSnapshot().nodes.map((node) => [node.id, node])
    );
    const source = forestComplete ? authoritativeNodes : allNodes;
    return source.map((node) => currentById.get(node.id) ?? node);
  }, [
    allNodes,
    authoritativeNodes,
    forestComplete,
    selectedIds.length,
    selectedEpoch,
    store
  ]);
  const selectedNodes = selectedContentNodes.filter(
    (node) => selectedIds.includes(node.id)
  );
  const { drafts, noteDrafts } = store.getSnapshot();
  const rootKey = selectedRootIds.join("\u0000");
  const materializeForest = useCallback((
    rootIds: readonly string[],
    completeNodes: readonly NoteView[],
    complete: boolean,
    confirmedRevision: number
  ) => {
    // The same roots have to keep the same array. The pane asks for the forest
    // from an effect that watches this list's identity, so answering with a
    // fresh copy of the roots it already holds sets it asking again, forever.
    setDirectIds((current) =>
      current.length === rootIds.length &&
      current.every((id, at) => id === rootIds[at])
        ? current
        : rootIds);
    setAuthoritativeNodes(completeNodes);
    setForestStatus(complete ? "complete" : "incomplete");
    setForestRevision(confirmedRevision);
  }, []);
  // Built on the copy gesture, never on the render: serializing the payload and
  // its base64 costs milliseconds at the 2,000-node bound, and a memo over the
  // drafts would pay it again on every keystroke a band is live for.
  const buildFormats = () => selectionComplete
    ? buildOutlineClipboardFormats(
      { nodes: selectedContentNodes, drafts, noteDrafts },
      selectedIds
    )
    : null;
  // Nothing else is left to refuse over: the payload carries the note, the
  // marker, the tick and the image hash, so the losses a Cut used to be turned
  // down for are no longer losses. The size bound answers on the gesture.
  const cutRefusal = selectionComplete ? null : SELECTION_INCOMPLETE;
  const canCut = cutRefusal === null;
  /**
   * `null` once every format is on the event, or why none of them could go --
   * the size and a refused write are different failures, and a cut has to say
   * which one turned it down.
   */
  const writeToEvent = (event: ClipboardEvent<HTMLElement>): string | null => {
    if (selectedIds.length === 0) return WRITE_FAILED;
    const formats = buildFormats();
    if (!formats) return CUT_OVER_CLIPBOARD_BOUNDS;
    event.preventDefault();
    return writeOutlineClipboardEvent(event.clipboardData, formats)
      ? null
      : WRITE_FAILED;
  };
  const copy = (event: ClipboardEvent<HTMLElement>) => {
    writeToEvent(event);
  };
  // No default, matching `writeOutlineClipboard`: a cut that forgot this would
  // delete against a clipboard the degrade path had emptied.
  const copyToSystem = async (payloadRequired: boolean) => {
    const formats = buildFormats();
    if (!formats) {
      throw new Error(payloadRequired
        ? CUT_OVER_CLIPBOARD_BOUNDS
        : "The selected outline cannot be copied.");
    }
    await writeOutlineClipboard(formats, payloadRequired);
  };

  return {
    selectedIds,
    selectedNodes,
    selectedRootIds,
    rootKey,
    headId,
    canCut,
    cutRefusal,
    forestComplete: selectionComplete,
    select,
    extend,
    clear,
    beginPointer,
    replace,
    materializeForest,
    copy,
    copyToSystem,
    writeToEvent
  };
}
