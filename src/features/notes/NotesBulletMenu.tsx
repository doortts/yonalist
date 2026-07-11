import { Menu } from "@base-ui/react/menu";
import {
  ArrowDownAZ,
  ArrowUpZA,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock3,
  Copy,
  Download,
  FileDown,
  FileText,
  FolderInput,
  ImageUp,
  MessageSquareOff,
  MessageSquareText,
  MoreHorizontal,
  RotateCcw,
  Search,
  Star,
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
  useState
} from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NotesExportFormat } from "../../domain/notesExport";
import type { NotesMoveDestination } from "./notesMoveTargets";

export {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  type NotesMoveDestination
} from "./notesMoveTargets";

export interface NotesBulletMenuProps {
  mode?: "standard" | "archive" | "trash";
  label: string;
  completed?: boolean;
  starred?: boolean;
  hasNote?: boolean;
  saveFailed?: boolean;
  disabled?: boolean;
  exportDisabled?: boolean;
  actionBusy?: boolean;
  createdAt?: string;
  updatedAt?: string;
  formatTimestamp?(value: string): string;
  moveDestinations?: readonly NotesMoveDestination[];
  getMoveDestinations?():
    | readonly NotesMoveDestination[]
    | Promise<readonly NotesMoveDestination[]>;
  onToggleComplete?(): void;
  onToggleStar?(): void;
  onOpenNote?(): void;
  onAddDate?(): void;
  onUploadImage?(): void;
  onMoveTo?(
    destinationId: string | null
  ):
    | void
    | NotesMoveCommitOutcome
    | Promise<void | NotesMoveCommitOutcome>;
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
}

export type NotesMoveCommitOutcome =
  | { ok: true }
  | { ok: false; error: string };

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
  icon: ReactNode;
  closeOnClick?: boolean;
  itemRef?: Ref<HTMLElement>;
  onClick?(): void;
}

function CommandItem({
  children,
  danger = false,
  disabled = false,
  icon,
  closeOnClick = true,
  itemRef,
  onClick
}: CommandItemProps) {
  return (
    <Menu.Item
      ref={itemRef}
      className="notes-bullet-menu-item"
      data-danger={danger ? "true" : undefined}
      disabled={disabled}
      closeOnClick={closeOnClick}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </Menu.Item>
  );
}

export function NotesBulletMenu({
  mode = "standard",
  label,
  completed = false,
  starred = false,
  hasNote = false,
  saveFailed = false,
  disabled = false,
  exportDisabled = false,
  actionBusy = false,
  createdAt,
  updatedAt,
  formatTimestamp = formatNotesTimestamp,
  moveDestinations = [],
  getMoveDestinations,
  onToggleComplete,
  onToggleStar,
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
  onUnarchive
}: NotesBulletMenuProps) {
  const [open, setOpen] = useState(false);
  const [exportView, setExportView] = useState(false);
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
  const handoffPendingRef = useRef<"note" | "date" | null>(null);
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
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen && handoffPendingRef.current) {
          const handoff = handoffPendingRef.current;
          handoffPendingRef.current = null;
          if (handoff === "note") {
            onOpenNote?.();
          } else {
            onAddDate?.();
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
            finalFocus={handoffPendingRef.current ? false : undefined}
          >
            {mode === "trash" ? (
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
                  ) : filteredMoveDestinations.length === 0 && (
                    <p className="notes-move-empty">No destinations found</p>
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
                  icon={<FileText size={15} aria-hidden="true" />}
                  onClick={() => onExport?.("markdown")}
                >
                  Export subtree as Markdown
                </CommandItem>
                <CommandItem
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
                >
                  {completed ? "Uncomplete" : "Complete"}
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
                >
                  {hasNote ? "Edit note" : "Add note"}
                </CommandItem>
                <CommandItem
                  icon={<Calendar size={15} aria-hidden="true" />}
                  onClick={() => {
                    handoffPendingRef.current = "date";
                  }}
                >
                  Add date
                </CommandItem>
                {onUploadImage && (
                  <CommandItem
                    icon={<ImageUp size={15} aria-hidden="true" />}
                    onClick={onUploadImage}
                  >
                    Upload image
                  </CommandItem>
                )}
                <Menu.Separator className="notes-bullet-menu-separator" />
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
                <Menu.Separator className="notes-bullet-menu-separator" />
                {hasNote && (
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
                >
                  Duplicate
                </CommandItem>
                <Menu.Item
                  ref={exportCommandRef}
                  className="notes-bullet-menu-item"
                  closeOnClick={false}
                  disabled={exportDisabled}
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
                <CommandItem
                  danger
                  icon={<Trash2 size={15} aria-hidden="true" />}
                  onClick={onDelete}
                >
                  Delete
                </CommandItem>
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
