import { Menu } from "@base-ui/react/menu";
import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileDown,
  FileText,
  ImageUp,
  MessageSquareOff,
  MessageSquareText,
  MoreHorizontal,
  RotateCcw,
  Star,
  Trash2
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NotesExportFormat } from "../../domain/notesExport";

export interface NotesBulletMenuProps {
  mode?: "standard" | "archive" | "trash";
  label: string;
  completed?: boolean;
  starred?: boolean;
  hasNote?: boolean;
  saveFailed?: boolean;
  disabled?: boolean;
  exportDisabled?: boolean;
  onToggleComplete?(): void;
  onToggleStar?(): void;
  onOpenNote?(): void;
  onAddDate?(): void;
  onUploadImage?(): void;
  onRemoveNote?(): void;
  onDuplicate?(): void;
  onExport?(format: NotesExportFormat): void;
  onDelete?(): void;
  onRetrySave?(): void;
  onRestore?(): void;
  onUnarchive?(): void;
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
  onToggleComplete,
  onToggleStar,
  onOpenNote,
  onAddDate,
  onUploadImage,
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
  const exportBackRef = useRef<HTMLElement>(null);
  const exportCommandRef = useRef<HTMLElement>(null);
  const viewFocusTargetRef = useRef<"back" | "export" | null>(null);
  const handoffPendingRef = useRef<"note" | "date" | null>(null);

  useLayoutEffect(() => {
    if (viewFocusTargetRef.current === "back" && exportView) {
      viewFocusTargetRef.current = null;
      exportBackRef.current?.focus();
    } else if (viewFocusTargetRef.current === "export" && !exportView) {
      viewFocusTargetRef.current = null;
      exportCommandRef.current?.focus();
    }
  }, [exportView]);

  return (
    <Menu.Root
      disabled={disabled}
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setExportView(false);
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
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
