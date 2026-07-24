import { Menu } from "@base-ui/react/menu";
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUp,
  ArrowUpZA,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock3,
  Copy,
  CopyPlus,
  Download,
  FileDown,
  FileText,
  FolderInput,
  ImageUp,
  IndentDecrease,
  IndentIncrease,
  MessageSquareOff,
  MessageSquareText,
  MoreHorizontal,
  Lock,
  LockOpen,
  RotateCcw,
  Scissors,
  Search,
  Circle,
  SquareCheckBig,
  Star,
  Tags,
  Trash2
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NotesExportFormat } from "../../domain/notesExport";
import type { NoteMarkerKind } from "../../domain/notes";
import type { NotesMoveDestination } from "./notesMoveTargets";
import { detectOutlineShortcutPlatform } from "./outlineKeyboard";
import type {
  NotesSelectionActionIntent,
  NotesSelectionActionSnapshot,
  NotesSelectionEligibility
} from "./notesSelectionActions";

export {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  type NotesMoveDestination
} from "./notesMoveTargets";

const EMPTY_EXPORT_SNAPSHOT = Object.freeze({
  busy: false,
  unavailable: false,
});
const NOOP_EXPORT_SUBSCRIBE = (_listener: () => void) => () => undefined;
const getEmptyExportSnapshot = () => EMPTY_EXPORT_SNAPSHOT;

export interface NotesBulletMenuProps {
  mode?: "standard" | "archive" | "trash" | "provider";
  label: string;
  completed?: boolean;
  markerKind?: NoteMarkerKind;
  starred?: boolean;
  isReadonly?: boolean;
  hasNote?: boolean;
  saveFailed?: boolean;
  disabled?: boolean;
  exportDisabled?: boolean;
  subscribeExportState?(listener: () => void): () => void;
  getExportSnapshot?(): {
    readonly busy: boolean;
    readonly unavailable: boolean;
  };
  actionBusy?: boolean;
  createdAt?: string;
  updatedAt?: string;
  formatTimestamp?(value: string): string;
  moveDestinations?: readonly NotesMoveDestination[];
  getMoveDestinations?():
    readonly NotesMoveDestination[] | Promise<readonly NotesMoveDestination[]>;
  onToggleComplete?(): void;
  onChangeMarkerKind?(markerKind: NoteMarkerKind): void;
  onToggleStar?(): void;
  onToggleReadonly?(): void;
  onOpenNote?(): void;
  onAddDate?(): void;
  onUploadImage?(): void;
  onMoveTo?(
    destinationId: string | null
  ): void | NotesMoveCommitOutcome | Promise<void | NotesMoveCommitOutcome>;
  onExpandAll?(): void;
  onCollapseAll?(): void;
  onSortAscending?(): void;
  onSortDescending?(): void;
  onRemoveNote?(): void;
  onDuplicate?(): void;
  onExport?(format: NotesExportFormat): void;
  onDelete?(): void;
  onRetrySave?(): void;
  onRestore?(): void;
  onUnarchive?(): void;
  onOpenChange?(open: boolean): void;
  selectionBridge?: NotesBulletMenuSelectionBridge;
}

export interface NotesBulletMenuSelectionState {
  readonly snapshot: NotesSelectionActionSnapshot;
  readonly busy?: boolean;
  readonly mutationDisabledReason?: string | null;
}

export interface NotesBulletMenuSelectionBridge {
  /**
   * Keep this bridge object stable across selection-state changes. The snapshot
   * itself must be cached between reads and replaced before subscribers run.
   */
  readonly getSnapshot: () => NotesBulletMenuSelectionState;
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly execute: (
    action: NotesSelectionActionIntent
  ) => void | Promise<unknown>;
  readonly requestChooser: (chooser: "move" | "tags") => void;
}

export type NotesMoveCommitOutcome =
  { ok: true } | { ok: false; error: string };

interface MenuShortcut {
  readonly visible: string;
  readonly aria: string;
}

interface NotesBulletMenuShortcuts {
  readonly toggleComplete: MenuShortcut;
  readonly focusNote: MenuShortcut;
  readonly duplicate: MenuShortcut;
  readonly delete: MenuShortcut;
  readonly moveUp: MenuShortcut;
  readonly moveDown: MenuShortcut;
  readonly indent: MenuShortcut;
  readonly outdent: MenuShortcut;
  readonly copy: MenuShortcut;
  readonly cut: MenuShortcut;
}

