/**
 * Stable public facade for the Notes workspace hook.
 *
 * Runtime orchestration stays internal so consumers depend on one small API
 * boundary while the implementation is split without changing import paths.
 */
export { useNotesWorkspace } from "./notesWorkspaceRuntime";
export type { ResolvedHistoryLocation } from "./notesWorkspaceNavigationSupport";
export { resetImageImportRecoveryForTests } from "./notesImageImportRecovery";
export {
  authoritative,
  scopedActiveDelta,
  unwrapNotesMutation
} from "./notesWorkspaceProjection";
export {
  confirmedState,
  directMutationResult,
  duplicateRootId,
  expansionsOutsideSubtree,
  focusedUiUpdate,
  hasMoveDependencies,
  historyArguments,
  notifySuccess,
  projectNotesMutation,
  resolveRootLifecycleNavigation,
  rootIdForNode,
  runCompoundQueueWork,
  samePreparedMoveNode,
  workspaceForScope
} from "./notesWorkspaceCommandSupport";
export type {
  RawNotesMutationDelta,
  UnwrappedNotesMutation
} from "./notesWorkspaceProjection";
export type * from "./notesWorkspaceTypes";
export {
  isNotesDraftsFlushFailedError,
  NOTES_DRAFTS_FLUSH_FAILED_CODE
} from "./notesDraftErrors";
export {
  canonicalizeTagFilters,
  sameScope,
  tagFilterKey
} from "./notesWorkspaceScope";
