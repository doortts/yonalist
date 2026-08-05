import { Check } from "lucide-react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export interface TodoProgress {
  readonly completed: number;
  readonly total: number;
}

export function buildTodoProgressMap(
  nodes: readonly NoteView[]
): ReadonlyMap<string, TodoProgress> {
  const progress = new Map<string, TodoProgress>();
  for (const node of nodes) {
    if (node.marker !== "todo" || !node.parentId || node.deleted) continue;
    const current = progress.get(node.parentId) ?? { completed: 0, total: 0 };
    progress.set(node.parentId, {
      completed: current.completed + (node.completed ? 1 : 0),
      total: current.total + 1
    });
  }
  return progress;
}

export function TodoCheckbox({
  checked, label, onToggle
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      className="notes-todo-checkbox"
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
    >
      {checked ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : null}
    </button>
  );
}

export function TodoProgressIndicator({
  value
}: {
  readonly value: TodoProgress | null;
}) {
  if (!value) return null;
  const complete = value.completed === value.total;
  const percent = (value.completed / value.total) * 100;
  return (
    <div
      className="notes-todo-progress notes-node-todo-progress"
      data-complete={complete ? "true" : undefined}
      role="progressbar"
      aria-label={`${value.completed} of ${value.total} To-dos complete`}
      aria-valuemin={0}
      aria-valuemax={value.total}
      aria-valuenow={value.completed}
    >
      <span className="notes-todo-progress-track" aria-hidden="true">
        <span
          className="notes-todo-progress-fill"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="notes-todo-progress-count">
        ({value.completed}/{value.total})
      </span>
    </div>
  );
}
