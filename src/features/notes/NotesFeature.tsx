import { NotebookPen } from "lucide-react";
import type { PropsWithChildren } from "react";
import type { FeatureDefinition } from "../core/featureTypes";

export function NotesFeatureProvider({ children }: PropsWithChildren) {
  return <>{children}</>;
}

export function NotesLibraryPlaceholder() {
  return (
    <section aria-label="Notes library">
      <header>
        <h2>Notes</h2>
      </header>
      <p>No notes yet.</p>
    </section>
  );
}

export function NotesOutlinePlaceholder() {
  return (
    <section aria-label="Notes outline">
      <header>
        <h2>Outline</h2>
      </header>
      <p>Select a note to view its outline.</p>
    </section>
  );
}

export const notesFeature: FeatureDefinition = {
  id: "notes",
  label: "Notes",
  icon: NotebookPen,
  section: "workspace",
  order: 20,
  requiresGithubAuth: false,
  Provider: NotesFeatureProvider,
  renderPanes: () => ({
    middle: <NotesLibraryPlaceholder />,
    detail: <NotesOutlinePlaceholder />
  })
};
