import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { NotesStore } from "../notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  guideBandAt, guideCanFold, guideOwnerId, guideTargets, planGuideToggle,
  type GuidePending
} from "./outlineGuideToggle";

const INTERACTIVE_SELECTOR = "button, a, [role='button'], textarea, input";

interface GuideHit {
  readonly ownerId: string;
  readonly band: number;
  /**
   * Whether a click here would fold anything. The paint and the cursor both
   * read it: a range with nothing to fold lights dim and drops the pointer.
   */
  readonly actionable: boolean;
}

/**
 * A click on an indentation guide closes the range it spans, and the click
 * after that hands the range back the shape it was holding. The guide is the
 * row's own background stripe rather than an element, so the gesture is a hit
 * test against the same two custom properties that paint it -- read off the
 * row, since the narrow layout moves both.
 */
export function useOutlineGuideToggle(
  store: NotesStore,
  index: OutlineIndex,
  rootId: string
) {
  const indexRef = useRef(index);
  const rootIdRef = useRef(rootId);
  indexRef.current = index;
  rootIdRef.current = rootId;
  // One kept shape per guide, so closing a second guide does not cost the first
  // one its way back.
  const pendingRef = useRef(new Map<string, GuidePending>());
  const hotRef = useRef<GuideHit | null>(null);
  // A click fires wherever the mouse came up, so a row-selection drag that
  // happens to end on a stripe would fold a range nobody asked about. The
  // gesture only counts when it started on the same guide it ended on.
  const armedRef = useRef<GuideHit | null>(null);
  // Where the pointer last was, so the lit guide can be worked out again after
  // the rows move under a mouse that never moved itself.
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const settlingRef = useRef(false);
  const foldingRef = useRef(false);

  const hitFrom = (
    target: EventTarget | null,
    clientX: number
  ): GuideHit | null => {
    if (!(target instanceof Element)) return null;
    // The parent's stripe runs between the row's menu button and its chevron,
    // so a pointer that landed on either of those wanted the button.
    if (target.closest(INTERACTIVE_SELECTOR)) return null;
    const row = target.closest<HTMLElement>(".notes-node[data-outline-id]");
    const rowId = row?.dataset.outlineId;
    if (!row || !rowId) return null;
    const styles = getComputedStyle(row);
    const band = guideBandAt(
      clientX - row.getBoundingClientRect().left,
      parseFloat(styles.getPropertyValue("--notes-bullet-center-offset")),
      parseFloat(styles.getPropertyValue("--notes-outline-indent"))
    );
    if (band === null) return null;
    const depth = indexRef.current.depthOf(rowId, rootIdRef.current);
    const ownerId = guideOwnerId(indexRef.current, rowId, depth, band);
    if (ownerId === null) return null;
    return {
      ownerId,
      band,
      actionable: guideCanFold(indexRef.current, ownerId)
    };
  };

  const hitAt = (event: ReactMouseEvent<HTMLElement>): GuideHit | null => {
    pointRef.current = { x: event.clientX, y: event.clientY };
    return hitFrom(event.target, event.clientX);
  };

  /**
   * The lit stripe is written straight onto the rows rather than through props:
   * the rows are memoized so the pane can render without them, and a hover has
   * no business undoing that.
   */
  const paint = (list: HTMLElement, hit: GuideHit | null) => {
    list.querySelectorAll<HTMLElement>("[data-guide-hot]").forEach((row) => {
      delete row.dataset.guideHot;
      row.style.removeProperty("--notes-guide-hot");
    });
    // Only a range that can fold offers a click, so only that one takes the
    // pointer; the rest keep the plain arrow the rows already show.
    list.style.cursor = hit?.actionable ? "pointer" : "";
    if (!hit) return;
    list.querySelectorAll<HTMLElement>(".notes-node[data-outline-id]")
      .forEach((row) => {
        const rowId = row.dataset.outlineId!;
        if (!indexRef.current.isDescendant(rowId, hit.ownerId)) return;
        // `true` is the actionable flavour's historical value, kept so that
        // path writes exactly what it always did; the CSS reads the value only
        // to recolour, and selects the geometry on the attribute's presence.
        row.dataset.guideHot = hit.actionable ? "true" : "inert";
        row.style.setProperty("--notes-guide-hot", String(hit.band));
      });
  };

  const light = (list: HTMLElement, hit: GuideHit | null) => {
    const lit = hotRef.current;
    // The flavour belongs in the key. An edit that empties the range leaves the
    // stripe and its owner untouched, so a repaint keyed on those alone would
    // be skipped and the line would keep offering a fold that is gone.
    if (
      lit?.ownerId === hit?.ownerId &&
      lit?.band === hit?.band &&
      lit?.actionable === hit?.actionable
    ) {
      return;
    }
    hotRef.current = hit;
    paint(list, hit);
  };

  /**
   * Folding a range moves the rows out from under a stationary pointer, and no
   * move event follows to say what it is now over. Each render the fold causes
   * re-reads the guide at the pointer's own position, so the lit line follows
   * the rows the click rearranged and the next click has something to aim at.
   * The rows carry the whole batch, so this keeps up until the last row lands
   * and then stands down rather than measuring on every later render.
   */
  useEffect(() => {
    const list = listRef.current;
    const point = pointRef.current;
    if (!settlingRef.current || !list || !point) return;
    if (!foldingRef.current) settlingRef.current = false;
    const hit = hitFrom(document.elementFromPoint(point.x, point.y), point.x);
    hotRef.current = hit;
    paint(list, hit);
  });

  return {
    onMouseMove: (event: ReactMouseEvent<HTMLOListElement>) => {
      const list = event.currentTarget;
      // A row-selection drag owns the pointer; lighting a guide under it would
      // offer a click the gesture is never going to deliver.
      settlingRef.current = false;
      light(list, list.dataset.rowSelecting ? null : hitAt(event));
    },
    onMouseLeave: (event: ReactMouseEvent<HTMLOListElement>) => {
      settlingRef.current = false;
      pointRef.current = null;
      light(event.currentTarget, null);
    },
    onMouseDown: (event: ReactMouseEvent<HTMLOListElement>) => {
      armedRef.current = hitAt(event);
    },
    onClick: (event: ReactMouseEvent<HTMLOListElement>) => {
      const armed = armedRef.current;
      armedRef.current = null;
      const hit = hitAt(event);
      if (!hit || armed?.ownerId !== hit.ownerId || armed.band !== hit.band) {
        return;
      }
      const pending = pendingRef.current;
      const plan = planGuideToggle(
        guideTargets(indexRef.current, hit.ownerId),
        pending.get(hit.ownerId) ?? null
      );
      if (plan.pending) pending.set(hit.ownerId, plan.pending);
      else pending.delete(hit.ownerId);
      if (plan.changes.length === 0) return;
      // The rows are about to move without the pointer moving, so the effect
      // above takes over lighting the guide until the mouse has its own say.
      listRef.current = event.currentTarget;
      settlingRef.current = true;
      foldingRef.current = true;
      void store.setCollapsedMany(plan.changes).finally(() => {
        foldingRef.current = false;
      });
    }
  };
}
