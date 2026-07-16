import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Copy,
  CopyPlus,
  FolderInput,
  IndentDecrease,
  IndentIncrease,
  MoreHorizontal,
  Scissors,
  Tags,
  Trash2,
  X
} from "lucide-react";
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type {
  NotesSelectionActionIntent,
  NotesSelectionActionSnapshot,
  NotesSelectionEligibility
} from "./notesSelectionActions";

const COMPACT_ACTIONS_WIDTH = 720;
const BUSY_REASON = "Another selection action is in progress.";

export type NotesSelectionActionBarAction = NotesSelectionActionIntent;

export interface NotesSelectionActionBarProps {
  readonly snapshot: NotesSelectionActionSnapshot;
  readonly busy?: boolean;
  /** A shared reason that disables mutation controls, for example Trash mode. */
  readonly mutationDisabledReason?: string | null;
  readonly status?: string | null;
  readonly error?: string | null;
  readonly onAction: (
    action: NotesSelectionActionBarAction
  ) => void | Promise<void>;
  readonly onClearSelection: () => void;
  readonly onReturnFocus: () => void;
}

type ToolbarItemKey = "clear" | NotesSelectionActionBarAction | "more";

interface ActionAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

interface ToolbarActionButtonProps {
  readonly actionKey: ToolbarItemKey;
  readonly activeKey: ToolbarItemKey;
  readonly availability: ActionAvailability;
  readonly className?: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly reasonId: string;
  readonly showLabel?: boolean;
  readonly onFocus: (key: ToolbarItemKey) => void;
  readonly onPress: () => void;
}

function useCompactActions(
  toolbarRef: RefObject<HTMLDivElement | null>
): boolean {
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return;
    }
    const publish = (width: number) => {
      if (width > 0) {
        setCompact(width <= COMPACT_ACTIONS_WIDTH);
      }
    };
    publish(toolbar.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      publish(entry.contentRect.width);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [toolbarRef]);

  return compact;
}

function ToolbarActionButton({
  actionKey,
  activeKey,
  availability,
  className,
  icon,
  label,
  reasonId,
  showLabel = false,
  onFocus,
  onPress
}: ToolbarActionButtonProps) {
  return (
    <button
      type="button"
      className={["notes-selection-action-button", className]
        .filter(Boolean)
        .join(" ")}
      data-notes-selection-toolbar-item="true"
      data-action-key={actionKey}
      aria-label={label}
      aria-disabled={!availability.available}
      aria-describedby={availability.reason ? reasonId : undefined}
      title={availability.reason ?? label}
      tabIndex={activeKey === actionKey ? 0 : -1}
      onFocus={() => onFocus(actionKey)}
      onClick={onPress}
    >
      {icon}
      <span className={showLabel ? undefined : "notes-selection-visually-hidden"}>
        {label}
      </span>
    </button>
  );
}

function fromEligibility(
  eligibility: NotesSelectionEligibility
): ActionAvailability {
  return eligibility.eligible
    ? { available: true, reason: null }
    : { available: false, reason: eligibility.reason };
}

function disabledBy(
  reason: string | null | undefined
): ActionAvailability {
  return reason
    ? { available: false, reason }
    : { available: true, reason: null };
}

function combineAvailability(
  ...values: readonly ActionAvailability[]
): ActionAvailability {
  return values.find((value) => !value.available) ?? {
    available: true,
    reason: null
  };
}

interface MoreAction {
  readonly action: NotesSelectionActionBarAction;
  readonly label: string;
  readonly icon: ReactNode;
  readonly availability: ActionAvailability;
}

/**
 * Presentation-only toolbar for a prepared selection snapshot. Selection
 * algebra and mutations stay in the snapshot model and semantic router.
 */
export const NotesSelectionActionBar = forwardRef<
  HTMLDivElement,
  NotesSelectionActionBarProps
