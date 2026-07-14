import { Menu } from "@base-ui/react/menu";
import {
  Download,
  ExternalLink,
  Maximize2,
  MoreVertical,
  Settings,
  Trash2
} from "lucide-react";
import type { PointerEvent } from "react";
import { IconTooltip } from "../../components/ui/Tooltip";

export interface NotesImageMenuProps {
  readonly originalName: string;
  readonly disabled?: boolean;
  readonly onShowFullScreen: () => void;
  readonly onViewOriginal?: () => void;
  readonly onDownload?: () => void;
  readonly onDelete?: () => void;
  readonly onOpenSettings?: () => void;
}

interface ImageMenuItemProps {
  readonly children: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly icon: React.ReactNode;
  readonly onClick?: () => void;
}

function stopRowPointerDown(event: PointerEvent) {
  event.stopPropagation();
}

function ImageMenuItem({
  children,
  danger = false,
  disabled = false,
  icon,
  onClick
}: ImageMenuItemProps) {
  return (
    <Menu.Item
      className="notes-bullet-menu-item"
      data-danger={danger ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={stopRowPointerDown}
    >
      {icon}
      <span>{children}</span>
    </Menu.Item>
  );
}

export function NotesImageMenu({
  originalName,
  disabled = false,
  onShowFullScreen,
  onViewOriginal,
  onDownload,
  onDelete,
  onOpenSettings
}: NotesImageMenuProps) {
  return (
    <Menu.Root disabled={disabled} modal={false}>
      <IconTooltip label="Image actions" side="left">
        <Menu.Trigger
          type="button"
          className="notes-image-menu-trigger"
          aria-label={`Image actions for ${originalName}`}
          disabled={disabled}
          onPointerDown={stopRowPointerDown}
        >
          <MoreVertical size={18} aria-hidden="true" />
        </Menu.Trigger>
      </IconTooltip>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="notes-bullet-menu notes-image-menu">
            <ImageMenuItem
              icon={<Maximize2 size={16} aria-hidden="true" />}
              onClick={onShowFullScreen}
            >
              Show full-screen
            </ImageMenuItem>
            <ImageMenuItem
              disabled={!onViewOriginal}
              icon={<ExternalLink size={16} aria-hidden="true" />}
              onClick={onViewOriginal}
            >
              View original
            </ImageMenuItem>
            <ImageMenuItem
              disabled={!onDownload}
              icon={<Download size={16} aria-hidden="true" />}
              onClick={onDownload}
            >
              Download
            </ImageMenuItem>
            <ImageMenuItem
              danger
              disabled={!onDelete}
              icon={<Trash2 size={16} aria-hidden="true" />}
              onClick={onDelete}
            >
              Delete
            </ImageMenuItem>
            <ImageMenuItem
              disabled={!onOpenSettings}
              icon={<Settings size={16} aria-hidden="true" />}
              onClick={onOpenSettings}
            >
              Settings
            </ImageMenuItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

