import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

export interface NotesImageLightboxProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly originalName: string;
  readonly sourceUrl: string;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
}

export function NotesImageLightbox({
  open,
  onOpenChange,
  originalName,
  sourceUrl,
  intrinsicWidth,
  intrinsicHeight
}: NotesImageLightboxProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="notes-image-lightbox-backdrop" />
        <Dialog.Popup
          className="notes-image-lightbox"
          aria-label={originalName}
          onClick={() => onOpenChange(false)}
        >
          <Dialog.Close
            type="button"
            className="icon-button notes-image-lightbox-close"
            aria-label="Close full-screen image"
          >
            <X size={20} aria-hidden="true" />
          </Dialog.Close>
          <img
            className="notes-image-lightbox-image"
            src={sourceUrl}
            alt={originalName}
            width={intrinsicWidth}
            height={intrinsicHeight}
            draggable={false}
            onClick={(event) => event.stopPropagation()}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