>(function NotesSelectionActionBar(
  {
    snapshot,
    busy = false,
    mutationDisabledReason = null,
    status = null,
    error = null,
    onAction,
    onClearSelection,
    onReturnFocus
  },
  forwardedRef
) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const compact = useCompactActions(toolbarRef);
  const [rovingKey, setRovingKey] = useState<ToolbarItemKey>("clear");
  const [locallyBusy, setLocallyBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreActiveIndex, setMoreActiveIndex] = useState(0);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const submissionRef = useRef(false);
  const reasonBaseId = useId();
  const moreMenuId = useId();
  const commandBusy = busy || locallyBusy;
  const busyAvailability = disabledBy(commandBusy ? BUSY_REASON : null);
  const mutationAvailability = disabledBy(mutationDisabledReason);
  const alwaysAvailable = disabledBy(null);

  const availability: Record<NotesSelectionActionBarAction, ActionAvailability> = {
    toggleComplete: combineAvailability(
      busyAvailability,
      mutationAvailability
    ),
    moveTo: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.moveTo)
    ),
    moveUp: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.moveUp)
    ),
    moveDown: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.moveDown)
    ),
    indent: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.indent)
    ),
    outdent: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.outdent)
    ),
    duplicate: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.duplicate)
    ),
    tags: combineAvailability(busyAvailability, mutationAvailability),
    copy: combineAvailability(
      busyAvailability,
      fromEligibility(snapshot.eligibility.copy)
    ),
    cut: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.cut)
    ),
    delete: combineAvailability(
      busyAvailability,
      mutationAvailability,
      fromEligibility(snapshot.eligibility.delete)
    )
  };

  const completeLabel =
    snapshot.completion === "all" ? "Uncomplete" : "Complete";
  const wideKeys: readonly ToolbarItemKey[] = compact
    ? []
    : ["moveUp", "moveDown", "indent", "outdent", "duplicate"];
  const toolbarKeys: readonly ToolbarItemKey[] = [
    "clear",
    "toggleComplete",
    "moveTo",
    ...wideKeys,
    "tags",
    "more",
    "delete"
  ];
  const activeKey = toolbarKeys.includes(rovingKey) ? rovingKey : "clear";

  useEffect(() => {
    if (!moreOpen) {
      return;
    }
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [moreOpen]);

  useLayoutEffect(() => {
    if (moreOpen) {
      moreRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    }
  }, [moreOpen]);

  const setRootRef = (element: HTMLDivElement | null) => {
    toolbarRef.current = element;
    if (typeof forwardedRef === "function") {
      forwardedRef(element);
    } else if (forwardedRef) {
      forwardedRef.current = element;
    }
  };

  const invoke = (action: NotesSelectionActionBarAction) => {
    if (!availability[action].available || submissionRef.current) {
      return;
    }
    submissionRef.current = true;
    setLocallyBusy(true);
    void (async () => {
      try {
        await onAction(action);
      } catch {
        // The semantic router owns user-facing errors in the shared region.
      } finally {
        submissionRef.current = false;
        setLocallyBusy(false);
      }
    })();
  };

  const handleToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClearSelection();
      onReturnFocus();
      return;
    }
    if (event.key === "F6" && event.shiftKey) {
      event.preventDefault();
      onReturnFocus();
      return;
    }
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const items = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[data-notes-selection-toolbar-item="true"]'
      ) ?? []
    );
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "ArrowRight") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    }
    items[nextIndex]?.focus();
  };

  const structuralMoreActions: readonly MoreAction[] = [
    {
      action: "moveUp",
      label: "Move up",
      icon: <ArrowUp size={15} aria-hidden="true" />,
      availability: availability.moveUp
    },
    {
      action: "moveDown",
      label: "Move down",
      icon: <ArrowDown size={15} aria-hidden="true" />,
      availability: availability.moveDown
    },
    {
      action: "indent",
      label: "Indent",
      icon: <IndentIncrease size={15} aria-hidden="true" />,
      availability: availability.indent
    },
    {
      action: "outdent",
      label: "Outdent",
      icon: <IndentDecrease size={15} aria-hidden="true" />,
      availability: availability.outdent
    },
    {
      action: "duplicate",
      label: "Duplicate",
      icon: <CopyPlus size={15} aria-hidden="true" />,
      availability: availability.duplicate
    }
  ];
  const moreActions: readonly MoreAction[] = [
    ...(compact ? structuralMoreActions : []),
    {
      action: "copy",
      label: "Copy",
      icon: <Copy size={15} aria-hidden="true" />,
      availability: availability.copy
    },
    {
      action: "cut",
      label: "Cut",
      icon: <Scissors size={15} aria-hidden="true" />,
      availability: availability.cut
    }
  ];
  const visibleMoreActiveIndex =
    moreActiveIndex >= 0 && moreActiveIndex < moreActions.length
      ? moreActiveIndex
      : 0;

  return (
    <div className="notes-selection-action-region">
      <div
        ref={setRootRef}
        className="notes-selection-action-bar"
        role="toolbar"
        aria-label={`Actions for ${snapshot.selectedNodeIds.length} selected notes`}
        aria-busy={commandBusy}
        data-compact={compact ? "true" : "false"}
        tabIndex={-1}
        onFocus={(event) => {
          if (event.currentTarget === event.target) {
            event.currentTarget
              .querySelector<HTMLButtonElement>(
                `button[data-action-key="${activeKey}"]`
              )
              ?.focus();
          }
        }}
        onKeyDown={handleToolbarKeyDown}
      >
        <span
          className="notes-selection-count"
          aria-label={`${snapshot.selectedNodeIds.length} notes selected`}
        >
          {snapshot.selectedNodeIds.length} selected
        </span>

        <ToolbarActionButton
          actionKey="clear"
          activeKey={activeKey}
          availability={alwaysAvailable}
          icon={<X size={16} aria-hidden="true" />}
          label="Clear selection"
          reasonId={`${reasonBaseId}-clear`}
          onFocus={setRovingKey}
          onPress={() => {
            onClearSelection();
            onReturnFocus();
          }}
        />

        <ToolbarActionButton
          actionKey="toggleComplete"
          activeKey={activeKey}
          availability={availability.toggleComplete}
          icon={<Check size={16} aria-hidden="true" />}
          label={completeLabel}
          reasonId={`${reasonBaseId}-toggleComplete`}
          showLabel
          onFocus={setRovingKey}
          onPress={() => invoke("toggleComplete")}
        />
        <ToolbarActionButton
          actionKey="moveTo"
          activeKey={activeKey}
          availability={availability.moveTo}
          icon={<FolderInput size={16} aria-hidden="true" />}
          label="Move To"
          reasonId={`${reasonBaseId}-moveTo`}
          showLabel
          onFocus={setRovingKey}
          onPress={() => invoke("moveTo")}
        />

        {!compact && (
          <div className="notes-selection-wide-actions">
            <ToolbarActionButton
              actionKey="moveUp"
              activeKey={activeKey}
              availability={availability.moveUp}
              className="notes-selection-action-wide"
              icon={<ArrowUp size={16} aria-hidden="true" />}
              label="Move up"
              reasonId={`${reasonBaseId}-moveUp`}
              onFocus={setRovingKey}
              onPress={() => invoke("moveUp")}
            />
            <ToolbarActionButton
              actionKey="moveDown"
              activeKey={activeKey}
              availability={availability.moveDown}
              className="notes-selection-action-wide"
              icon={<ArrowDown size={16} aria-hidden="true" />}
              label="Move down"
              reasonId={`${reasonBaseId}-moveDown`}
              onFocus={setRovingKey}
              onPress={() => invoke("moveDown")}
            />
            <ToolbarActionButton
              actionKey="indent"
              activeKey={activeKey}
              availability={availability.indent}
              className="notes-selection-action-wide"
              icon={<IndentIncrease size={16} aria-hidden="true" />}
              label="Indent"
              reasonId={`${reasonBaseId}-indent`}
              onFocus={setRovingKey}
              onPress={() => invoke("indent")}
            />
            <ToolbarActionButton
              actionKey="outdent"
              activeKey={activeKey}
              availability={availability.outdent}
              className="notes-selection-action-wide"
              icon={<IndentDecrease size={16} aria-hidden="true" />}
              label="Outdent"
              reasonId={`${reasonBaseId}-outdent`}
              onFocus={setRovingKey}
              onPress={() => invoke("outdent")}
            />
            <ToolbarActionButton
              actionKey="duplicate"
              activeKey={activeKey}
              availability={availability.duplicate}
              className="notes-selection-action-wide"
              icon={<CopyPlus size={16} aria-hidden="true" />}
              label="Duplicate"
              reasonId={`${reasonBaseId}-duplicate`}
              onFocus={setRovingKey}
              onPress={() => invoke("duplicate")}
            />
          </div>
        )}

        <ToolbarActionButton
          actionKey="tags"
          activeKey={activeKey}
          availability={availability.tags}
          icon={<Tags size={16} aria-hidden="true" />}
          label="Tags"
          reasonId={`${reasonBaseId}-tags`}
          showLabel
          onFocus={setRovingKey}
          onPress={() => invoke("tags")}
        />

        <div
          ref={moreRef}
          className="notes-selection-action-menu-root"
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              moreOpen &&
              (!nextTarget || !event.currentTarget.contains(nextTarget as Node))
            ) {
              setMoreOpen(false);
            }
          }}
        >
          <button
            ref={moreTriggerRef}
            className="notes-selection-action-button"
            type="button"
            data-notes-selection-toolbar-item="true"
            data-action-key="more"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? moreMenuId : undefined}
            title="More actions"
            tabIndex={activeKey === "more" ? 0 : -1}
            onFocus={() => setRovingKey("more")}
            onClick={() => {
              if (!moreOpen) {
                setMoreActiveIndex(0);
              }
              setMoreOpen((current) => !current);
            }}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          {moreOpen && (
            <div
              id={moreMenuId}
              className="notes-selection-action-menu"
              role="menu"
              aria-label="More selection actions"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "F6" && event.shiftKey) {
                  event.preventDefault();
                  setMoreOpen(false);
                  onReturnFocus();
                  return;
                }
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]'
                  )
                );
                const currentIndex = items.indexOf(
                  document.activeElement as HTMLButtonElement
                );
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMoreOpen(false);
                  moreTriggerRef.current?.focus();
                } else if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  event.key === "Home" ||
                  event.key === "End"
                ) {
                  event.preventDefault();
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : event.key === "ArrowDown"
                          ? (currentIndex + 1) % items.length
                          : currentIndex <= 0
                            ? items.length - 1
                            : currentIndex - 1;
                  setMoreActiveIndex(nextIndex);
                  items[nextIndex]?.focus();
                }
              }}
            >
              {moreActions.map((item, index) => {
                const reasonId = `${reasonBaseId}-${item.action}`;
                return (
                  <button
                    key={item.action}
                    type="button"
                    role="menuitem"
                    className="notes-selection-action-menu-item"
                    aria-disabled={!item.availability.available}
                    aria-describedby={
                      item.availability.reason ? reasonId : undefined
                    }
                    title={item.availability.reason ?? item.label}
                    tabIndex={index === visibleMoreActiveIndex ? 0 : -1}
                    onFocus={() => setMoreActiveIndex(index)}
                    onClick={() => {
                      if (!item.availability.available) {
                        return;
                      }
                      setMoreOpen(false);
                      moreTriggerRef.current?.focus();
                      invoke(item.action);
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <ToolbarActionButton
          actionKey="delete"
          activeKey={activeKey}
          availability={availability.delete}
          className="notes-selection-action-danger"
          icon={<Trash2 size={16} aria-hidden="true" />}
          label="Delete"
          reasonId={`${reasonBaseId}-delete`}
          onFocus={setRovingKey}
          onPress={() => invoke("delete")}
        />

        {Object.entries(availability).map(([action, value]) =>
          value.reason ? (
            <span
              key={action}
              id={`${reasonBaseId}-${action}`}
              className="notes-selection-visually-hidden"
            >
              {value.reason}
            </span>
          ) : null
        )}
      </div>

      <span
        className="notes-selection-action-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-kind={error ? "error" : status ? "status" : undefined}
      >
        {error ? (
          <AlertCircle size={15} aria-hidden="true" />
        ) : status ? (
          <CheckCircle2 size={15} aria-hidden="true" />
        ) : null}
        <span>{error ?? status ?? ""}</span>
      </span>
    </div>
  );
});