function buildNotesBulletMenuShortcuts(): NotesBulletMenuShortcuts {
  const isMac = detectOutlineShortcutPlatform() === "mac";
  return {
    toggleComplete: {
      visible: isMac ? "⌘↵" : "Ctrl+Enter",
      aria: isMac ? "Meta+Enter" : "Control+Enter"
    },
    focusNote: { visible: isMac ? "⇧↵" : "Shift+Enter", aria: "Shift+Enter" },
    duplicate: {
      visible: isMac ? "⌘⇧D" : "Alt+Shift+D",
      aria: isMac ? "Meta+Shift+D" : "Alt+Shift+D"
    },
    delete: {
      visible: isMac ? "⌘⇧⌫" : "Ctrl+Shift+Backspace",
      aria: isMac ? "Meta+Shift+Backspace" : "Control+Shift+Backspace"
    },
    moveUp: {
      visible: isMac ? "⌃⇧↑ / ⌘⇧↑" : "Alt+Shift+ArrowUp",
      aria: isMac
        ? "Control+Shift+ArrowUp Meta+Shift+ArrowUp"
        : "Alt+Shift+ArrowUp"
    },
    moveDown: {
      visible: isMac ? "⌃⇧↓ / ⌘⇧↓" : "Alt+Shift+ArrowDown",
      aria: isMac
        ? "Control+Shift+ArrowDown Meta+Shift+ArrowDown"
        : "Alt+Shift+ArrowDown"
    },
    indent: { visible: "Tab", aria: "Tab" },
    outdent: { visible: isMac ? "⇧Tab" : "Shift+Tab", aria: "Shift+Tab" },
    copy: {
      visible: isMac ? "⌘C" : "Ctrl+C",
      aria: isMac ? "Meta+C" : "Control+C",
    },
    cut: {
      visible: isMac ? "⌘X" : "Ctrl+X",
      aria: isMac ? "Meta+X" : "Control+X",
    },
  };
}

export function formatNotesTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

interface CommandItemProps {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  icon: ReactNode;
  closeOnClick?: boolean;
  itemRef?: Ref<HTMLElement>;
  onClick?(): void;
  shortcut?: MenuShortcut;
}

function CommandItem({
  children,
  danger = false,
  disabled = false,
  disabledReason = null,
  icon,
  closeOnClick = true,
  itemRef,
  onClick,
  shortcut
}: CommandItemProps) {
  const disabledReasonId = useId();

  return (
    <>
      <Menu.Item
        ref={itemRef}
        className="notes-bullet-menu-item"
        data-danger={danger ? "true" : undefined}
        disabled={disabled}
        aria-describedby={disabledReason ? disabledReasonId : undefined}
        aria-keyshortcuts={shortcut?.aria}
        title={disabledReason ?? undefined}
        closeOnClick={closeOnClick}
        onClick={onClick}
      >
        {icon}
        <span>{children}</span>
        {shortcut && (
          <span className="notes-bullet-menu-shortcut" aria-hidden="true">
            {shortcut.visible}
          </span>
        )}
      </Menu.Item>
      {disabledReason && (
        <span id={disabledReasonId} className="notes-selection-visually-hidden">
          {disabledReason}
        </span>
      )}
    </>
  );
}

interface SelectionActionAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

const SELECTION_BUSY_REASON = "Another selection action is in progress.";
const NO_SELECTION_STATE = null;
const getNoSelectionState = () => NO_SELECTION_STATE;
const subscribeNoSelection = () => () => undefined;

function selectionEligibilityAvailability(
  eligibility: NotesSelectionEligibility
): SelectionActionAvailability {
  return eligibility.eligible
    ? { available: true, reason: null }
    : { available: false, reason: eligibility.reason };
}

function selectionDisabledBy(
  reason: string | null | undefined
): SelectionActionAvailability {
  return reason
    ? { available: false, reason }
    : { available: true, reason: null };
}

function combineSelectionAvailability(
  ...values: readonly SelectionActionAvailability[]
): SelectionActionAvailability {
  return (
    values.find((value) => !value.available) ?? {
    available: true,
    reason: null
    }
  );
}

