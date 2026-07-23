import { Bell } from "lucide-react";
import type { NoteNode } from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_PROVIDER_ID } from "../../services/githubNotificationsProvider";

interface NotesExternalLibraryPageRowProps {
  node: NoteNode;
  active: boolean;
  disabled?: boolean;
  onOpen(): void;
}

export function NotesExternalLibraryPageRow({
  node,
  active,
  disabled = false,
  onOpen
}: NotesExternalLibraryPageRowProps) {
  return (
    <div
      className="notes-library-page-row notes-external-library-page-row"
      data-active={active ? "true" : undefined}
      data-external-provider-id={GITHUB_NOTIFICATIONS_PROVIDER_ID}
    >
      <button
        className="notes-library-page"
        type="button"
        aria-current={active ? "page" : undefined}
        disabled={disabled}
        onClick={onOpen}
      >
        <Bell size={16} aria-hidden="true" />
        <span>{node.title}</span>
      </button>
    </div>
  );
}
