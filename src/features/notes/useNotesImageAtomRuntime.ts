import { useCallback, useRef } from "react";
import type {
  NoteId,
  NotesStore,
  NotesWorkspaceScope
} from "../../domain/notes";
import {
  capturedImageAtomAuthority,
  imageAtomAuthorityMatches,
  type CapturedImageAtomAuthority
} from "./notesImageAtomAuthority";
import {
  createNotesImageAtomEditorRegistry,
  type ActiveImageAtomEditor,
  type ImageAtomEditorSelectionAuthority,
  type NotesImageAtomEditorAuthority
} from "./notesImageAtomEditorRegistry";
import type { NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { cloneWorkspaceScope } from "./notesWorkspaceNavigationSupport";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import type {
  NotesImageAtomCutAuthority,
  NotesImageAtomPasteAuthority
} from "./notesWorkspaceTypes";

export function useNotesImageAtomEditorRuntime(
  repository: NotesStore,
  vaultRoot: string
) {
  const runtimeRef = useRef({
    repository,
    vaultRoot,
    registry: createNotesImageAtomEditorRegistry()
  });
  if (
    runtimeRef.current.repository !== repository ||
    runtimeRef.current.vaultRoot !== vaultRoot
  ) {
    runtimeRef.current = {
      repository,
      vaultRoot,
      registry: createNotesImageAtomEditorRegistry()
    };
  }
  const registry = runtimeRef.current.registry;
  return {
    registry,
    registerActiveEditor: useCallback(
      (editor: ActiveImageAtomEditor) => registry.register(editor),
      [registry]
    ),
    claimActivePaste: useCallback(
      (event: ClipboardEvent) => registry.claimPaste(event),
      [registry]
    )
  };
}

export function useNotesImageAtomAuthorityLifecycle(input: {
  readonly registry: ReturnType<typeof createNotesImageAtomEditorRegistry>;
  readonly vaultRootRef: { readonly current: string };
  readonly activeScopeRef: { readonly current: NotesWorkspaceScope };
  readonly generationRef: { readonly current: number };
  readonly sessionRef: {
    readonly current: NotesWorkspaceCoordinatorSession | null;
  };
  readonly sessionRecordRef: {
    readonly current: NotesWorkspaceSessionRecord | null;
  };
  readonly stateRef: { readonly current: NormalizedNotesWorkspace };
}) {
  const {
    registry,
    vaultRootRef,
    activeScopeRef,
    generationRef,
    sessionRef,
    sessionRecordRef,
    stateRef
  } = input;
  const captureActiveEditorAuthority = useCallback(
    (nodeId: NoteId, selection: ImageAtomEditorSelectionAuthority) =>
      registry.capturePasteAuthority(nodeId, selection),
    [registry]
  );
  const captureAuthority = useCallback(
    (
      nodeId: NoteId,
      editorAuthority: NotesImageAtomEditorAuthority
    ): CapturedImageAtomAuthority | null => {
      const record = sessionRecordRef.current;
      const session = sessionRef.current;
      const node = stateRef.current.nodesById[nodeId];
      const attachments =
        stateRef.current.attachmentsByNodeId?.[nodeId] ?? [];
      if (
        !record ||
        record.closing ||
        !session ||
        record.session !== session ||
        record.drafts.has(nodeId) ||
        !registry.isPasteAuthorityCurrent(editorAuthority) ||
        !node ||
        node.nodeKind !== "image" ||
        attachments.length !== 1
      ) {
        return null;
      }
      const attachment = attachments[0]!;
      const draft = record.drafts.get(nodeId);
      return {
        vaultRoot: vaultRootRef.current,
        scope: cloneWorkspaceScope(activeScopeRef.current),
        generation: generationRef.current,
        session,
        record,
        nodeId,
        nodeKind: node.nodeKind,
        nodeUpdatedAt: node.updatedAt,
        nodeTitle: node.title,
        nodeNote: node.note,
        nodeImageOffsetUtf16: node.imageOffsetUtf16,
        attachmentId: attachment.id,
        attachmentUpdatedAt: attachment.updatedAt,
        attachmentContentHash: attachment.contentHash,
        draftRevision: draft?.revision ?? null,
        draftTitle: draft?.title ?? node.title,
        draftNote: draft?.note ?? node.note,
        draftImageOffsetUtf16:
          draft?.imageOffsetUtf16 ?? node.imageOffsetUtf16,
        editorAuthority
      };
    },
    [
      activeScopeRef,
      generationRef,
      registry,
      sessionRecordRef,
      sessionRef,
      stateRef,
      vaultRootRef
    ]
  );
  return {
    captureActiveEditorAuthority,
    captureCutAuthority: useCallback(
      (nodeId: NoteId, authority: NotesImageAtomEditorAuthority) =>
        captureAuthority(
          nodeId,
          authority
        ) as unknown as NotesImageAtomCutAuthority | null,
      [captureAuthority]
    ),
    capturePasteAuthority: useCallback(
      (nodeId: NoteId, authority: NotesImageAtomEditorAuthority) =>
        captureAuthority(
          nodeId,
          authority
        ) as unknown as NotesImageAtomPasteAuthority | null,
      [captureAuthority]
    ),
    isPasteAuthorityCurrent: useCallback(
      (authority: NotesImageAtomPasteAuthority) =>
        registry.isPasteAuthorityCurrent(
          capturedImageAtomAuthority(authority).editorAuthority
        ) &&
        imageAtomAuthorityMatches(authority, {
          vaultRoot: vaultRootRef.current,
          scope: activeScopeRef.current,
          generation: generationRef.current,
          session: sessionRef.current,
          record: sessionRecordRef.current,
          workspace: stateRef.current
        }),
      [
        activeScopeRef,
        generationRef,
        registry,
        sessionRecordRef,
        sessionRef,
        stateRef,
        vaultRootRef
      ]
    )
  };
}
