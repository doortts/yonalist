import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { OutlineDropPlan } from "./outlineDragPlan";
import { OutlineDragTail } from "./OutlineDragTail";

function rowForId(scope: HTMLElement, nodeId: string): HTMLElement | null {
  return [...scope.querySelectorAll<HTMLElement>("[data-outline-id]")]
    .find((candidate) => candidate.dataset.outlineId === nodeId)
    ?.closest<HTMLElement>(".notes-outline-item") ?? null;
}

export function OutlineDropPortal({
  plan,
  scope
}: {
  readonly plan: OutlineDropPlan;
  readonly scope: HTMLElement;
}) {
  if (plan.previewBeforeId !== null) {
    const row = rowForId(scope, plan.previewBeforeId);
    return row ? createPortal(
      <span
        className="notes-outline-drop-preview"
        aria-hidden="true"
        style={{ "--notes-drop-depth": plan.depth } as CSSProperties}
      />,
      row
    ) : null;
  }
  const list = scope.querySelector<HTMLOListElement>(".notes-outline-list");
  return list ? createPortal(<OutlineDragTail plan={plan} />, list) : null;
}
