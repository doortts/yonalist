import {
  useCallback, useEffect, useMemo, useRef, useState, type RefObject
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  advanceOutlineWindow,
  initialOutlineWindowCount,
  materializeOutlineThrough,
  OUTLINE_WINDOW_ESTIMATED_ROW_HEIGHT
} from "./progressiveOutlineWindow";
import {
  registerOutlineMaterializer
} from "./outlineFocus";

interface ProgressiveOutlineWindowOptions {
  readonly nodes: readonly NoteView[];
  readonly scopeKey: string;
  readonly scopeRef: RefObject<HTMLElement | null>;
  readonly afterCursor: string | null;
  readonly onLoadMore: () => Promise<void>;
  readonly pinnedIds: readonly string[];
}

export interface ProgressiveOutlineWindowResult {
  readonly renderedNodes: readonly NoteView[];
  readonly remainingCount: number;
  readonly spacerHeight: number;
  readonly hasTail: boolean;
  readonly listRef: RefObject<HTMLOListElement | null>;
  readonly sentinelRef: RefObject<HTMLLIElement | null>;
  readonly advance: () => void;
  readonly materializeThrough: (nodeId: string) => boolean;
}

export function useProgressiveOutlineWindow({
  nodes,
  scopeKey,
  scopeRef,
  afterCursor,
  onLoadMore,
  pinnedIds
}: ProgressiveOutlineWindowOptions): ProgressiveOutlineWindowResult {
  const [windowState, setWindowState] = useState(() => ({
    scopeKey,
    renderedCount: initialOutlineWindowCount(nodes.length)
  }));
  const listRef = useRef<HTMLOListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  const requestedCursorRef = useRef<string | null>(null);
  const materializeAfterLoadRef = useRef(false);
  const previousNodesRef = useRef({
    scopeKey,
    length: nodes.length
  });
  const renderedCount = windowState.scopeKey === scopeKey
    ? Math.min(windowState.renderedCount, nodes.length)
    : initialOutlineWindowCount(nodes.length);
  const remainingCount = nodes.length - renderedCount;
  const spacerHeight =
    remainingCount * OUTLINE_WINDOW_ESTIMATED_ROW_HEIGHT;

  useEffect(() => {
    if (windowState.scopeKey === scopeKey) return;
    setWindowState({
      scopeKey,
      renderedCount: initialOutlineWindowCount(nodes.length)
    });
  }, [nodes.length, scopeKey, windowState.scopeKey]);

  useEffect(() => {
    const previous = previousNodesRef.current;
    previousNodesRef.current = { scopeKey, length: nodes.length };
    if (previous.scopeKey !== scopeKey) {
      materializeAfterLoadRef.current = false;
      requestedCursorRef.current = null;
      return;
    }
    if (
      nodes.length <= previous.length ||
      !materializeAfterLoadRef.current
    ) {
      return;
    }
    materializeAfterLoadRef.current = false;
    setWindowState((current) => ({
      scopeKey,
      renderedCount: advanceOutlineWindow(
        current.scopeKey === scopeKey
          ? current.renderedCount
          : initialOutlineWindowCount(nodes.length),
        nodes.length
      )
    }));
  }, [nodes.length, scopeKey]);

  const advance = useCallback(() => {
    if (renderedCount >= nodes.length) {
      if (!afterCursor || requestedCursorRef.current === afterCursor) return;
      requestedCursorRef.current = afterCursor;
      materializeAfterLoadRef.current = true;
      void onLoadMore().finally(() => {
        if (requestedCursorRef.current === afterCursor) {
          requestedCursorRef.current = null;
        }
      });
      return;
    }
    setWindowState((current) => ({
      scopeKey,
      renderedCount: advanceOutlineWindow(
        current.scopeKey === scopeKey
          ? current.renderedCount
          : initialOutlineWindowCount(nodes.length),
        nodes.length
      )
    }));
  }, [
    afterCursor,
    nodes.length,
    onLoadMore,
    renderedCount,
    scopeKey
  ]);

  const materializeThrough = useCallback((nodeId: string) => {
    const targetIndex = nodes.findIndex((node) => node.id === nodeId);
    if (targetIndex < 0) return false;
    setWindowState((current) => ({
      scopeKey,
      renderedCount: materializeOutlineThrough(
        current.scopeKey === scopeKey
          ? current.renderedCount
          : initialOutlineWindowCount(nodes.length),
        targetIndex,
        nodes.length
      )
    }));
    return true;
  }, [nodes, scopeKey]);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    return registerOutlineMaterializer(scope, materializeThrough);
  }, [materializeThrough, scopeRef]);

  useEffect(() => {
    let lastPinnedIndex = -1;
    const pinned = new Set(pinnedIds);
    nodes.forEach((node, index) => {
      if (pinned.has(node.id)) lastPinnedIndex = index;
    });
    if (lastPinnedIndex < renderedCount) return;
    materializeThrough(nodes[lastPinnedIndex]!.id);
  }, [
    materializeThrough,
    nodes,
    pinnedIds,
    renderedCount
  ]);

  useEffect(() => {
    const target = sentinelRef.current;
    const root = scopeRef.current?.querySelector<HTMLElement>(
      ".notes-outline-rows"
    );
    const list = listRef.current;
    if (!target || !root || !list) return;
    let release: (() => void) | undefined;
    let active = true;
    void import("./progressiveOutlineObservers").then((module) => {
      if (!active) return;
      release = module.observeProgressiveOutline({
        root,
        sentinel: target,
        list,
        advance,
        renderedCount,
        spacerHeight,
        remainingCount
      });
    });
    return () => {
      active = false;
      release?.();
    };
  }, [
    advance,
    scopeKey,
    scopeRef,
    renderedCount,
    remainingCount,
    spacerHeight
  ]);

  return {
    renderedNodes: useMemo(
      () => nodes.slice(0, renderedCount),
      [nodes, renderedCount]
    ),
    remainingCount,
    spacerHeight,
    hasTail: remainingCount > 0 || afterCursor !== null,
    listRef,
    sentinelRef,
    advance,
    materializeThrough
  };
}
