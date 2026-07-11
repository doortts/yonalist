import { Menu } from "@base-ui/react/menu";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconTooltip } from "../../components/ui/Tooltip";
import type { NoteId } from "../../domain/notes";
import {
  NotesExportControllerProvider,
  useNotesExportController,
  useOptionalNotesExportController
} from "./NotesExportController";

export interface NotesExportMenuProps {
  selectedNodeId: NoteId | null;
  selectedNodeTitle?: string;
  zoomRootId: NoteId | null;
  zoomRootTitle?: string;
  onFlushDrafts(): Promise<boolean>;
  disabled?: boolean;
  loading?: boolean;
}

function NotesExportMenuContent({
  selectedNodeId,
  selectedNodeTitle,
  zoomRootId,
  zoomRootTitle
}: Omit<
  NotesExportMenuProps,
  "onFlushDrafts" | "disabled" | "loading"
>) {
  const controller = useNotesExportController();
  const [menuOpen, setMenuOpen] = useState(false);
  const noToolbarTarget = selectedNodeId === null && zoomRootId === null;
  const hardUnavailable = controller.hardUnavailable || noToolbarTarget;
  const unavailable = controller.unavailable || noToolbarTarget;

  useEffect(() => {
    if (hardUnavailable) {
      setMenuOpen(false);
    }
  }, [hardUnavailable]);

  return (
    <div className="notes-export-control" aria-busy={controller.busy}>
      {controller.busy && (
        <span className="notes-export-feedback" role="status">
          Exporting...
        </span>
      )}
      {!controller.busy && controller.feedback?.kind === "success" && (
        <span className="notes-export-feedback" role="status">
          {controller.feedback.message}
        </span>
      )}
      {!controller.busy && controller.feedback?.kind === "error" && (
        <span className="notes-export-feedback notes-export-error" role="alert">
          <span>{controller.feedback.message}</span>
          <button
            className="notes-export-retry-button"
            type="button"
            disabled={unavailable}
            onClick={controller.retryFailedExport}
          >
            Retry
          </button>
        </span>
      )}

      <Menu.Root
        open={menuOpen}
        onOpenChange={(open) => {
          if (!open || (!unavailable && !controller.busy)) {
            setMenuOpen(open);
          }
        }}
      >
        <IconTooltip label="Export" side="bottom">
          <Menu.Trigger
            className="notes-export-trigger"
            type="button"
            aria-label="Export"
            aria-busy={controller.busy || undefined}
            disabled={unavailable || controller.busy}
          >
            <Download size={16} aria-hidden="true" />
          </Menu.Trigger>
        </IconTooltip>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className="notes-export-menu">
              <Menu.Item
                className="notes-export-menu-item"
                disabled={controller.busy || selectedNodeId === null}
                onClick={() =>
                  selectedNodeId &&
                  controller.startExport(
                    selectedNodeId,
                    selectedNodeTitle,
                    "markdown"
                  )
                }
              >
                Selected node as Markdown
              </Menu.Item>
              <Menu.Item
                className="notes-export-menu-item"
                disabled={controller.busy || selectedNodeId === null}
                onClick={() =>
                  selectedNodeId &&
                  controller.startExport(selectedNodeId, selectedNodeTitle, "pdf")
                }
              >
                Selected node as PDF
              </Menu.Item>
              <Menu.Item
                className="notes-export-menu-item"
                disabled={controller.busy || zoomRootId === null}
                onClick={() =>
                  zoomRootId &&
                  controller.startExport(
                    zoomRootId,
                    zoomRootTitle,
                    "markdown"
                  )
                }
              >
                Current page as Markdown
              </Menu.Item>
              <Menu.Item
                className="notes-export-menu-item"
                disabled={controller.busy || zoomRootId === null}
                onClick={() =>
                  zoomRootId &&
                  controller.startExport(zoomRootId, zoomRootTitle, "pdf")
                }
              >
                Current page as PDF
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <ConfirmDialog
        open={controller.pendingOverwrite !== null}
        onOpenChange={(open) => {
          if (!open) {
            controller.clearPendingOverwrite();
          }
        }}
        title="Replace existing export?"
        description={
          <>
            Replace the existing export at{" "}
            <code className="notes-export-destination">
              {controller.pendingOverwrite?.request.destination}
            </code>
            ?
          </>
        }
        confirmLabel="Replace"
        cancelLabel="Cancel"
        popupClassName="notes-export-confirm-dialog"
        onConfirm={controller.replaceExistingExport}
      />
    </div>
  );
}

export function NotesExportMenu(props: NotesExportMenuProps) {
  const controller = useOptionalNotesExportController();
  const content = (
    <NotesExportMenuContent
      selectedNodeId={props.selectedNodeId}
      selectedNodeTitle={props.selectedNodeTitle}
      zoomRootId={props.zoomRootId}
      zoomRootTitle={props.zoomRootTitle}
    />
  );

  if (controller) {
    return content;
  }

  return (
    <NotesExportControllerProvider
      available={props.selectedNodeId !== null || props.zoomRootId !== null}
      disabled={props.disabled}
      loading={props.loading}
      onFlushDrafts={props.onFlushDrafts}
    >
      {content}
    </NotesExportControllerProvider>
  );
}
