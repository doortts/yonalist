import { Check } from "lucide-react";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { todoChildrenByParent } from "./outlineModel";

export interface TodoProgress {
  readonly completed: number;
  readonly total: number;
}

/**
 * A row counts every Todo hanging under it, not just its direct children, so
 * the bar answers "how much of this branch is left" rather than "how much of
 * this one level". Counting stops at the first non-Todo row: an ordinary
 * bullet ends the chain, and whatever it carries belongs to its own tally.
 *
 * A Todo nested under another Todo draws no bar of its own -- the topmost
 * Todo of a chain already reports the whole chain, and repeating it on every
 * level below just stacks the same number down the page.
 *
 * A single Todo under a row gets no bar either: its own checkbox already says
 * everything a 0/1 bar would, so the bar only appears once there is a
 * proportion to read.
 */
export function buildTodoProgressMap(
  nodes: readonly NoteView[]
): ReadonlyMap<string, TodoProgress> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const todoChildren = todoChildrenByParent(nodes);
  const branch = new Map<string, TodoProgress>();
  const measure = (id: string): TodoProgress => {
    const known = branch.get(id);
    if (known) return known;
    // Seeded before the walk so a parent cycle terminates instead of
    // recurring forever.
    branch.set(id, { completed: 0, total: 0 });
    let completed = 0;
    let total = 0;
    for (const child of todoChildren.get(id) ?? []) {
      const below = measure(child.id);
      completed += (child.completed ? 1 : 0) + below.completed;
      total += 1 + below.total;
    }
    const value = { completed, total };
    branch.set(id, value);
    return value;
  };
  const progress = new Map<string, TodoProgress>();
  for (const node of nodes) {
    if (node.deleted) continue;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (node.marker === "todo" && parent?.marker === "todo") continue;
    const value = measure(node.id);
    if (value.total > 1) progress.set(node.id, value);
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
        {complete ? value.total : `${value.completed}/${value.total}`}
      </span>
    </div>
  );
}
