import { Check } from "lucide-react";

interface NotesTodoCheckboxProps {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly className?: string;
  readonly onToggle: () => void;
}

export function NotesTodoCheckbox({
  checked,
  disabled = false,
  label,
  className,
  onToggle
}: NotesTodoCheckboxProps) {
  return (
    <button
      className={["notes-todo-checkbox", className].filter(Boolean).join(" ")}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
    >
      {checked ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : null}
    </button>
  );
}
