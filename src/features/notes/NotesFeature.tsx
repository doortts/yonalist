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
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import { useNotesFeedback } from "./NotesFeedbackContext";
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
  const { publish } = useNotesFeedback();
  const workspace = useNotesWorkspace({
    vaultRoot,
    repository: notesStore,
    attachmentUi: attachmentUi ?? contextAttachmentUi,
    publishFeedback: publish
  });

  useFlushDraftsOnWindowClose(workspace.actions.flushAllDrafts);

  return (
    <NotesActionsContext.Provider value={workspace.actionsSlice}>
      <NotesStateContext.Provider value={workspace.stateSlice}>
        <NotesDraftsContext.Provider value={workspace.draftsSlice}>
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
  const vaultRoot = useContext(VaultRootContext);
  const resolvedAttachmentUi = attachmentUi ?? nativeNotesAttachmentUi;
  return (
    <NotesAttachmentUiContext.Provider value={resolvedAttachmentUi}>
      <NotesImageResidencyProvider scopeKey={vaultRoot}>
        <NotesWorkspaceProvider>{children}</NotesWorkspaceProvider>
      </NotesImageResidencyProvider>
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
