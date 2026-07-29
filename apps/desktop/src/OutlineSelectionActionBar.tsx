import { SelectionActionBar } from "./SelectionActionBar";
import type {
  buildSelectionMovePlans,
  SelectionMovePlan
} from "./selectionMoves";
import type { ReactNode } from "react";

interface OutlineSelectionActionBarProps {
  readonly count: number;
  readonly allCompleted: boolean;
  readonly canCut: boolean;
  readonly busy: boolean;
  readonly plans: ReturnType<typeof buildSelectionMovePlans>;
  readonly onClear: () => void;
  readonly onComplete: () => void;
  readonly onCopy: () => void;
  readonly onCut: () => void;
  readonly onDelete: () => void;
  readonly onDuplicate: () => void;
  readonly onMove: (plan: SelectionMovePlan) => void;
  readonly trailingAction?: ReactNode;
}

export function OutlineSelectionActionBar({
  count,
  allCompleted,
  canCut,
  busy,
  plans,
  onClear,
  onComplete,
  onCopy,
  onCut,
  onDelete,
  onDuplicate,
  onMove,
  trailingAction
}: OutlineSelectionActionBarProps) {
  return (
    <SelectionActionBar
      count={count}
      allCompleted={allCompleted}
      canCut={canCut}
      canIndent={plans.indent.available}
      canOutdent={plans.outdent.available}
      canMoveUp={plans.up.available}
      canMoveDown={plans.down.available}
      canDuplicate={plans.duplicate.available}
      busy={busy}
      onClear={onClear}
      onComplete={onComplete}
      onCopy={onCopy}
      onCut={onCut}
      onIndent={() => onMove(plans.indent)}
      onOutdent={() => onMove(plans.outdent)}
      onMoveUp={() => onMove(plans.up)}
      onMoveDown={() => onMove(plans.down)}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      trailingAction={trailingAction}
    />
  );
}
