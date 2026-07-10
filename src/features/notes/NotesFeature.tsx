import { NotebookPen } from "lucide-react";
import { useContext, type PropsWithChildren } from "react";
import { VaultRootContext } from "../../VaultRootContext";
import { notesStore } from "../../services/notesStore";
import type { FeatureDefinition } from "../core/featureTypes";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import { useNotesWorkspace } from "./useNotesWorkspace";
import "./notes.css";

export function NotesWorkspaceProvider({ children }: PropsWithChildren) {
  const vaultRoot = useContext(VaultRootContext);
  const workspace = useNotesWorkspace({ vaultRoot, repository: notesStore });

  return (
    <NotesWorkspaceContext.Provider value={workspace}>
      {children}
    </NotesWorkspaceContext.Provider>
  );
}

export function NotesFeatureProvider({ children }: PropsWithChildren) {
  return <NotesWorkspaceProvider>{children}</NotesWorkspaceProvider>;
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
    middle: <NotesLibraryPane />,
    detail: <NotesOutlinePane />
  })
};
