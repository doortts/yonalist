import { ImagePlus, MoreHorizontal } from "lucide-react";
import {
  useEffect, useRef, useState, useSyncExternalStore, type CSSProperties
} from "react";

import type {
  OutlineRowActionSource, OutlineRowActionTarget
} from "./monaco-outline/rowActions";
import { RowMenuItem } from "./outlineSupport";

/**
 * `OutlineRow`'s left action rail for a surface that has no rows: one trigger
 * follows the tracked line down the gutter. Same classes, icons and menu as the
 * React rail, so adding the rest of its items is adding `RowMenuItem`s here.
 */
export function MonacoRowActions({
  rows,
  onPickImage,
  onDismiss
}: {
  readonly rows: OutlineRowActionSource;
  readonly onPickImage: (nodeId: string) => void;
  /** Hands the focus back to the editor when the menu closes. */
  readonly onDismiss: () => void;
}) {
  const tracked = useSyncExternalStore(rows.subscribe, rows.current);
  // Opening the menu takes the focus out of the editor, which drops the caret
  // target; the open menu holds its own row still until it closes.
  const [open, setOpen] = useState<OutlineRowActionTarget | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const target = open ?? tracked;
  useEffect(() => {
    if (open) menuRef.current?.querySelector("button")?.focus();
  }, [open]);
  if (!target) return null;
  const close = () => {
    setOpen(null);
    onDismiss();
  };
  return (
    <span
      className="notes-node-menu-slot notes-monaco-row-actions"
      style={{ top: target.top }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
      }}
    >
      <button
        className="notes-bullet-menu-trigger"
        type="button"
        aria-label={`Actions for ${target.title || "Untitled"}`}
        aria-haspopup="menu"
        data-popup-open={open ? "true" : undefined}
        onClick={() => setOpen(open ? null : target)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="notes-bullet-menu"
          role="menu"
          style={{
            "--available-height": "420px",
            position: "absolute",
            insetInlineStart: 0,
            insetBlockStart: 28
          } as CSSProperties}
        >
          <RowMenuItem
            icon={<ImagePlus size={14} aria-hidden="true" />}
            label="Upload image"
            onClick={() => {
              close();
              onPickImage(open.nodeId);
            }}
          />
        </div>
      )}
    </span>
  );
}
