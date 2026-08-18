import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { NotesStore } from "../notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  guideBandAt, guideOwnerId, guideTargets, planGuideToggle, type GuidePending
} from "./outlineGuideToggle";

const INTERACTIVE_SELECTOR = "button, a, [role='button'], textarea, input";

interface GuideHit {
  readonly ownerId: string;
  readonly band: number;
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

  const hitAt = (event: ReactMouseEvent<HTMLElement>): GuideHit | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    // The parent's stripe runs between the row's menu button and its chevron,
    // so a pointer that landed on either of those wanted the button.
    if (target.closest(INTERACTIVE_SELECTOR)) return null;
    const row = target.closest<HTMLElement>(".notes-node[data-outline-id]");
    const rowId = row?.dataset.outlineId;
    if (!row || !rowId) return null;
    const styles = getComputedStyle(row);
    const band = guideBandAt(
      event.clientX - row.getBoundingClientRect().left,
      parseFloat(styles.getPropertyValue("--notes-bullet-center-offset")),
      parseFloat(styles.getPropertyValue("--notes-outline-indent"))
    );
    if (band === null) return null;
    const depth = indexRef.current.depthOf(rowId, rootIdRef.current);
    const ownerId = guideOwnerId(indexRef.current, rowId, depth, band);
    return ownerId === null ? null : { ownerId, band };
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
    list.style.cursor = hit ? "pointer" : "";
    if (!hit) return;
    list.querySelectorAll<HTMLElement>(".notes-node[data-outline-id]")
      .forEach((row) => {
        const rowId = row.dataset.outlineId!;
        if (!indexRef.current.isDescendant(rowId, hit.ownerId)) return;
        row.dataset.guideHot = "true";
        row.style.setProperty("--notes-guide-hot", String(hit.band));
      });
  };

  const light = (list: HTMLElement, hit: GuideHit | null) => {
    const lit = hotRef.current;
    if (lit?.ownerId === hit?.ownerId && lit?.band === hit?.band) return;
    hotRef.current = hit;
    paint(list, hit);
  };

  return {
    onMouseMove: (event: ReactMouseEvent<HTMLOListElement>) => {
      const list = event.currentTarget;
      // A row-selection drag owns the pointer; lighting a guide under it would
      // offer a click the gesture is never going to deliver.
      light(list, list.dataset.rowSelecting ? null : hitAt(event));
    },
    onMouseLeave: (event: ReactMouseEvent<HTMLOListElement>) => {
      light(event.currentTarget, null);
    },
    onClick: (event: ReactMouseEvent<HTMLOListElement>) => {
      const hit = hitAt(event);
      if (!hit) return;
      const pending = pendingRef.current;
      const plan = planGuideToggle(
        guideTargets(indexRef.current, hit.ownerId),
        pending.get(hit.ownerId) ?? null
      );
      if (plan.pending) pending.set(hit.ownerId, plan.pending);
      else pending.delete(hit.ownerId);
      if (plan.changes.length === 0) return;
      // The rows about to leave carry the lit stripe with them, so the guide
      // relights off the next move over whatever is left standing.
      light(event.currentTarget, null);
      void store.setCollapsedMany(plan.changes);
    }
  };
}
