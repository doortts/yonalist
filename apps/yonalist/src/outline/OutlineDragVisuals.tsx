import type { OutlineDropPlan } from "./outlineDragPlan";
import { OutlineDragPreview } from "./OutlineDragPreview";
import { OutlineDropPortal } from "./OutlineDropPortal";

export function OutlineDragVisuals({
  dropTarget,
  preview
}: {
  readonly dropTarget: {
    readonly plan: OutlineDropPlan;
    readonly scope: HTMLElement;
  } | null;
  readonly preview: {
    readonly labels: readonly string[];
    readonly total: number;
    readonly x: number;
    readonly y: number;
  } | null;
}) {
  return (
    <>
      {dropTarget && <OutlineDropPortal {...dropTarget} />}
      {preview && <OutlineDragPreview {...preview} />}
    </>
  );
}
