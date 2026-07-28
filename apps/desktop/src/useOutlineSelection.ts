import {
  useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  canCutSelectedOutline,
  normalizeSelectedRoots,
  serializeSelectedOutline,
  writeOutlineClipboard,
  writeOutlineClipboardEvent
} from "./outlineClipboard";

export function useOutlineSelection(
  nodes: readonly NoteView[],
  allNodes: readonly NoteView[],
  drafts: Readonly<Record<string, string>>,
  noteDrafts: Readonly<Record<string, string>>,
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
    if (!anchor.current) anchor.current = originId;
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
  const selectedIds = forestComplete
    ? authoritativeNodes.map((node) => node.id)
    : localSelectedIds;
  const selectedNodes = forestComplete ? authoritativeNodes : allNodes.filter(
    (node) => selectedIds.includes(node.id)
  );
  const rootKey = selectedRootIds.join("\u0000");
  const materializeForest = useCallback((
    rootIds: readonly string[],
    completeNodes: readonly NoteView[],
    complete: boolean,
    confirmedRevision: number
  ) => {
    setDirectIds(rootIds);
    setAuthoritativeNodes(completeNodes);
    setForestStatus(complete ? "complete" : "incomplete");
    setForestRevision(confirmedRevision);
  }, []);
  const clipboardText = useMemo(
    () => selectionComplete
      ? serializeSelectedOutline(
        forestComplete ? authoritativeNodes : allNodes,
        drafts,
        selectedIds
      )
      : null,
    [
      allNodes,
      authoritativeNodes,
      drafts,
      forestComplete,
      selectedIds,
      selectionComplete
    ]
  );
  const canCut = useMemo(
    () => selectionComplete && canCutSelectedOutline(
      forestComplete ? authoritativeNodes : allNodes,
      drafts,
      noteDrafts,
      selectedIds
    ),
    [
      allNodes,
      authoritativeNodes,
      drafts,
      forestComplete,
      noteDrafts,
      selectedIds,
      selectionComplete
    ]
  );
  const writeToEvent = (event: ClipboardEvent<HTMLElement>) => {
    if (selectedIds.length === 0 || !clipboardText) return false;
    event.preventDefault();
    return writeOutlineClipboardEvent(event.clipboardData, clipboardText);
  };
  const copy = (event: ClipboardEvent<HTMLElement>) => {
    writeToEvent(event);
  };
  const copyToSystem = async () => {
    if (!clipboardText) throw new Error("The selected outline cannot be copied.");
    await writeOutlineClipboard(clipboardText);
  };

  return {
    selectedIds,
    selectedNodes,
    selectedRootIds,
    rootKey,
    headId,
    canCut,
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
