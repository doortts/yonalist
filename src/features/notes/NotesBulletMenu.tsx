import { Menu } from "@base-ui/react/menu";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileDown,
  FileText,
  MessageSquareText,
  MoreHorizontal,
  RotateCcw,
  Star,
  Trash2
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NotesExportFormat } from "../../domain/notesExport";

export interface NotesBulletMenuProps {
  mode?: "standard" | "trash";
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
  onDuplicate?(): void;
  onExport?(format: NotesExportFormat): void;
  onDelete?(): void;
  onRetrySave?(): void;
  onRestore?(): void;
}

interface CommandItemProps {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  closeOnClick?: boolean;
  onClick?(): void;
}

function CommandItem({
  children,
  danger = false,
  disabled = false,
  icon,
  closeOnClick = true,
  onClick
}: CommandItemProps) {
  return (
    <Menu.Item
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
  onDuplicate,
  onExport,
  onDelete,
  onRetrySave,
  onRestore
}: NotesBulletMenuProps) {
  const [exportView, setExportView] = useState(false);

  return (
    <Menu.Root
      disabled={disabled}
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          setExportView(false);
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
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="notes-bullet-menu">
            {mode === "trash" ? (
              <CommandItem
                icon={<RotateCcw size={15} aria-hidden="true" />}
                onClick={onRestore}
              >
                Restore
              </CommandItem>
            ) : exportView ? (
              <>
                <CommandItem
                  closeOnClick={false}
                  icon={<ChevronLeft size={15} aria-hidden="true" />}
                  onClick={() => setExportView(false)}
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
                  onClick={onOpenNote}
                >
                  {hasNote ? "Edit note" : "Add note"}
                </CommandItem>
                <CommandItem
                  icon={<Copy size={15} aria-hidden="true" />}
                  onClick={onDuplicate}
                >
                  Duplicate
                </CommandItem>
                <Menu.Item
                  className="notes-bullet-menu-item"
                  closeOnClick={false}
                  disabled={exportDisabled}
                  onClick={() => setExportView(true)}
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