export function NotesBulletMenu({
  mode = "standard",
  label,
  completed = false,
  markerKind = "bullet",
  starred = false,
  isReadonly = false,
  hasNote = false,
  saveFailed = false,
  disabled = false,
  exportDisabled = false,
  subscribeExportState,
  getExportSnapshot,
  actionBusy = false,
  createdAt,
  updatedAt,
  formatTimestamp = formatNotesTimestamp,
  moveDestinations = [],
  getMoveDestinations,
  onToggleComplete,
  onChangeMarkerKind,
  onToggleStar,
  onToggleReadonly,
  onOpenNote,
  onAddDate,
  onUploadImage,
  onMoveTo,
  onExpandAll,
  onCollapseAll,
  onSortAscending,
  onSortDescending,
  onRemoveNote,
  onDuplicate,
  onExport,
  onDelete,
  onRetrySave,
  onRestore,
  onUnarchive,
  onOpenChange,
  selectionBridge
}: NotesBulletMenuProps) {
  const [open, setOpen] = useState(false);
  const [exportView, setExportView] = useState(false);
  const exportSnapshot = useSyncExternalStore(
    open && subscribeExportState ? subscribeExportState : NOOP_EXPORT_SUBSCRIBE,
    open && getExportSnapshot ? getExportSnapshot : getEmptyExportSnapshot,
    open && getExportSnapshot ? getExportSnapshot : getEmptyExportSnapshot,
  );
  const resolvedExportDisabled = subscribeExportState
    ? exportSnapshot.unavailable || exportSnapshot.busy
    : exportDisabled;
  const shortcuts = useMemo(buildNotesBulletMenuShortcuts, []);
  const [moveView, setMoveView] = useState(false);
  const [moveQuery, setMoveQuery] = useState("");
  const [moveSelection, setMoveSelection] = useState(-1);
  const [availableMoveDestinations, setAvailableMoveDestinations] = useState<
    readonly NotesMoveDestination[]
  >([]);
  const [moveDestinationsLoading, setMoveDestinationsLoading] = useState(false);
  const [moveCommitPending, setMoveCommitPending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const exportBackRef = useRef<HTMLElement>(null);
  const exportCommandRef = useRef<HTMLElement>(null);
  const moveCommandRef = useRef<HTMLElement>(null);
  const moveSearchRef = useRef<HTMLInputElement>(null);
  const viewFocusTargetRef = useRef<"back" | "export" | null>(null);
  const handoffPendingRef = useRef<
    "note" | "date" | "selection-move" | "selection-tags" | null
  >(null);
  const selectionSubmissionRef = useRef(false);
  const moveRequestRef = useRef(0);
  const moveListboxId = useId();
  const normalizedMoveQuery = moveQuery.trim().toLocaleLowerCase();
  const filteredMoveDestinations = useMemo(
    () =>
      availableMoveDestinations.filter((destination) =>
        destination.label.toLocaleLowerCase().includes(normalizedMoveQuery)
      ),
    [availableMoveDestinations, normalizedMoveQuery]
  );
  const selectionState = useSyncExternalStore(
    selectionBridge?.subscribe ?? subscribeNoSelection,
    selectionBridge?.getSnapshot ?? getNoSelectionState,
    selectionBridge?.getSnapshot ?? getNoSelectionState
  );
  const showsShortcutHints =
    Boolean(selectionState) ||
    (mode === "standard" && !moveView && !exportView);
  const selectionBusyAvailability = selectionDisabledBy(
    selectionState?.busy || actionBusy ? SELECTION_BUSY_REASON : null
  );
  const selectionMutationAvailability = selectionDisabledBy(
    selectionState?.mutationDisabledReason
  );
  const selectionAvailability: Record<
    NotesSelectionActionIntent,
    SelectionActionAvailability
  > | null = selectionState
    ? {
        toggleComplete: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability
        ),
        moveTo: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.moveTo
          )
        ),
        moveUp: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.moveUp
          )
        ),
        moveDown: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.moveDown
          )
        ),
        indent: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.indent
          )
        ),
        outdent: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.outdent
          )
        ),
        duplicate: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.duplicate
          )
        ),
        tags: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability
        ),
        copy: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.copy
          )
        ),
        cut: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.cut
          )
        ),
        delete: combineSelectionAvailability(
          selectionBusyAvailability,
          selectionMutationAvailability,
          selectionEligibilityAvailability(
            selectionState.snapshot.eligibility.delete
          )
        )
      }
    : null;

  const invokeSelectionAction = (action: NotesSelectionActionIntent) => {
    if (
      !selectionAvailability?.[action].available ||
      selectionSubmissionRef.current ||
      !selectionBridge
    ) {
      return;
    }
    selectionSubmissionRef.current = true;
    void (async () => {
      try {
        await selectionBridge.execute(action);
      } catch {
        // The shared semantic router owns user-facing selection errors.
      } finally {
        selectionSubmissionRef.current = false;
      }
    })();
  };

  const handoffSelectionChooser = (chooser: "move" | "tags") => {
    const action = chooser === "move" ? "moveTo" : "tags";
    if (
      !selectionAvailability?.[action].available ||
      selectionSubmissionRef.current
    ) {
      return;
    }
    selectionSubmissionRef.current = true;
    handoffPendingRef.current =
      chooser === "move" ? "selection-move" : "selection-tags";
  };

  useLayoutEffect(() => {
    if (viewFocusTargetRef.current === "back" && exportView) {
      viewFocusTargetRef.current = null;
      exportBackRef.current?.focus();
    } else if (viewFocusTargetRef.current === "export" && !exportView) {
      viewFocusTargetRef.current = null;
      exportCommandRef.current?.focus();
    }
  }, [exportView]);

  useLayoutEffect(() => {
    if (moveView) {
      moveSearchRef.current?.focus();
    }
  }, [moveView]);

  const closeMoveView = () => {
    setMoveView(false);
    setMoveQuery("");
    setMoveSelection(-1);
    requestAnimationFrame(() => moveCommandRef.current?.focus());
  };

  const chooseMoveDestination = async (destinationId: string | null) => {
    if (actionBusy || moveCommitPending) {
      return;
    }
    setMoveCommitPending(true);
    setMoveError(null);
    try {
      const outcome = await onMoveTo?.(destinationId);
      if (outcome && !outcome.ok) {
        setMoveError(outcome.error);
        moveSearchRef.current?.focus();
        return;
      }
      setOpen(false);
    } catch {
      setMoveError("Move failed. Refresh Move To and try again.");
      moveSearchRef.current?.focus();
    } finally {
      setMoveCommitPending(false);
    }
  };

  const handleMoveSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setMoveQuery(event.currentTarget.value);
    setMoveSelection(-1);
    setMoveError(null);
  };

  const handleMoveSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeMoveView();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredMoveDestinations.length === 0) {
        return;
      }
      setMoveSelection((current) => {
        if (event.key === "ArrowDown") {
          return current < filteredMoveDestinations.length - 1
            ? current + 1
            : 0;
        }
        return current > 0 ? current - 1 : filteredMoveDestinations.length - 1;
      });
      return;
    }
    if (event.key === "Enter" && moveSelection >= 0) {
      event.preventDefault();
      const destination = filteredMoveDestinations[moveSelection];
      if (destination) {
        void chooseMoveDestination(destination.id);
      }
    }
  };

  return (
    <Menu.Root
      disabled={disabled}
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setExportView(false);
          setMoveView(false);
          setMoveQuery("");
          setMoveSelection(-1);
          setAvailableMoveDestinations([]);
          setMoveDestinationsLoading(false);
          setMoveCommitPending(false);
          setMoveError(null);
          moveRequestRef.current += 1;
        }
        onOpenChange?.(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen && handoffPendingRef.current) {
          const handoff = handoffPendingRef.current;
          handoffPendingRef.current = null;
          if (handoff === "note") {
            onOpenNote?.();
          } else if (handoff === "date") {
            onAddDate?.();
          } else {
            selectionSubmissionRef.current = false;
            selectionBridge?.requestChooser(
              handoff === "selection-move" ? "move" : "tags"
            );
          }
        }
      }}
    >
      <IconTooltip label="More actions">
        <Menu.Trigger
          className="notes-bullet-menu-trigger"
          type="button"
          aria-label={`More actions for ${label}`}
          disabled={disabled}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </Menu.Trigger>
      </IconTooltip>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4}>
          <Menu.Popup
            className="notes-bullet-menu"
            data-shortcut-hints={showsShortcutHints ? "true" : undefined}
            finalFocus={handoffPendingRef.current ? false : undefined}
          >
            {mode === "provider" ? (
              <CommandItem
                disabled={actionBusy || completed || !onToggleComplete}
                icon={<Check size={15} aria-hidden="true" />}
                onClick={onToggleComplete}
                shortcut={shortcuts.toggleComplete}
              >
                Complete
              </CommandItem>
            ) : selectionState && selectionAvailability ? (
              <>
                <CommandItem
                  disabled={!selectionAvailability.toggleComplete.available}
                  disabledReason={selectionAvailability.toggleComplete.reason}
                  icon={<Check size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("toggleComplete")}
                  shortcut={shortcuts.toggleComplete}
                >
                  {selectionState.snapshot.completion === "all"
                    ? "Uncomplete"
                    : "Complete"}
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.moveTo.available}
                  disabledReason={selectionAvailability.moveTo.reason}
                  icon={<FolderInput size={15} aria-hidden="true" />}
                  onClick={() => handoffSelectionChooser("move")}
                >
                  Move To
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.moveUp.available}
                  disabledReason={selectionAvailability.moveUp.reason}
                  icon={<ArrowUp size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("moveUp")}
                  shortcut={shortcuts.moveUp}
                >
                  Move up
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.moveDown.available}
                  disabledReason={selectionAvailability.moveDown.reason}
                  icon={<ArrowDown size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("moveDown")}
                  shortcut={shortcuts.moveDown}
                >
                  Move down
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.indent.available}
                  disabledReason={selectionAvailability.indent.reason}
                  icon={<IndentIncrease size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("indent")}
                  shortcut={shortcuts.indent}
                >
                  Indent
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.outdent.available}
                  disabledReason={selectionAvailability.outdent.reason}
                  icon={<IndentDecrease size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("outdent")}
                  shortcut={shortcuts.outdent}
                >
                  Outdent
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.duplicate.available}
                  disabledReason={selectionAvailability.duplicate.reason}
                  icon={<CopyPlus size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("duplicate")}
                  shortcut={shortcuts.duplicate}
                >
                  Duplicate
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.tags.available}
                  disabledReason={selectionAvailability.tags.reason}
                  icon={<Tags size={15} aria-hidden="true" />}
                  onClick={() => handoffSelectionChooser("tags")}
                >
                  Tags
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.copy.available}
                  disabledReason={selectionAvailability.copy.reason}
                  icon={<Copy size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("copy")}
                  shortcut={shortcuts.copy}
                >
                  Copy
                </CommandItem>
                <CommandItem
                  disabled={!selectionAvailability.cut.available}
                  disabledReason={selectionAvailability.cut.reason}
                  icon={<Scissors size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("cut")}
                  shortcut={shortcuts.cut}
                >
                  Cut
                </CommandItem>
                <CommandItem
                  danger
                  disabled={!selectionAvailability.delete.available}
                  disabledReason={selectionAvailability.delete.reason}
                  icon={<Trash2 size={15} aria-hidden="true" />}
                  onClick={() => invokeSelectionAction("delete")}
                  shortcut={shortcuts.delete}
                >
                  Delete
                </CommandItem>
              </>
            ) : mode === "trash" ? (
              <CommandItem
                icon={<RotateCcw size={15} aria-hidden="true" />}
                onClick={onRestore}
              >
                Restore
              </CommandItem>
            ) : mode === "archive" ? (
              <>
                <CommandItem
                  icon={<RotateCcw size={15} aria-hidden="true" />}
                  onClick={onUnarchive}
                >
                  Unarchive
                </CommandItem>
                <CommandItem
                  danger
                  icon={<Trash2 size={15} aria-hidden="true" />}
                  onClick={onDelete}
                >
                  Move to Trash
                </CommandItem>
              </>
            ) : moveView ? (
              <div className="notes-move-chooser">
                <div className="notes-move-search-field">
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={moveSearchRef}
                    type="search"
                    role="searchbox"
                    aria-label="Search move destinations"
                    aria-controls={moveListboxId}
                    aria-activedescendant={
                      moveSelection >= 0
                        ? `${moveListboxId}-${moveSelection}`
                        : undefined
                    }
                    value={moveQuery}
                    onChange={handleMoveSearchChange}
                    onKeyDown={handleMoveSearchKeyDown}
                  />
                </div>
                <div
                  id={moveListboxId}
                  className="notes-move-destinations"
                  role="listbox"
                  aria-label="Move destinations"
                  aria-busy={moveDestinationsLoading || moveCommitPending}
                >
                  {filteredMoveDestinations.map((destination, index) => (
                    <button
                      id={`${moveListboxId}-${index}`}
                      className="notes-move-destination"
                      type="button"
                      role="option"
                      aria-selected={moveSelection === index}
                      disabled={moveCommitPending}
                      key={destination.id ?? "root"}
                      style={
                        {
                          "--notes-move-depth": destination.depth
                        } as CSSProperties
                      }
                      onMouseMove={() => setMoveSelection(index)}
                      onClick={() => void chooseMoveDestination(destination.id)}
                    >
                      {destination.label}
                    </button>
                  ))}
                  {moveDestinationsLoading ? (
                    <p
                      className="notes-move-empty"
                      role="status"
                      aria-label="Loading move destinations"
                    >
                      Loading...
                    </p>
                  ) : (
                    filteredMoveDestinations.length === 0 && (
                    <p className="notes-move-empty">No destinations found</p>
                    )
                  )}
                </div>
                {moveError && (
                  <p className="notes-move-error" role="alert">
                    {moveError}
                  </p>
                )}
              </div>
            ) : exportView ? (
              <>
                <CommandItem
                  closeOnClick={false}
                  itemRef={exportBackRef}
                  icon={<ChevronLeft size={15} aria-hidden="true" />}
                  onClick={() => {
                    viewFocusTargetRef.current = "export";
                    setExportView(false);
                  }}
                >
                  Back
                </CommandItem>
                <CommandItem
                  disabled={resolvedExportDisabled}
                  icon={<FileText size={15} aria-hidden="true" />}
                  onClick={() => onExport?.("markdown")}
                >
                  Export subtree as Markdown
                </CommandItem>
                <CommandItem
                  disabled={resolvedExportDisabled}
                  icon={<FileDown size={15} aria-hidden="true" />}
                  onClick={() => onExport?.("pdf")}
                >
                  Export subtree as PDF
                </CommandItem>
              </>
            ) : (
              <>
                <CommandItem
                  icon={<Check size={15} aria-hidden="true" />}
                  onClick={onToggleComplete}
                  shortcut={shortcuts.toggleComplete}
                >
                  {completed ? "Uncomplete" : "Complete"}
                </CommandItem>
                <CommandItem
                  icon={
                    markerKind === "todo" ? (
                      <Circle size={15} aria-hidden="true" />
                    ) : (
                      <SquareCheckBig size={15} aria-hidden="true" />
                    )
                  }
                  onClick={() =>
                    onChangeMarkerKind?.(
                      markerKind === "todo" ? "bullet" : "todo"
                    )
                  }
                >
                  {markerKind === "todo" ? "Change to bullet" : "To-do"}
                </CommandItem>
                <CommandItem
                  icon={
                    <Star
                      size={15}
                      fill={starred ? "currentColor" : "none"}
                      aria-hidden="true"
                    />
                  }
                  onClick={onToggleStar}
                >
                  {starred ? "Unstar" : "Star"}
                </CommandItem>
                <CommandItem
                  icon={<MessageSquareText size={15} aria-hidden="true" />}
                  onClick={() => {
                    handoffPendingRef.current = "note";
                  }}
                  shortcut={shortcuts.focusNote}
                >
                  {hasNote ? "Edit note" : "Add note"}
                </CommandItem>
                {!isReadonly && (
                  <CommandItem
                    icon={<Calendar size={15} aria-hidden="true" />}
                    onClick={() => {
                      handoffPendingRef.current = "date";
                    }}
                  >
                    Add date
                  </CommandItem>
                )}
                {!isReadonly && onUploadImage && (
                  <CommandItem
                    icon={<ImageUp size={15} aria-hidden="true" />}
                    onClick={onUploadImage}
                  >
                    Upload image
                  </CommandItem>
                )}
                <Menu.Separator className="notes-bullet-menu-separator" />
                {!isReadonly && (
                  <Menu.Item
                    ref={moveCommandRef}
                    className="notes-bullet-menu-item"
                    closeOnClick={false}
                    disabled={
                      actionBusy ||
                      !onMoveTo ||
                      (!getMoveDestinations && moveDestinations.length === 0)
                    }
                    onClick={() => {
                      const requestId = moveRequestRef.current + 1;
                      moveRequestRef.current = requestId;
                      setMoveQuery("");
                      setMoveSelection(-1);
                      setMoveView(true);
                      setMoveError(null);
                      const destinations =
                        getMoveDestinations?.() ?? moveDestinations;
                      if (Array.isArray(destinations)) {
                        setAvailableMoveDestinations(destinations);
                        setMoveDestinationsLoading(false);
                        return;
                      }
                      setAvailableMoveDestinations([]);
                      setMoveDestinationsLoading(true);
                      void Promise.resolve(destinations).then(
                        (resolved) => {
                          if (moveRequestRef.current === requestId) {
                            setAvailableMoveDestinations(resolved);
                            setMoveDestinationsLoading(false);
                          }
                        },
                        (cause) => {
                          if (moveRequestRef.current === requestId) {
                            setMoveDestinationsLoading(false);
                            setMoveError(
                              cause instanceof Error
                                ? `${cause.message} Refresh Move To and try again.`
                                : "Could not load move destinations. Try again."
                            );
                          }
                        }
                      );
                    }}
                  >
                    <FolderInput size={15} aria-hidden="true" />
                    <span>Move To...</span>
                    <ChevronRight
                      className="notes-bullet-menu-chevron"
                      size={14}
                      aria-hidden="true"
                    />
                  </Menu.Item>
                )}
                <CommandItem
                  disabled={actionBusy || !onExpandAll}
                  icon={<ChevronsUpDown size={15} aria-hidden="true" />}
                  onClick={onExpandAll}
                >
                  Expand all
                </CommandItem>
                <CommandItem
                  disabled={actionBusy || !onCollapseAll}
                  icon={<ChevronsDownUp size={15} aria-hidden="true" />}
                  onClick={onCollapseAll}
                >
                  Collapse all
                </CommandItem>
                {!isReadonly && (
                  <>
                    <CommandItem
                      disabled={actionBusy || !onSortAscending}
                      icon={<ArrowDownAZ size={15} aria-hidden="true" />}
                      onClick={onSortAscending}
                    >
                      Sort A-Z
                    </CommandItem>
                    <CommandItem
                      disabled={actionBusy || !onSortDescending}
                      icon={<ArrowUpZA size={15} aria-hidden="true" />}
                      onClick={onSortDescending}
                    >
                      Sort Z-A
                    </CommandItem>
                  </>
                )}
                <Menu.Separator className="notes-bullet-menu-separator" />
                {hasNote && !isReadonly && (
                  <CommandItem
                    danger
                    icon={<MessageSquareOff size={15} aria-hidden="true" />}
                    onClick={onRemoveNote}
                  >
                    Remove note
                  </CommandItem>
                )}
                <CommandItem
                  icon={<Copy size={15} aria-hidden="true" />}
                  onClick={onDuplicate}
                  shortcut={shortcuts.duplicate}
                >
                  Duplicate
                </CommandItem>
                {onToggleReadonly && (
                  <CommandItem
                    icon={
                      isReadonly ? (
                        <LockOpen size={15} aria-hidden="true" />
                      ) : (
                        <Lock size={15} aria-hidden="true" />
                      )
                    }
                    onClick={onToggleReadonly}
                  >
                    {isReadonly ? "Make editable" : "Make read-only"}
                  </CommandItem>
                )}
                <Menu.Item
                  ref={exportCommandRef}
                  className="notes-bullet-menu-item"
                  closeOnClick={false}
                  disabled={resolvedExportDisabled}
                  onClick={() => {
                    viewFocusTargetRef.current = "back";
                    setExportView(true);
                  }}
                >
                  <Download size={15} aria-hidden="true" />
                  <span>Export subtree</span>
                  <ChevronRight
                    className="notes-bullet-menu-chevron"
                    size={14}
                    aria-hidden="true"
                  />
                </Menu.Item>
                {!isReadonly && (
                  <CommandItem
                    danger
                    icon={<Trash2 size={15} aria-hidden="true" />}
                    onClick={onDelete}
                    shortcut={shortcuts.delete}
                  >
                    Delete
                  </CommandItem>
                )}
                {saveFailed && (
                  <CommandItem
                    icon={<RotateCcw size={15} aria-hidden="true" />}
                    onClick={onRetrySave}
                  >
                    Retry save
                  </CommandItem>
                )}
                {(createdAt || updatedAt) && (
                  <>
                    <Menu.Separator className="notes-bullet-menu-separator" />
                    <div className="notes-bullet-menu-timestamps">
                      <Clock3 size={14} aria-hidden="true" />
                      <div>
                        {createdAt && (
                          <p>Created {formatTimestamp(createdAt)}</p>
                        )}
                        {updatedAt && (
                          <p>Changed {formatTimestamp(updatedAt)}</p>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
