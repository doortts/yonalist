import { Menu } from "@base-ui/react/menu";
import {
  Archive,
  ChevronLeft,
  Copy,
  Download,
  FileDown,
  FileText,
  FolderOpen,
  Lock,
  LockOpen,
  MoreHorizontal,
  RotateCcw,
  Star,
  Trash2
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import type { NoteNode } from "../../domain/notes";
import type { NotesExportFormat } from "../../domain/notesExport";
import { noteNodeNavigationLabel } from "./notesPresentation";

export type NotesLibraryPageRowMode = "active" | "archive" | "trash";

export interface NotesLibraryPageRowProps {
  node: NoteNode;
  displayTitle?: string;
  imageAttachmentOriginalName?: string;
  mode: NotesLibraryPageRowMode;
  active: boolean;
  disabled?: boolean;
  skipTrashConfirmation?: boolean;
  onActivate(): void;
  onOpen(): void;
  onToggleStar(): void;
  onArchive(): void;
  onUnarchive(): void;
  onRestore(): void;
  onMoveToTrash(): void;
  onDuplicate(): void;
  onToggleReadonly(): void;
  onExport(format: NotesExportFormat): void;
  onRename(title: string): Promise<boolean>;
}

interface CommandItemProps {
  children: ReactNode;
  danger?: boolean;
  icon: ReactNode;
  closeOnClick?: boolean;
  itemRef?: React.Ref<HTMLElement>;
  onClick(): void;
}

function visiblePageLabel(
  node: NoteNode,
  title: string,
  imageAttachmentOriginalName?: string
): string {
  return noteNodeNavigationLabel(
    node,
    title,
    "Untitled page",
    imageAttachmentOriginalName
  );
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
  displayTitle = node.title,
  imageAttachmentOriginalName,
  mode,
  active,
  disabled = false,
  skipTrashConfirmation = false,
  onActivate,
  onOpen,
  onToggleStar,
  onArchive,
  onUnarchive,
  onRestore,
  onMoveToTrash,
  onDuplicate,
  onToggleReadonly,
  onExport,
  onRename
}: NotesLibraryPageRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportView, setExportView] = useState(false);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(displayTitle);
  const [saving, setSaving] = useState(false);
  const skipBlurCommitRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const commitInFlightRef = useRef(false);
  const exportBackRef = useRef<HTMLElement>(null);
  const exportCommandRef = useRef<HTMLElement>(null);
  const viewFocusTargetRef = useRef<"back" | "export" | null>(null);
  const label = visiblePageLabel(node, displayTitle, imageAttachmentOriginalName);
  const accessibleLabel =
    node.nodeKind === "image" ? `Image: ${label}` : label;
  const canRename = node.nodeKind !== "image" && node.isReadonly !== true;
  const requestTrash = () => {
    if (skipTrashConfirmation) {
      onMoveToTrash();
      return;
    }
    setTrashConfirmOpen(true);
  };

  useLayoutEffect(() => {
    if (!editing) {
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editing]);

  useLayoutEffect(() => {
    if (editing && (!active || mode !== "active")) {
      skipBlurCommitRef.current = true;
      setEditTitle(displayTitle);
      setEditing(false);
    }
  }, [active, displayTitle, editing, mode]);

  useLayoutEffect(() => {
    if (viewFocusTargetRef.current === "back" && exportView) {
      viewFocusTargetRef.current = null;
      exportBackRef.current?.focus();
    } else if (viewFocusTargetRef.current === "export" && !exportView) {
      viewFocusTargetRef.current = null;
      exportCommandRef.current?.focus();
    }
  }, [exportView]);

  const commitRename = async () => {
    if (saving || commitInFlightRef.current) {
      return;
    }
    if (editTitle === node.title && displayTitle === node.title) {
      setEditing(false);
      return;
    }
    commitInFlightRef.current = true;
    setSaving(true);
    try {
      const saved = await onRename(editTitle);
      if (saved) {
        setEditing(false);
      }
    } catch {
      // A failed save stays editable so the same title can be retried.
    } finally {
      commitInFlightRef.current = false;
      setSaving(false);
    }
  };

  const startRename = () => {
    if (node.isReadonly === true) {
      onOpen();
      return;
    }
    if (!canRename) {
      if (active) onActivate();
      else onOpen();
      return;
    }
    if (mode !== "active" || !active) {
      onOpen();
      return;
    }
    onActivate();
    skipBlurCommitRef.current = false;
    setEditTitle(displayTitle);
    setEditing(true);
  };

  return (
    <div
      className="notes-library-page-row"
      data-active={active ? "true" : undefined}
    >
      {editing && canRename && mode === "active" && active ? (
        <div className="notes-library-page notes-library-page-editing">
          <FileText size={16} aria-hidden="true" />
          <input
            ref={renameInputRef}
            className="notes-library-page-rename-input"
            type="text"
            aria-label={`Rename ${label}`}
            value={editTitle}
            disabled={disabled}
            readOnly={saving}
            onChange={(event) => setEditTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename();
              } else if (event.key === "Escape" && !saving) {
                event.preventDefault();
                skipBlurCommitRef.current = true;
                setEditTitle(displayTitle);
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (skipBlurCommitRef.current) {
                skipBlurCommitRef.current = false;
                return;
              }
              void commitRename();
            }}
          />
        </div>
      ) : (
        <button
          className="notes-library-page"
          type="button"
          aria-label={accessibleLabel}
          aria-current={active ? "page" : undefined}
          disabled={disabled}
          onClick={startRename}
        >
          <FileText size={16} aria-hidden="true" />
          <span>{label}</span>
        </button>
      )}

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
          aria-label={`Page actions for ${accessibleLabel}`}
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
                  {node.isReadonly !== true && (
                    <CommandItem
                      danger
                      icon={<Trash2 size={15} aria-hidden="true" />}
                      onClick={requestTrash}
                    >
                      Move to Trash
                    </CommandItem>
                  )}
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
                  {node.isReadonly !== true && (
                    <CommandItem
                      danger
                      icon={<Trash2 size={15} aria-hidden="true" />}
                      onClick={requestTrash}
                    >
                      Move to Trash
                    </CommandItem>
                  )}
                  <CommandItem
                    icon={<Copy size={15} aria-hidden="true" />}
                    onClick={onDuplicate}
                  >
                    Duplicate
                  </CommandItem>
                  <CommandItem
                    icon={
                      node.isReadonly === true ? (
                        <LockOpen size={15} aria-hidden="true" />
                      ) : (
                        <Lock size={15} aria-hidden="true" />
                      )
                    }
                    onClick={onToggleReadonly}
                  >
                    {node.isReadonly === true
                      ? "Make editable"
                      : "Make read-only"}
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
