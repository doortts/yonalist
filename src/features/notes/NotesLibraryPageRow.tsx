import { Menu } from "@base-ui/react/menu";
import {
  Archive,
  ChevronLeft,
  Copy,
  Download,
  FileDown,
  FileText,
  FolderOpen,
  MoreHorizontal,
  RotateCcw,
  Star,
  Trash2
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import type { NoteNode } from "../../domain/notes";
import type { NotesExportFormat } from "../../domain/notesExport";

export type NotesLibraryPageRowMode = "active" | "archive" | "trash";

export interface NotesLibraryPageRowProps {
  node: NoteNode;
  mode: NotesLibraryPageRowMode;
  active: boolean;
  disabled?: boolean;
  onOpen(): void;
  onToggleStar(): void;
  onArchive(): void;
  onUnarchive(): void;
  onRestore(): void;
  onMoveToTrash(): void;
  onDuplicate(): void;
  onExport(format: NotesExportFormat): void;
}

interface CommandItemProps {
  children: ReactNode;
  danger?: boolean;
  icon: ReactNode;
  closeOnClick?: boolean;
  itemRef?: React.Ref<HTMLElement>;
  onClick(): void;
}

function pageLabel(title: string): string {
  return title.trim() || "Untitled page";
}

function CommandItem({
  children,
  danger = false,
  icon,
  closeOnClick = true,
  itemRef,
  onClick
}: CommandItemProps) {
  return (
    <Menu.Item
      ref={itemRef}
      className="notes-library-page-menu-item"
      data-danger={danger ? "true" : undefined}
      closeOnClick={closeOnClick}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </Menu.Item>
  );
}

export function NotesLibraryPageRow({
  node,
  mode,
  active,
  disabled = false,
  onOpen,
  onToggleStar,
  onArchive,
  onUnarchive,
  onRestore,
  onMoveToTrash,
  onDuplicate,
  onExport
}: NotesLibraryPageRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportView, setExportView] = useState(false);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const exportBackRef = useRef<HTMLElement>(null);
  const exportCommandRef = useRef<HTMLElement>(null);
  const viewFocusTargetRef = useRef<"back" | "export" | null>(null);
  const label = pageLabel(node.title);

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
    <div
      className="notes-library-page-row"
      data-active={active ? "true" : undefined}
    >
      <button
        className="notes-library-page"
        type="button"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        disabled={disabled}
        onClick={onOpen}
      >
        <FileText size={16} aria-hidden="true" />
        <span>{label}</span>
      </button>

      <Menu.Root
        modal={false}
        open={menuOpen}
        disabled={disabled}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) {
            setExportView(false);
          }
        }}
      >
        <Menu.Trigger
          className="notes-library-page-menu-trigger"
          type="button"
          aria-label={`Page actions for ${label}`}
          disabled={disabled}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={4}>
            <Menu.Popup className="notes-library-page-menu">
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
                    onClick={() => setTrashConfirmOpen(true)}
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
                    onClick={() => onExport("markdown")}
                  >
                    Export as Markdown
                  </CommandItem>
                  <CommandItem
                    icon={<FileDown size={15} aria-hidden="true" />}
                    onClick={() => onExport("pdf")}
                  >
                    Export as PDF
                  </CommandItem>
                </>
              ) : (
                <>
                  <CommandItem
                    icon={<FolderOpen size={15} aria-hidden="true" />}
                    onClick={onOpen}
                  >
                    Open
                  </CommandItem>
                  <CommandItem
                    icon={
                      <Star
                        size={15}
                        fill={node.isStarred ? "currentColor" : "none"}
                        aria-hidden="true"
                      />
                    }
                    onClick={onToggleStar}
                  >
                    {node.isStarred ? "Unstar" : "Star"}
                  </CommandItem>
                  <CommandItem
                    icon={<Archive size={15} aria-hidden="true" />}
                    onClick={onArchive}
                  >
                    Archive
                  </CommandItem>
                  <CommandItem
                    danger
                    icon={<Trash2 size={15} aria-hidden="true" />}
                    onClick={() => setTrashConfirmOpen(true)}
                  >
                    Move to Trash
                  </CommandItem>
                  <CommandItem
                    icon={<Copy size={15} aria-hidden="true" />}
                    onClick={onDuplicate}
                  >
                    Duplicate
                  </CommandItem>
                  <CommandItem
                    closeOnClick={false}
                    itemRef={exportCommandRef}
                    icon={<Download size={15} aria-hidden="true" />}
                    onClick={() => {
                      viewFocusTargetRef.current = "back";
                      setExportView(true);
                    }}
                  >
                    Export
                  </CommandItem>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <ConfirmDialog
        open={trashConfirmOpen}
        onOpenChange={setTrashConfirmOpen}
        title="Move page to Trash?"
        description={`Move ${label} and all of its descendants to Trash?`}
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        danger
        onConfirm={onMoveToTrash}
      />
    </div>
  );
}
