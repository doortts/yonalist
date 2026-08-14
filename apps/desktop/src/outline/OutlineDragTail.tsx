import type { CSSProperties } from "react";
import type { OutlineDropPlan } from "./outlineDragPlan";

export function OutlineDragTail({
  plan
}: {
  readonly plan: OutlineDropPlan | null;
}) {
  if (!plan || plan.previewBeforeId !== null) return null;
  return (
    <li className="notes-outline-drop-preview-tail" aria-hidden="true">
      <span
        className="notes-outline-drop-preview"
        style={{ "--notes-drop-depth": plan.depth } as CSSProperties}
      />
    </li>
  );
}
