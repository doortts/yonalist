import { NotebookPen } from "lucide-react";
import { useContext, type PropsWithChildren } from "react";
import { VaultRootContext } from "../../VaultRootContext";
import { notesStore } from "../../services/notesStore";
import type { FeatureDefinition, FeaturePanes } from "../core/featureTypes";
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

// The Notes panes take no props and never read App state, so build the
// FeaturePanes object — and the pane element mount points inside it — once and
// reuse the same references on every render. App calls `renderPanes()` in its
// render body, so returning stable references lets React bail out of the Notes
// subtree when an App-only state change (notification polling, status metrics,
// online toggles) re-renders the shell. This mirrors main's 0c19b5d pane
// memoization at the feature-pane layer. Inbox/Settings deliberately rebuild
// their panes each render so selection/list props keep flowing; their leaf
// panes are React.memo'd instead.
const notesPanes: FeaturePanes = {
  middle: <NotesLibraryPane />,
  detail: <NotesOutlinePane />
};

export const notesFeature: FeatureDefinition = {
  id: "notes",
  label: "Notes",
  icon: NotebookPen,
  section: "workspace",
  order: 20,
  requiresGithubAuth: false,
  // Notes owns a live workspace session (drafts, debounced writes, outline
  // scroll and edit focus). Keeping its panes mounted while another feature is
  // active — instead of tearing the provider down on every switch — is what
  // lets that in-memory state survive navigating away and back. The stable
  // `notesPanes` references above keep the mounted-but-hidden subtree from
  // re-rendering on unrelated App commits.
  keepMounted: true,
  Provider: NotesFeatureProvider,
  renderPanes: () => notesPanes
};
