import { NotebookPen } from "lucide-react";
import { useContext, type PropsWithChildren } from "react";
import { VaultRootContext } from "../../VaultRootContext";
import { notesStore } from "../../services/notesStore";
import type { FeatureDefinition } from "../core/featureTypes";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesOutlinePane } from "./NotesOutlinePane";
import {
  NotesAttachmentUiContext,
  useNotesAttachmentUi
} from "./NotesAttachmentUiContext";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import {
  nativeNotesAttachmentUi,
  type NotesAttachmentUiBoundary
} from "./notesAttachmentController";
import { useFlushDraftsOnWindowClose } from "./useFlushDraftsOnWindowClose";
import { useNotesWorkspace } from "./useNotesWorkspace";
import "./notes.css";

interface NotesWorkspaceProviderProps extends PropsWithChildren {
  attachmentUi?: NotesAttachmentUiBoundary;
}

export function NotesWorkspaceProvider({
  children,
  attachmentUi
}: NotesWorkspaceProviderProps) {
  const vaultRoot = useContext(VaultRootContext);
  const contextAttachmentUi = useNotesAttachmentUi();
  const workspace = useNotesWorkspace({
    vaultRoot,
    repository: notesStore,
    attachmentUi: attachmentUi ?? contextAttachmentUi
  });

  useFlushDraftsOnWindowClose(workspace.actions.flushAllDrafts);

  // The hook always populates the memoized slices; `?? workspace` only satisfies
  // the type (the merged result is itself a valid slice).
  const stateValue = workspace.stateSlice ?? workspace;
  const draftsValue = workspace.draftsSlice ?? workspace;
  const actionsValue = workspace.actionsSlice ?? workspace;

  return (
    <NotesActionsContext.Provider value={actionsValue}>
      <NotesStateContext.Provider value={stateValue}>
        <NotesDraftsContext.Provider value={draftsValue}>
          {children}
        </NotesDraftsContext.Provider>
      </NotesStateContext.Provider>
    </NotesActionsContext.Provider>
  );
}

export function NotesFeatureProvider({
  children,
  attachmentUi
}: NotesWorkspaceProviderProps) {
  const resolvedAttachmentUi = attachmentUi ?? nativeNotesAttachmentUi;
  return (
    <NotesAttachmentUiContext.Provider value={resolvedAttachmentUi}>
      <NotesWorkspaceProvider>{children}</NotesWorkspaceProvider>
    </NotesAttachmentUiContext.Provider>
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
    middle: <NotesLibraryPane />,
    detail: <NotesOutlinePane />
  })
};
