import type { NotesTodoProgressValue } from "./notesTodoProgress";

interface NotesTodoProgressProps {
  readonly value: NotesTodoProgressValue | null;
  readonly className?: string;
}

export function NotesTodoProgress({ value, className }: NotesTodoProgressProps) {
  if (!value) return null;
  const complete = value.completed === value.total;
  const percent = (value.completed / value.total) * 100;
  return (
    <div
      className={["notes-todo-progress", className].filter(Boolean).join(" ")}
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
