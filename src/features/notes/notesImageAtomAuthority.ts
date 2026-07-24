import type {
  NoteId,
  NoteNode,
  NotesWorkspaceScope,
} from "../../domain/notes";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import type { NotesImageAtomEditorAuthority } from "./notesImageAtomEditorRegistry";
import type { NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import { sameScope } from "./notesWorkspaceScope";
import type {
  NotesImageAtomCutAuthority,
  NotesImageAtomPasteAuthority,
} from "./notesWorkspaceTypes";

export interface CapturedImageAtomAuthority {
  readonly vaultRoot: string;
  readonly scope: NotesWorkspaceScope;
  readonly generation: number;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly record: NotesWorkspaceSessionRecord;
  readonly nodeId: NoteId;
  readonly nodeKind: NoteNode["nodeKind"];
  readonly nodeUpdatedAt: string;
  readonly nodeTitle: string;
  readonly nodeNote: string;
  readonly nodeImageOffsetUtf16: number;
  readonly attachmentId: string;
  readonly attachmentUpdatedAt: string;
  readonly attachmentContentHash: string;
  readonly draftRevision: number | null;
  readonly draftTitle: string;
  readonly draftNote: string;
  readonly draftImageOffsetUtf16: number;
  readonly editorAuthority: NotesImageAtomEditorAuthority;
}

export type NotesImageAtomAuthority =
  NotesImageAtomCutAuthority | NotesImageAtomPasteAuthority;

export function capturedImageAtomAuthority(
  opaque: NotesImageAtomAuthority,
): CapturedImageAtomAuthority {
  return opaque as unknown as CapturedImageAtomAuthority;
}

export function imageAtomAuthorityMatches(
  opaque: NotesImageAtomAuthority,
  current: {
    readonly vaultRoot: string;
    readonly scope: NotesWorkspaceScope;
    readonly generation: number;
    readonly session: NotesWorkspaceCoordinatorSession | null;
    readonly record: NotesWorkspaceSessionRecord | null;
    readonly workspace: NormalizedNotesWorkspace;
  },
): boolean {
  const authority = capturedImageAtomAuthority(opaque);
  const { record } = current;
  const node = current.workspace.nodesById[authority.nodeId];
  const attachments =
    current.workspace.attachmentsByNodeId?.[authority.nodeId] ?? [];
  const attachment = attachments.length === 1 ? attachments[0]! : null;
  const draft = record?.drafts.get(authority.nodeId);
  return Boolean(
    record &&
    !record.closing &&
    record === authority.record &&
    current.session === authority.session &&
    record.session === authority.session &&
    current.vaultRoot === authority.vaultRoot &&
    sameScope(current.scope, authority.scope) &&
    current.generation === authority.generation &&
    node &&
    node.id === authority.nodeId &&
    node.nodeKind === authority.nodeKind &&
    node.updatedAt === authority.nodeUpdatedAt &&
    node.title === authority.nodeTitle &&
    node.note === authority.nodeNote &&
    node.imageOffsetUtf16 === authority.nodeImageOffsetUtf16 &&
    attachment &&
    attachment.id === authority.attachmentId &&
    attachment.updatedAt === authority.attachmentUpdatedAt &&
    attachment.contentHash === authority.attachmentContentHash &&
    (draft?.revision ?? null) === authority.draftRevision &&
    (draft?.title ?? node.title) === authority.draftTitle &&
    (draft?.note ?? node.note) === authority.draftNote &&
    (draft?.imageOffsetUtf16 ?? node.imageOffsetUtf16) ===
      authority.draftImageOffsetUtf16,
  );
}
