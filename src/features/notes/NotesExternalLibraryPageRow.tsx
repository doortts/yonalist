import { Bell } from "lucide-react";
import type { ExternalSourcePageSnapshot } from "../../domain/externalSources";

interface NotesExternalLibraryPageRowProps {
  page: ExternalSourcePageSnapshot;
  active: boolean;
  disabled?: boolean;
  onOpen(): void;
}

export function NotesExternalLibraryPageRow({
  page,
  active,
  disabled = false,
  onOpen
}: NotesExternalLibraryPageRowProps) {
  return (
    <div
      className="notes-library-page-row notes-external-library-page-row"
      data-active={active ? "true" : undefined}
      data-external-provider-id={page.providerId}
    >
      <button
        className="notes-library-page"
        type="button"
        aria-current={active ? "page" : undefined}
        disabled={disabled}
        onClick={onOpen}
      >
        <Bell size={16} aria-hidden="true" />
        <span>{page.title}</span>
      </button>
    </div>
  );
}
