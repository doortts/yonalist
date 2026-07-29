import {
  ArrowDown, ArrowUp, Check, Copy, IndentDecrease, IndentIncrease,
  CopyPlus, MoreHorizontal, Scissors, Trash2, X
} from "lucide-react";
import {
  type ReactNode, type RefObject,
  useEffect,
  useRef,
  useState
} from "react";

const COMPACT_ACTIONS_QUERY = "(max-width: 720px)";

function useCompactActions(
  target: RefObject<HTMLDivElement | null>
): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window.matchMedia === "function" &&
    window.matchMedia(COMPACT_ACTIONS_QUERY).matches
  );

  useEffect(() => {
    if (typeof ResizeObserver === "function" && target.current) {
      const observer = new ResizeObserver(([entry]) => {
        setCompact(entry.contentRect.width <= 720);
      });
      observer.observe(target.current);
      return () => observer.disconnect();
    }
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(COMPACT_ACTIONS_QUERY);
    const update = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [target]);

  return compact;
}

interface SelectionActionBarProps {
  readonly count: number;
  readonly allCompleted: boolean;
  readonly canCut: boolean;
  readonly canIndent: boolean;
  readonly canOutdent: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly canDuplicate: boolean;
  readonly busy: boolean;
  readonly onClear: () => void;
  readonly onComplete: () => void;
  readonly onCopy: () => void;
  readonly onCut: () => void;
  readonly onIndent: () => void;
  readonly onOutdent: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly trailingAction?: ReactNode;
}

export function SelectionActionBar({
  count,
  allCompleted,
  canCut,
  canIndent,
  canOutdent,
  canMoveUp,
  canMoveDown,
  canDuplicate,
  busy,
  onClear,
  onComplete,
  onCopy,
  onCut,
  onIndent,
  onOutdent,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onDelete,
  trailingAction
}: SelectionActionBarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const compact = useCompactActions(toolbarRef);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      if (!menuRootRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss, true);
    };
  }, [moreOpen]);
  const mutationDisabled = busy;
  const action = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    disabled = false,
    className = "",
    showLabel = false
  ) => (
    <button
      key={label}
      className={`notes-selection-action-button ${className}`.trim()}
      type="button"
      aria-label={label}
      aria-disabled={disabled}
      title={disabled ? "This action is unavailable for the current selection." : label}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {icon}
      <span className={showLabel ? undefined : "notes-selection-visually-hidden"}>
        {label}
      </span>
    </button>
  );
  const structuralActions = [
    {
      label: "Move up",
      icon: <ArrowUp size={16} aria-hidden="true" />,
      onClick: onMoveUp,
      disabled: mutationDisabled || !canMoveUp
    },
    {
      label: "Move down",
      icon: <ArrowDown size={16} aria-hidden="true" />,
      onClick: onMoveDown,
      disabled: mutationDisabled || !canMoveDown
    },
    {
      label: "Indent",
      icon: <IndentIncrease size={16} aria-hidden="true" />,
      onClick: onIndent,
      disabled: mutationDisabled || !canIndent
    },
    {
      label: "Outdent",
      icon: <IndentDecrease size={16} aria-hidden="true" />,
      onClick: onOutdent,
      disabled: mutationDisabled || !canOutdent
    },
    {
      label: "Duplicate",
      icon: <CopyPlus size={16} aria-hidden="true" />,
      onClick: onDuplicate,
      disabled: mutationDisabled || !canDuplicate
    }
  ] as const;
  const moreActions = [
    ...(compact ? structuralActions : []),
    {
      label: "Copy",
      icon: <Copy size={16} aria-hidden="true" />,
      onClick: onCopy,
      disabled: busy
    },
    {
      label: "Cut",
      icon: <Scissors size={16} aria-hidden="true" />,
      onClick: onCut,
      disabled: busy || !canCut
    }
  ] as const;

  return (
    <div
      ref={toolbarRef}
      className="notes-selection-action-bar"
      role="toolbar"
      aria-label={`Actions for ${count} selected notes`}
      aria-busy={busy}
    >
      {action(
        "Clear selection",
        <X size={16} aria-hidden="true" />,
        onClear
      )}
      <span className="notes-selection-count" aria-label={`${count} notes selected`}>
        {count} selected
      </span>
      {action(
        allCompleted ? "Uncomplete" : "Complete",
        <Check size={16} aria-hidden="true" />,
        onComplete,
        mutationDisabled,
        "",
        true
      )}
      {!compact && (
        <div className="notes-selection-wide-actions">
          {structuralActions.map((item) => action(
            item.label,
            item.icon,
            item.onClick,
            item.disabled,
            "notes-selection-action-wide"
          ))}
        </div>
      )}
      <div
        ref={menuRootRef}
        className="notes-selection-action-menu-root"
        onBlur={(event) => {
          if (!event.relatedTarget ||
              !event.currentTarget.contains(event.relatedTarget as Node)) {
            setMoreOpen(false);
          }
        }}
      >
        <button
          ref={moreTriggerRef}
          className="notes-selection-action-button"
          type="button"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title="More actions"
          onClick={() => setMoreOpen((current) => !current)}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
        {moreOpen && (
          <div
            ref={menuRef}
            className="notes-selection-action-menu"
            role="menu"
            aria-label="More selection actions"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setMoreOpen(false);
                moreTriggerRef.current?.focus();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                return;
              }
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]'
              )];
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowDown"
                    ? (current + 1) % items.length
                    : (current - 1 + items.length) % items.length;
              items[next]?.focus();
            }}
          >
            {moreActions.map((item) => (
              <button
                key={item.label}
                className="notes-selection-action-menu-item"
                type="button"
                role="menuitem"
                aria-disabled={item.disabled}
                title={item.disabled
                  ? "This action is unavailable for the current selection."
                  : item.label}
                onClick={() => {
                  if (item.disabled) return;
                  setMoreOpen(false);
                  item.onClick();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {action(
        "Delete",
        <Trash2 size={16} aria-hidden="true" />,
        onDelete,
        mutationDisabled,
        "notes-selection-action-danger"
      )}
      {trailingAction}
    </div>
  );
}
