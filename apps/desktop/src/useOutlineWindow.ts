import {
  useCallback, useLayoutEffect, useMemo, useRef, useState
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";

// Rows are not uniform — a title, a title with a supporting note and an image
// row all differ — so every mounted row is measured and the rows that have
// never been mounted fall back to the average of what has been measured.
const ESTIMATED_ROW_HEIGHT = 34;
// Rows rendered before the first measurement lands. The layout effect below
// corrects this within the same commit, so it only has to be a plausible
// screenful; where the viewport turns out to be unmeasurable it widens to the
// whole outline.
const UNMEASURED_ROWS = 60;

export type OutlineWindowItem =
  | { readonly kind: "gap"; readonly key: string; readonly height: number }
  | { readonly kind: "row"; readonly node: NoteView };

interface WindowRange {
  readonly start: number;
  readonly end: number;
}

function rowIndexAt(offsets: Float64Array, position: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((offsets[middle] ?? 0) <= position) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

function listOffset(scroller: HTMLElement, list: HTMLElement): number {
  return list.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop;
}

/**
 * Renders only the outline rows near the viewport and stands measured gaps in
 * for the rest, so the scroll height stays honest. When the scroll container
 * reports no height — jsdom, a collapsed pane — every row is rendered, which
 * is what the outline did before this existed.
 */
export function useOutlineWindow(nodes: readonly NoteView[]) {
  const heights = useRef(new Map<string, number>());
  const average = useRef({ total: 0, count: 0 });
  const renderedIds = useRef<readonly string[]>([]);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [list, setList] = useState<HTMLElement | null>(null);
  const [measurements, setMeasurements] = useState(0);
  const [range, setRange] = useState<WindowRange | null>({
    start: 0,
    end: UNMEASURED_ROWS
  });
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const offsets = useMemo(() => {
    void measurements;
    const measured = average.current;
    const estimate = measured.count > 0
      ? measured.total / measured.count
      : ESTIMATED_ROW_HEIGHT;
    const positions = new Float64Array(nodes.length + 1);
    let total = 0;
    for (const [position, node] of nodes.entries()) {
      positions[position] = total;
      total += heights.current.get(node.id) ?? estimate;
    }
    positions[nodes.length] = total;
    return positions;
  }, [measurements, nodes]);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  const sync = useCallback(() => {
    // Before the rows are on screen there is nothing to measure and no
    // viewport to measure against; holding the provisional window here is
    // what stops a mount from briefly rendering the whole outline.
    if (!scroller || !list) return;
    let changed = false;
    let pendingId: string | undefined;
    let pendingTop = 0;
    const record = (id: string, height: number) => {
      const known = heights.current.get(id);
      if (!(height > 0) || known === height) return;
      average.current.total += height - (known ?? 0);
      if (known === undefined) average.current.count += 1;
      heights.current.set(id, height);
      changed = true;
    };
    // A row is as tall as the distance to whatever follows it, which is the
    // only measurement that carries the margins between rows; a row's own box
    // leaves them out and the gaps would then under-reserve.
    for (const child of list.children) {
      if (!(child instanceof HTMLElement)) continue;
      const top = child.getBoundingClientRect().top;
      if (pendingId !== undefined) record(pendingId, top - pendingTop);
      pendingId = undefined;
      if (!child.classList.contains("notes-outline-item")) continue;
      // The row names itself. Counting rows off against a parallel array of
      // ids instead would hand every row after a removal its neighbour's
      // height the one time the two fall out of step.
      const id = child.querySelector<HTMLElement>("[data-outline-id]")
        ?.dataset.outlineId;
      if (id === undefined) continue;
      pendingId = id;
      pendingTop = top;
    }
    if (pendingId !== undefined) {
      record(pendingId, list.getBoundingClientRect().bottom - pendingTop);
    }
    if (changed) setMeasurements((value) => value + 1);
    const viewport = scroller.clientHeight;
    const top = viewport > 0 ? scroller.scrollTop - listOffset(scroller, list) : 0;
    // One screenful of overscan each way keeps paging and drag autoscroll
    // ahead of the rows they need.
    const next = viewport > 0 ? {
      start: rowIndexAt(offsetsRef.current, top - viewport),
      end: rowIndexAt(offsetsRef.current, top + viewport * 2) + 1
    } : null;
    setRange((current) =>
      current?.start === next?.start && current?.end === next?.end
        ? current
        : next);
  }, [list, scroller]);

  // A node that has gone takes its measurement with it. Left behind, it keeps
  // pulling the average that every row nobody has scrolled past is drawn at.
  useLayoutEffect(() => {
    if (heights.current.size === 0) return;
    const live = new Set(nodes.map((node) => node.id));
    let dropped = false;
    for (const [id, height] of heights.current) {
      if (live.has(id)) continue;
      heights.current.delete(id);
      average.current.total -= height;
      average.current.count -= 1;
      dropped = true;
    }
    if (dropped) setMeasurements((value) => value + 1);
  }, [nodes]);

  useLayoutEffect(() => {
    if (!scroller || !list) return;
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(sync)
      : null;
    observer?.observe(scroller);
    observer?.observe(list);
    const remember = (event: FocusEvent) => {
      const id = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-outline-id]")
          ?.dataset.outlineId
        : undefined;
      if (id !== undefined) setPinnedId(id);
    };
    scroller.addEventListener("scroll", sync, { passive: true });
    scroller.addEventListener("focusin", remember);
    return () => {
      observer?.disconnect();
      scroller.removeEventListener("scroll", sync);
      scroller.removeEventListener("focusin", remember);
    };
  }, [list, scroller, sync]);

  const items = useMemo<readonly OutlineWindowItem[]>(() => {
    if (!range) return nodes.map((node) => ({ kind: "row", node }) as const);
    const start = Math.min(range.start, nodes.length);
    const end = Math.min(range.end, nodes.length);
    // The pinned row is the one that last held focus, and it stays mounted
    // wherever it has scrolled to: unmounting it would drop the caret, and
    // with it whatever was being typed.
    const pinned = pinnedId === null
      ? -1
      : nodes.findIndex((node) => node.id === pinnedId);
    const positions: number[] = [];
    if (pinned >= 0 && pinned < start) positions.push(pinned);
    for (let position = start; position < end; position += 1) {
      positions.push(position);
    }
    if (pinned >= end) positions.push(pinned);
    const windowed: OutlineWindowItem[] = [];
    let consumed = 0;
    for (const position of positions) {
      const gap = (offsets[position] ?? 0) - consumed;
      if (gap > 0) {
        windowed.push({ kind: "gap", key: `gap-${position}`, height: gap });
      }
      windowed.push({ kind: "row", node: nodes[position]! });
      consumed = offsets[position + 1] ?? 0;
    }
    const tail = (offsets[nodes.length] ?? 0) - consumed;
    if (tail > 0) windowed.push({ kind: "gap", key: "gap-end", height: tail });
    return windowed;
  }, [nodes, offsets, pinnedId, range]);

  useLayoutEffect(() => {
    renderedIds.current = items.flatMap(
      (item) => item.kind === "row" ? [item.node.id] : []);
    sync();
  }, [items, sync]);

  // Brings a row that sits outside the window into it, so callers that reach
  // for a row by id can still find it in the DOM a frame later.
  const reveal = useCallback((nodeId: string) => {
    const position = nodes.findIndex((node) => node.id === nodeId);
    if (position < 0) return false;
    const viewport = scroller?.clientHeight ?? 0;
    if (scroller && list && viewport > 0 &&
      !renderedIds.current.includes(nodeId)) {
      const top = listOffset(scroller, list) +
        (offsetsRef.current[position] ?? 0);
      scroller.scrollTop = Math.max(0, top - viewport / 2);
    }
    setPinnedId(nodeId);
    sync();
    return true;
  }, [list, nodes, scroller, sync]);

  return { items, reveal, scrollRef: setScroller, listRef: setList };
}
