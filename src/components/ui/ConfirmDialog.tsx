import type { ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import "./alert-dialog.css";

interface ConfirmDialogProps {
  /** Whether the dialog is currently open. */
  open: boolean;
  /** Called when the dialog requests to open/close (Esc, backdrop, buttons). */
  onOpenChange: (open: boolean) => void;
  /** Heading text; also the dialog's accessible name. */
  title: ReactNode;
  /** Explanatory body copy shown below the title. */
  description: ReactNode;
  /** Label for the confirming action button. */
  confirmLabel: string;
  /** Label for the dismiss button. Defaults to "취소". */
  cancelLabel?: string;
  /** Styles the confirm button as a destructive action. */
  danger?: boolean;
  /** Invoked once when the user confirms; the dialog then closes. */
  onConfirm: () => void;
}

/**
 * Shared confirmation dialog built on Base UI's AlertDialog. It reuses the
 * existing modal look (`.modal-backdrop` / `.modal` from styles.css, matching
 * OutboxModal) and the standard `.secondary-button` / `.danger-button` action
 * styles, while gaining focus trapping, focus restoration, and Escape-to-close
 * from AlertDialog. The AlertDialog.Title supplies the accessible name and
 * AlertDialog.Description the described-by copy.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "취소",
  danger = false,
  onConfirm
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(nextOpen) => onOpenChange(nextOpen)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <AlertDialog.Popup className="modal confirm-dialog">
          <AlertDialog.Title render={<h2 className="confirm-dialog-title" />}>
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="confirm-dialog-description">
            {description}
          </AlertDialog.Description>
          <div className="confirm-dialog-actions">
            <AlertDialog.Close className="secondary-button">
              {cancelLabel}
            </AlertDialog.Close>
            <button
              type="button"
              className={danger ? "danger-button" : "primary-button"}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
