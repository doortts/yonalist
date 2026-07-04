import { labelTextColor, type GitHubLabel } from "../domain/conversation";

interface LabelChipProps {
  label: GitHubLabel;
}

/** A GitHub label pill painted with the label's own color. */
export function LabelChip({ label }: LabelChipProps) {
  if (!label.color) {
    return <span className="chip">{label.name}</span>;
  }
  const background = `#${label.color}`;
  return (
    <span
      className="chip label-chip"
      style={{
        backgroundColor: background,
        color: labelTextColor(label.color),
        borderColor: background
      }}
    >
      {label.name}
    </span>
  );
}
