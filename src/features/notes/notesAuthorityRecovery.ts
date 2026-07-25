import type {
  NoteId,
  NoteMarkerKind,
  NotesHistoryContext,
  NotesHistoryStatus,
  NormalizedNotesWorkspace
} from "../../domain/notes";
import type { KeyboardInsertionPostcondition } from "./notesKeyboardInsertion";

export type NotesUnknownOutcomeExpectation =
  | {
      readonly kind: "structural";
      readonly sourceId: NoteId;
      readonly expectedNodeId: NoteId;
      readonly postcondition: KeyboardInsertionPostcondition;
      readonly historyContext: NotesHistoryContext;
    }
  | {
      readonly kind: "draft";
      readonly nodeId: NoteId;
      readonly expectedText: {
        readonly title: string;
        readonly note: string;
        readonly imageOffsetUtf16: number;
        readonly markerKind?: NoteMarkerKind;
        readonly markdownImageWidth?: number | null;
      };
      readonly historyContext: NotesHistoryContext;
    }
  | {
      readonly kind: "unclassified";
      readonly historyContext: NotesHistoryContext;
      readonly mutationCommitted?: true;
    };

export type NotesWriteAuthority =
  | { readonly kind: "known" }
  | { readonly kind: "recovering"; readonly generation: number }
  | { readonly kind: "unknown"; readonly error: string };

export function adoptNotesWriteAuthority(
  authority: NotesWriteAuthority,
  publish: (authority: NotesWriteAuthority) => void,
  drafts: {
    resumeAfterAuthorityRecovery(): void;
    pauseForAuthorityRecovery(): void;
  }
): void {
  publish(authority);
  if (authority.kind === "known") {
    drafts.resumeAfterAuthorityRecovery();
  } else {
    drafts.pauseForAuthorityRecovery();
  }
}

export type NotesUnknownOutcomeDecision =
  | {
      readonly kind: "committedAndCurrent";
      readonly workspace: NormalizedNotesWorkspace;
      readonly historyStatus: NotesHistoryStatus;
    }
  | {
      readonly kind: "committedWithoutHistoryProof";
      readonly workspace: NormalizedNotesWorkspace;
      readonly historyStatus?: NotesHistoryStatus;
    }
  | {
      readonly kind: "notProvenCommitted";
      readonly workspace: NormalizedNotesWorkspace;
      readonly historyStatus?: NotesHistoryStatus;
    }
  | { readonly kind: "authorityUnknown"; readonly error: string };

export type NotesUnknownOutcomeAuthority =
  | {
      readonly kind: "loaded";
      readonly workspace: NormalizedNotesWorkspace;
      readonly historyStatus?: NotesHistoryStatus;
    }
  | { readonly kind: "failed"; readonly error: unknown };

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : "Notes authority recovery failed.";
}

function orderedSiblingIds(
  workspace: NormalizedNotesWorkspace,
  parentId: NoteId | null
): NoteId[] {
  return workspace.nodes
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.sortKey - right.sortKey || left.id.localeCompare(right.id))
    .map((node) => node.id);
}

function structuralPostconditionMatches(
  expectation: Extract<
    NotesUnknownOutcomeExpectation,
    { readonly kind: "structural" }
  >,
  workspace: NormalizedNotesWorkspace
): boolean {
  const expected = workspace.nodes.find(
    (node) => node.id === expectation.expectedNodeId
  );
  const source = workspace.nodes.find(
    (node) => node.id === expectation.sourceId
  );
  if (!expected || !source) return false;

  const postcondition = expectation.postcondition;
  if (postcondition.kind === "first-child") {
    return (
      expected.parentId === postcondition.expectedParentId &&
      orderedSiblingIds(workspace, postcondition.expectedParentId)[
        postcondition.expectedIndex
      ] === expected.id &&
      expected.title === postcondition.expectedInsertedTitle
    );
  }

  const siblings = orderedSiblingIds(workspace, expected.parentId);
  const sourceIndex = siblings.indexOf(source.id);
  return (
    source.parentId === expected.parentId &&
    sourceIndex >= 0 &&
    siblings[sourceIndex + 1] === expected.id &&
    source.title === postcondition.expectedSourceTitle &&
    expected.title === postcondition.expectedInsertedTitle
  );
}

function draftPostconditionMatches(
  expectation: Extract<
    NotesUnknownOutcomeExpectation,
    { readonly kind: "draft" }
  >,
  workspace: NormalizedNotesWorkspace
): boolean {
  const node = workspace.nodes.find((candidate) => candidate.id === expectation.nodeId);
  const expected = expectation.expectedText;
  return (
    node !== undefined &&
    node.title === expected.title &&
    node.note === expected.note &&
    node.imageOffsetUtf16 === expected.imageOffsetUtf16 &&
    (expected.markerKind === undefined ||
      node.markerKind === expected.markerKind) &&
    (expected.markdownImageWidth === undefined ||
      node.markdownImageWidth === expected.markdownImageWidth)
  );
}

function historyMatches(
  historyContext: NotesHistoryContext,
  historyStatus: NotesHistoryStatus | undefined
): historyStatus is NotesHistoryStatus {
  return (
    historyStatus?.historyEpoch === historyContext.historyEpoch &&
    historyStatus.canUndo &&
    !historyStatus.canRedo &&
    historyStatus.nextUndoEntryId === historyContext.entryId &&
    historyStatus.nextRedoEntryId === null
  );
}

export function recoverUnknownOutcome(input: {
  readonly expectation: NotesUnknownOutcomeExpectation;
  readonly authority: NotesUnknownOutcomeAuthority;
}): NotesUnknownOutcomeDecision {
  const { expectation, authority } = input;
  if (authority.kind === "failed") {
    return { kind: "authorityUnknown", error: errorMessage(authority.error) };
  }

  const postconditionMatches =
    expectation.kind === "structural"
      ? structuralPostconditionMatches(expectation, authority.workspace)
      : expectation.kind === "draft"
        ? draftPostconditionMatches(expectation, authority.workspace)
        : false;
  if (!postconditionMatches) {
    return {
      kind: "notProvenCommitted",
      workspace: authority.workspace,
      ...(authority.historyStatus
        ? { historyStatus: authority.historyStatus }
        : {})
    };
  }
  if (!historyMatches(expectation.historyContext, authority.historyStatus)) {
    return {
      kind: "committedWithoutHistoryProof",
      workspace: authority.workspace,
      ...(authority.historyStatus
        ? { historyStatus: authority.historyStatus }
        : {})
    };
  }
  return {
    kind: "committedAndCurrent",
    workspace: authority.workspace,
    historyStatus: authority.historyStatus
  };
}
