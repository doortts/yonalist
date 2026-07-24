import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import {
  ExternalSourcesContext,
  type ExternalSourcesBoundary,
} from "../../ExternalSourcesContext";
import {
  GITHUB_EXTERNAL_KEY_PROVIDER,
  GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
  GITHUB_NOTIFICATIONS_ROOT_ID,
} from "../../services/githubNotificationsProvider";
import type {
  ExternalBullet,
  ExternalSourceAvailability,
} from "../../domain/externalSources";
import type {
  ApplyNotesBatchInput,
  CreateNoteNodeInput,
  MaterializeGithubNotificationInput,
  MoveNoteNodeInput,
  NoteAttachment,
  NoteAttachmentsByNodeId,
  NoteId,
  NoteNode,
  NoteNodeKind,
  NoteSearchResult,
  NotesHistoryContext,
  NotesHistoryState,
  NotesWorkspace,
  UpdateNoteNodeInput,
} from "../../domain/notes";

const notesStoreMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  historyStatus: vi.fn(),
  prepareNavigation: vi.fn(),
  pruneHistoryEntries: vi.fn(),
  closeHistorySession: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  loadWorkspace: vi.fn(),
  createNode: vi.fn(),
  materializeGithubNotificationAndCreateSibling: vi.fn(),
  materializeGithubNotificationAndReparent: vi.fn(),
  refreshMaterializedGithubNotifications: vi.fn(),
  markMaterializedGithubNotificationRead: vi.fn(),
  setGithubGroupCollapsed: vi.fn(),
  deleteNodes: vi.fn(),
  updateNode: vi.fn(),
  setReadonly: vi.fn(),
  splitNode: vi.fn(),
  moveNode: vi.fn(),
  applyBatch: vi.fn(),
  toggleComplete: vi.fn(),
  toggleCollapsed: vi.fn(),
  toggleStar: vi.fn(),
  duplicateNode: vi.fn(),
  removeEmptyNode: vi.fn(),
  softDeleteNode: vi.fn(),
  restoreNode: vi.fn(),
  archiveNode: vi.fn(),
  unarchiveNode: vi.fn(),
  importAttachmentPaths: vi.fn(),
  importImageNodePaths: vi.fn(),
  importImageNodeBytes: vi.fn(),
  readAttachmentBytes: vi.fn(),
  resizeAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  emptyTrash: vi.fn(),
  search: vi.fn(),
  searchStructured: vi.fn(),
  listTags: vi.fn(),
  listTagsWithCounts: vi.fn(),
  deleteDatabase: vi.fn(),
}));

vi.mock("../../services/notesStore", () => ({ notesStore: notesStoreMock }));

import { NotesFeatureProvider } from "./NotesFeature";
import {
  NotesFeedbackProvider,
  NotesStatusBarMessage,
} from "./NotesFeedbackContext";
import type { NotesAttachmentUiBoundary } from "./notesAttachmentController";
import { NotesLibraryPane } from "./NotesLibraryPane";
import { NotesOutlinePane } from "./NotesOutlinePane";
import { NotesDateTodayProvider } from "./NotesDatePickerIntegration";
import { NotesImageResidencyProvider } from "./NotesImageResidencyContext";
import { NotesWorkspaceContext } from "./NotesWorkspaceContext";
import type { NotesProjectionPublication } from "./notesWorkspaceTypes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";
import {
  isOutlineSelectionInteractiveTarget,
  isOutlineSelectionTextSurface,
} from "./OutlineNodeRow";
import {
  readImageAtomDomSelection,
  writeImageAtomDomSelection,
} from "./imageAtomDomSelection";

const notesStyles = readFileSync(
  join(process.cwd(), "src/features/notes/notes.css"),
  "utf8",
);
const appStyles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function mockNarrowViewport(narrow: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 720px)" ? narrow : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
}

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null,
  };
}

type KindAwareSearchResult = NoteSearchResult & {
  readonly nodeKind: NoteNodeKind;
  readonly parentTrailKinds: NoteNodeKind[];
};

function searchResult(
  overrides: Partial<KindAwareSearchResult> & Pick<NoteSearchResult, "nodeId">,
): KindAwareSearchResult {
  const parentTrail = overrides.parentTrail ?? [];
  return {
    title: overrides.nodeId,
    nodeKind: "text",
    imageOffsetUtf16: 0,
    attachmentName: null,
    displayLabel: overrides.title ?? overrides.nodeId,
    parentTrail,
    parentTrailKinds: parentTrail.map(() => "text"),
    matchedField: "title",
    ...overrides,
  };
}

function initialNodes(): NoteNode[] {
  return [
    node({
      id: "project",
      sortKey: 1,
      title: "Project",
      note: "Project note",
    }),
    node({
      id: "plan",
      parentId: "project",
      sortKey: 1,
      title: "Plan",
    }),
    node({
      id: "milestone",
      parentId: "plan",
      sortKey: 1,
      title: "Milestone",
    }),
    node({ id: "outside", sortKey: 2, title: "Outside branch" }),
  ];
}

let confirmedAttachmentsByNodeId: NoteAttachmentsByNodeId = {};

function workspace(
  nodes: NoteNode[],
  attachmentsByNodeId: NoteAttachmentsByNodeId = confirmedAttachmentsByNodeId,
): NotesWorkspace {
  return {
    nodes: nodes.map((current) => ({ ...current })),
    attachmentsByNodeId: Object.fromEntries(
      Object.entries(attachmentsByNodeId).map(([nodeId, attachments]) => [
        nodeId,
        attachments.map((attachment) => ({ ...attachment })),
      ]),
    ),
  };
}

function historyState(
  overrides: Partial<NotesHistoryState> = {},
): NotesHistoryState {
  return {
    canUndo: false,
    canRedo: false,
    historyEpoch: "history-epoch",
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: [],
    ...overrides,
  };
}

function historyContextMatcher() {
  return expect.objectContaining({
    sessionId: expect.stringMatching(/\S/),
    historyEpoch: expect.stringMatching(/\S/),
    entryId: expect.stringMatching(/\S/),
    commandKind: expect.stringMatching(/\S/),
  });
}

function attachment(
  overrides: Partial<NoteAttachment> & Pick<NoteAttachment, "id" | "nodeId">,
): NoteAttachment {
  const contentHash = overrides.contentHash ?? "a".repeat(64);
  return {
    sortKey: 1024,
    relativePath: `notes-assets/${contentHash}.png`,
    contentHash,
    originalName: `${overrides.id}.png`,
    mimeType: "image/png",
    byteSize: 4,
    intrinsicWidth: 640,
    intrinsicHeight: 320,
    displayWidth: 320,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let confirmedNodes: NoteNode[];
const latestMutationEntryBySessionId = new Map<string, string>();

function isHistoryContext(value: unknown): value is NotesHistoryContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotesHistoryContext>;
  return (
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    typeof candidate.historyEpoch === "string" &&
    candidate.historyEpoch.length > 0 &&
    typeof candidate.entryId === "string" &&
    candidate.entryId.length > 0 &&
    typeof candidate.commandKind === "string" &&
    candidate.commandKind.length > 0
  );
}

function acknowledgedDefaultMutation<Args extends unknown[], Result>(
  implementation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const result = await implementation(...args);
    const context = args.at(-1);
    if (isHistoryContext(context)) {
      const resultRecord =
        typeof result === "object" && result !== null
          ? (result as Record<string, unknown>)
          : null;
      const hasHistoryEntryId =
        resultRecord !== null &&
        Object.prototype.hasOwnProperty.call(resultRecord, "historyEntryId");
      const historyEntryId = resultRecord?.historyEntryId;
      if (typeof historyEntryId === "string") {
        latestMutationEntryBySessionId.set(context.sessionId, historyEntryId);
      } else if (!hasHistoryEntryId) {
        latestMutationEntryBySessionId.set(context.sessionId, context.entryId);
      }
    }
    return result;
  };
}

function fixtureHistoryState(sessionId: string): NotesHistoryState {
  const entryId = latestMutationEntryBySessionId.get(sessionId) ?? null;
  return historyState({
    canUndo: entryId !== null,
    nextUndoEntryId: entryId,
  });
}

function configureRepository(
  nodes: NoteNode[] = initialNodes(),
  attachmentsByNodeId: NoteAttachmentsByNodeId = {},
): void {
  confirmedNodes = nodes;
  confirmedAttachmentsByNodeId = attachmentsByNodeId;
  latestMutationEntryBySessionId.clear();
  for (const method of Object.values(notesStoreMock)) {
    method.mockReset();
  }

  notesStoreMock.initialize.mockResolvedValue(historyState());
  notesStoreMock.historyStatus.mockImplementation(
    async (_vaultRoot: string, sessionId: string) =>
      fixtureHistoryState(sessionId),
  );
  notesStoreMock.prepareNavigation.mockImplementation(
    async (_vaultRoot: string, input: { sessionId: string }) =>
      fixtureHistoryState(input.sessionId),
  );
  notesStoreMock.pruneHistoryEntries.mockResolvedValue(historyState());
  notesStoreMock.closeHistorySession.mockResolvedValue(undefined);
  notesStoreMock.undo.mockResolvedValue({
    kind: "entryMissing",
    ...historyState(),
  });
  notesStoreMock.redo.mockResolvedValue({
    kind: "entryMissing",
    ...historyState(),
  });
  notesStoreMock.loadWorkspace.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.createNode.mockImplementation(
    async (_vaultRoot: string, input: CreateNoteNodeInput) => {
      confirmedNodes = [
        ...confirmedNodes,
        node({
          id: input.id,
          parentId: input.parentId,
          sortKey:
            Math.max(0, ...confirmedNodes.map((current) => current.sortKey)) +
            1,
          title: input.title,
          note: input.note,
        }),
      ];
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.updateNode.mockImplementation(
    async (_vaultRoot: string, input: UpdateNoteNodeInput) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === input.id
          ? { ...current, title: input.title, note: input.note }
          : current,
      );
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.setReadonly.mockImplementation(
    async (
      _vaultRoot: string,
      input: { nodeId: NoteId; isReadonly: boolean },
    ) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === input.nodeId
          ? { ...current, isReadonly: input.isReadonly }
          : current,
      );
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.materializeGithubNotificationAndCreateSibling.mockImplementation(
    async (_vaultRoot: string, input: MaterializeGithubNotificationInput) => {
      const date =
        confirmedNodes.find(
          (current) =>
            current.pluginMeta?.kind === "date" &&
            current.pluginMeta.dateKey === input.snapshot.dateKey,
        ) ??
        node({
          id: `date-${input.snapshot.dateKey}`,
          parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
          sortKey: 1,
          title: input.snapshot.dateKey,
          isReadonly: undefined,
          pluginMeta: { kind: "date", dateKey: input.snapshot.dateKey },
        });
      const notification =
        confirmedNodes.find(
          (current) =>
            current.pluginMeta?.kind === "notification" &&
            current.pluginMeta.notificationKey ===
              input.snapshot.notificationKey,
        ) ??
        node({
          id: `notification-${input.snapshot.dateKey}`,
          parentId: date.id,
          sortKey: 1,
          title: input.snapshot.title,
          note: input.snapshot.note,
          isReadonly: undefined,
          pluginMeta: {
            kind: "notification",
            notificationKey: input.snapshot.notificationKey,
            notificationType: input.snapshot.notificationType,
            url: input.snapshot.url,
            updatedAt: input.snapshot.updatedAt,
            unread: input.snapshot.unread,
          },
        });
      const byId = new Set(confirmedNodes.map((current) => current.id));
      const newNodes: NoteNode[] =
        input.target.kind === "sibling"
          ? [
              node({
                id: input.target.siblingId,
                parentId: date.id,
                sortKey: notification.sortKey + 1,
                title: "",
              }),
            ]
          : input.target.nodes.map((imported, index) =>
              node({
                id: `imported-${index}`,
                parentId: notification.id,
                sortKey: index + 1,
                title: imported.title,
                note: imported.note ?? "",
              }),
            );
      confirmedNodes = [
        ...confirmedNodes,
        ...(byId.has(date.id) ? [] : [date]),
        ...(byId.has(notification.id) ? [] : [notification]),
        ...newNodes,
      ];
      return input.target.kind === "children"
        ? {
            workspace: workspace(confirmedNodes),
            ...historyState(),
            historyEntryId: null,
            importedRootIds: newNodes.map(({ id }) => id),
          }
        : workspace(confirmedNodes);
    },
  );
  notesStoreMock.refreshMaterializedGithubNotifications.mockImplementation(
    async () => workspace(confirmedNodes),
  );
  notesStoreMock.markMaterializedGithubNotificationRead.mockImplementation(
    async (
      _vaultRoot: string,
      input: { notificationKey: string; updatedAt: string },
    ) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.pluginMeta?.kind === "notification" &&
        current.pluginMeta.notificationKey === input.notificationKey
          ? {
              ...current,
              pluginMeta: { ...current.pluginMeta, unread: false },
            }
          : current,
      );
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.setGithubGroupCollapsed.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.deleteNodes.mockImplementation(
    async (_vaultRoot: string, input: { nodeIds: readonly NoteId[] }) => {
      const ids = new Set(input.nodeIds);
      confirmedNodes = confirmedNodes.filter((current) => !ids.has(current.id));
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.toggleCollapsed.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === nodeId
          ? { ...current, isCollapsed: !current.isCollapsed }
          : current,
      );
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.toggleComplete.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === nodeId
          ? {
              ...current,
              completedAt:
                current.completedAt === null ? "2026-07-10T01:00:00Z" : null,
            }
          : current,
      );
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.toggleStar.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === nodeId
          ? { ...current, isStarred: !current.isStarred }
          : current,
      );
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.duplicateNode.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      const source = confirmedNodes.find((current) => current.id === nodeId);
      if (source) {
        confirmedNodes = [
          ...confirmedNodes,
          {
            ...source,
            id: `${source.id}-copy`,
            sortKey: source.sortKey + 0.5,
            title: `${source.title} copy`,
          },
        ];
      }
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.removeEmptyNode.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.softDeleteNode.mockImplementation(
    async (_vaultRoot: string, nodeId: NoteId) => {
      confirmedNodes = confirmedNodes.filter(
        (current) => current.id !== nodeId,
      );
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.restoreNode.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.archiveNode.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.unarchiveNode.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.importAttachmentPaths.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.importImageNodePaths.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.importImageNodeBytes.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.readAttachmentBytes.mockRejectedValue(
    new Error("Attachment bytes are unavailable"),
  );
  notesStoreMock.resizeAttachment.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.removeAttachment.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.splitNode.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.moveNode.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.applyBatch.mockImplementation(
    async (_vaultRoot: string, input: ApplyNotesBatchInput) => {
      const ids = new Set(input.nodeIds);
      if (input.op === "complete") {
        confirmedNodes = confirmedNodes.map((current) =>
          ids.has(current.id)
            ? {
                ...current,
                completedAt: input.completed ? "2026-07-10T01:00:00Z" : null,
              }
            : current,
        );
      } else if (input.op === "delete") {
        confirmedNodes = confirmedNodes.filter(
          (current) => !ids.has(current.id),
        );
      }
      // indent/outdent/move batch semantics are covered by the keyboard
      // resolution tests; the integration harness only needs completion and
      // deletion to reflect in the rendered tree.
      return workspace(confirmedNodes);
    },
  );
  notesStoreMock.emptyTrash.mockImplementation(async () =>
    workspace(confirmedNodes),
  );
  notesStoreMock.search.mockResolvedValue([]);
  notesStoreMock.searchStructured.mockResolvedValue([]);
  notesStoreMock.listTags.mockResolvedValue([]);
  notesStoreMock.listTagsWithCounts.mockResolvedValue([]);
  notesStoreMock.deleteDatabase.mockResolvedValue({
    attachmentCleanupFailed: false,
  });
  const defaultMutationMethods = [
    "createNode",
    "materializeGithubNotificationAndCreateSibling",
    "materializeGithubNotificationAndReparent",
    "setGithubGroupCollapsed",
    "deleteNodes",
    "updateNode",
    "setReadonly",
    "splitNode",
    "moveNode",
    "applyBatch",
    "toggleComplete",
    "toggleCollapsed",
    "toggleStar",
    "duplicateNode",
    "removeEmptyNode",
    "softDeleteNode",
    "restoreNode",
    "archiveNode",
    "unarchiveNode",
    "importAttachmentPaths",
    "importImageNodePaths",
    "importImageNodeBytes",
    "resizeAttachment",
    "removeAttachment",
  ] as const;
  for (const methodName of defaultMutationMethods) {
    const method = notesStoreMock[methodName];
    const implementation = method.getMockImplementation();
    if (implementation) {
      method.mockImplementation(acknowledgedDefaultMutation(implementation));
    }
  }
}

function enableReadonlyDeletePreflight(
  readonlyDescendantIds: readonly NoteId[],
) {
  const deleteNodes = vi.fn().mockResolvedValue({
    readonlyDescendantIds: [...readonlyDescendantIds],
  });
  Reflect.set(notesStoreMock, "deleteNodes", deleteNodes);
  return deleteNodes;
}

function notesWorkspaceElement(
  attachmentUi?: NotesAttachmentUiBoundary,
  today?: { year: number; month: number; day: number },
  externalSources?: ExternalSourcesBoundary,
) {
  const feature = (
    <NotesFeatureProvider attachmentUi={attachmentUi}>
      <NotesLibraryPane />
      <NotesOutlinePane />
    </NotesFeatureProvider>
  );
  const featureWithSources = (
    <ExternalSourcesContext.Provider
      value={externalSources ?? githubSources([], "disconnected")}
    >
      {feature}
    </ExternalSourcesContext.Provider>
  );
  return (
    <StrictMode>
      <NotesFeedbackProvider active>
        <VaultRootContext.Provider value="/vault">
          {today ? (
            <NotesDateTodayProvider today={today}>
              {featureWithSources}
            </NotesDateTodayProvider>
          ) : (
            featureWithSources
          )}
        </VaultRootContext.Provider>
        <div className="statusbar-feedback" aria-label="Status bar feedback">
          <NotesStatusBarMessage />
        </div>
      </NotesFeedbackProvider>
    </StrictMode>
  );
}

function renderNotesWorkspace(
  attachmentUi?: NotesAttachmentUiBoundary,
  today?: { year: number; month: number; day: number },
  externalSources?: ExternalSourcesBoundary,
) {
  return render(
    notesWorkspaceElement(attachmentUi, today, externalSources),
  );
}

function githubSources(
  items: readonly ExternalBullet[],
  availability: ExternalSourceAvailability = "online",
): ExternalSourcesBoundary {
  return {
    pages: [
      {
        providerId: "github-notifications",
        connectionId: items[0]?.key.connectionId ?? null,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        availability,
        items,
        loaded: true,
        loading: false,
        error: null,
        syncedAt: "2026-07-22T12:00:00Z",
        completingKeys: new Set(),
        completionErrors: {},
      },
    ],
    refresh: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    openDetails: vi.fn(),
  };
}

function rowReplayWorkspace(
  keyboardInsertionInteractionEpoch?: number,
): UseNotesWorkspaceResult & {
  pendingPrimarySelection: {
    requestId: number;
    nodeId: string;
    field: "title";
    selection: { anchorUtf16: number; focusUtf16: number };
  };
} {
  const state = normalizeWorkspace({
    nodes: [node({ id: "row", title: "abcdef" })],
  });
  state.pendingFocusId = "row";
  state.pendingFocusField = "title";
  const noOp = vi.fn().mockResolvedValue(undefined);
  const acknowledgeFocus = vi.fn().mockResolvedValue(undefined);
  const actions = new Proxy<Record<string, typeof noOp>>(
    {},
    {
      get: (_target, property) =>
        property === "pendingKeyboardInsertionInteractionEpoch"
          ? () => keyboardInsertionInteractionEpoch
          : property === "acknowledgeFocus"
            ? acknowledgeFocus
            : noOp,
    },
  ) as unknown as UseNotesWorkspaceResult["actions"];
  return {
    state,
    actions,
    deletingNotesData: false,
    libraryView: "all",
    activeTagFilters: [],
    tagSummaries: [],
    locallyExpandedNodeIds: new Set(),
    draftsByNodeId: {},
    writeError: null,
    status: "ready",
    loading: false,
    error: null,
    pendingPrimarySelection: {
      requestId: 31,
      nodeId: "row",
      field: "title",
      selection: { anchorUtf16: 5, focusUtf16: 1 },
    },
  } as unknown as UseNotesWorkspaceResult & {
    pendingPrimarySelection: {
      requestId: number;
      nodeId: string;
      field: "title";
      selection: { anchorUtf16: number; focusUtf16: number };
    };
  };
}

function signatureMismatchInsertionWorkspace(
  visibleSignature = "different-visible-projection",
): UseNotesWorkspaceResult {
  const state = normalizeWorkspace({
    nodes: [node({ id: "row", title: "inserted" })],
  });
  state.pendingFocusId = "row";
  state.pendingFocusField = "title";
  const noOp = vi.fn().mockResolvedValue(undefined);
  const acknowledgeFocus = vi.fn().mockResolvedValue(undefined);
  const consumeInsertionMotion = vi.fn(
    (intentToken: number, cancelFocusNodeId?: NoteId) => {
      if (intentToken === 7 && cancelFocusNodeId === "row") {
        // The real action dispatches a reducer update; it cannot mutate the
        // already-committed state snapshot read by this row's passive effect.
        queueMicrotask(() => {
          state.pendingFocusId = null;
          state.pendingFocusField = null;
        });
      }
    },
  );
  const actions = new Proxy<Record<string, typeof noOp>>(
    {},
    {
      get: (_target, property) =>
        property === "pendingKeyboardInsertionInteractionEpoch"
          ? () => 0
          : property === "acknowledgeFocus"
            ? acknowledgeFocus
            : property === "consumeInsertionMotion"
              ? consumeInsertionMotion
              : noOp,
    },
  ) as unknown as UseNotesWorkspaceResult["actions"];
  const projectionPublication = {
    projectionGeneration: 24,
    layoutGeneration: 13,
    owner: { kind: "keyboard-insertion", intentToken: 7 },
    visibleSignature,
    keyboardInsertionDisposition: {
      kind: "exact",
      pending: {
        intent: {
          token: 7,
          ownerSessionGeneration: 3,
          sourceId: "source",
          expectedNodeId: "row",
          postcondition: {
            kind: "split",
            expectedSourceTitle: "before",
            expectedInsertedTitle: "inserted",
          },
        },
        ownerSessionId: "session-a",
        ownerPaneId: "pane-a",
        interactionEpochAtDispatch: 0,
        expectedStructuralHistoryEpoch: "history-epoch",
        expectedStructuralHistoryEntryId: "history-entry",
        projectionGenerationAtDispatch: 20,
        layoutGenerationAtDispatch: 9,
        paneSnapshotAtDispatch: {
          paneId: "pane-a",
          sessionId: "session-a",
          scope: { kind: "active" },
          zoomedNodeId: null,
          showCompleted: true,
          collapsedNodeIds: new Set(),
          locallyExpandedNodeIds: new Set(),
          interactionEpoch: 0,
          visibleSignature: "before",
          geometryGeneration: 4,
          activeDrag: false,
        },
        dragGenerationAtDispatch: 0,
      },
      settlement: {
        intentToken: 7,
        expectedNodeId: "row",
        ownerSessionId: "session-a",
        ownerPaneId: "pane-a",
        ownerSessionGeneration: 3,
        interactionEpochAtDispatch: 0,
        baseProjectionGeneration: 20,
        acceptedProjectionGeneration: 24,
        baseLayoutGeneration: 9,
        acceptedLayoutGeneration: 13,
        authorityOutcome: "postconditionAccepted",
        focusEligible: true,
      },
    },
  } satisfies NotesProjectionPublication;
  return {
    state,
    actions,
    deletingNotesData: false,
    libraryView: "all",
    activeTagFilters: [],
    tagSummaries: [],
    locallyExpandedNodeIds: new Set(),
    draftsByNodeId: {},
    writeError: null,
    status: "ready",
    loading: false,
    error: null,
    projectionPublication,
  } as unknown as UseNotesWorkspaceResult;
}

function queryTitleInput(value: string): HTMLTextAreaElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[aria-label="Edit node title"]',
      ),
    ).find(
      (input) => input.value === value || input.value.trim() === value.trim(),
    ) ?? null
  );
}

function getTitleInput(value: string): HTMLTextAreaElement {
  const input = queryTitleInput(value);
  if (!input) {
    throw new Error(`Unable to find a node title input with value ${value}`);
  }
  fireEvent.focus(input);
  return input;
}

function getTitlePresentation(value: string): HTMLElement {
  const input = queryTitleInput(value);
  const row = input?.closest<HTMLElement>(".notes-node");
  if (!row) {
    throw new Error(`Unable to find a node title presentation for ${value}`);
  }
  return within(row).getByRole("group", { name: "Edit node title" });
}

async function findTitleInput(value: string): Promise<HTMLTextAreaElement> {
  return waitFor(() => getTitleInput(value));
}

async function activatePageTitle(): Promise<HTMLTextAreaElement> {
  const activeTitle = screen.queryByRole<HTMLTextAreaElement>("textbox", {
    name: "Edit page title",
  });
  if (activeTitle) return activeTitle;
  fireEvent.pointerDown(screen.getByRole("group", { name: "Edit page title" }));
  return screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Edit page title",
  });
}

function textareasByName(name: string): HTMLTextAreaElement[] {
  return Array.from(
    document.querySelectorAll<HTMLTextAreaElement>("textarea"),
  ).filter((textarea) => textarea.getAttribute("aria-label") === name);
}

function queryTextareaByName(name: string): HTMLTextAreaElement | null {
  return textareasByName(name)[0] ?? null;
}

function getTextareaByName(name: string): HTMLTextAreaElement {
  const textarea = queryTextareaByName(name);
  if (!textarea) {
    throw new Error(`Unable to find a textarea named ${name}`);
  }
  fireEvent.focus(textarea);
  return textarea;
}

async function findTextareaByName(name: string): Promise<HTMLTextAreaElement> {
  return waitFor(() => getTextareaByName(name));
}

async function openNodeMenu(label: string, user = userEvent.setup()) {
  await user.click(
    await screen.findByRole("button", { name: `More actions for ${label}` }),
  );
  return screen.findByRole("menu");
}

function dispatchClipboardEvent(
  kind: "copy" | "cut",
  target: Element,
  order?: string[],
) {
  const values = new Map<string, string>();
  const setData = vi.fn((type: string, value: string) => {
    order?.push(type);
    values.set(type, value);
  });
  const clipboardData = { setData } as unknown as DataTransfer;
  const event =
    kind === "copy"
      ? createEvent.copy(target, {
          bubbles: true,
          cancelable: true,
          clipboardData,
        })
      : createEvent.cut(target, {
          bubbles: true,
          cancelable: true,
          clipboardData,
        });
  fireEvent(target, event);
  return { event, setData, values };
}

function installNavigatorClipboard(clipboard: {
  write?: (items: ClipboardItem[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}): () => void {
  const original = Object.getOwnPropertyDescriptor(
    window.navigator,
    "clipboard",
  );
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, "clipboard", original);
    } else {
      Reflect.deleteProperty(window.navigator, "clipboard");
    }
  };
}

function selectedOutlineIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-outline-id][data-range-selected="true"]',
    ),
  ).map((row) => row.dataset.outlineId ?? "");
}

function mockOutlineRowRects() {
  const rectangle = (top: number, left = 0, width = 640, height = 28) =>
    ({
      x: left,
      y: top,
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;

  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const row = this.closest<HTMLElement>(".notes-node");
      if (!row) {
        return rectangle(0);
      }
      const rows = Array.from(document.querySelectorAll(".notes-node"));
      return rectangle(rows.indexOf(row) * 28);
    });
}

function mockNotesContentWidth(width: number, viewportWidth = 900): void {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const measuredWidth = this.classList.contains("notes-outline-content")
        ? width
        : 0;
      return {
        x: 0,
        y: 0,
        top: 0,
        right: measuredWidth,
        bottom: 0,
        left: 0,
        width: measuredWidth,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

describe("Notes workspace", () => {
  beforeEach(() => {
    mockNarrowViewport(false);
    configureRepository();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  it("uses the vault root and mocked repository without a Tauri runtime", async () => {
    renderNotesWorkspace();

    expect(await findTitleInput("Project")).toBeInTheDocument();
    expect(notesStoreMock.initialize).toHaveBeenCalledOnce();
    expect(notesStoreMock.initialize).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
      kind: "active",
    });
    expect("__TAURI_INTERNALS__" in window).toBe(false);
  });

  it("moves the caret between rows via direct DOM focus in the same frame (plan Track T1)", async () => {
    renderNotesWorkspace();

    const project = await findTitleInput("Project");
    const plan = queryTitleInput("Plan")!;
    const milestone = queryTitleInput("Milestone")!;

    // ArrowDown focuses the next row's title editor synchronously — no reducer
    // round trip, no re-render between presses.
    project.setSelectionRange(0, 0);
    fireEvent.keyDown(project, { key: "ArrowDown" });
    expect(document.activeElement).toBe(plan);

    // ArrowRight from the end of a title lands the caret at the start of the next.
    plan.setSelectionRange(plan.value.length, plan.value.length);
    fireEvent.keyDown(plan, { key: "ArrowRight" });
    expect(document.activeElement).toBe(milestone);
    expect(milestone.selectionStart).toBe(0);
    expect(milestone.selectionEnd).toBe(0);

    // ArrowLeft from the start of a title lands the caret at the end of the prior.
    milestone.setSelectionRange(0, 0);
    fireEvent.keyDown(milestone, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(plan);
    expect(plan.selectionStart).toBe(plan.value.length);
    expect(plan.selectionEnd).toBe(plan.value.length);

    fireEvent.keyDown(plan, { key: "ArrowUp" });
    expect(document.activeElement).toBe(project);
  });

  it("renders bullet Markdown while preserving its exact source for editing", async () => {
    const source = "> Read [guide](https://example.com)";
    configureRepository([node({ id: "markdown", title: source })]);
    renderNotesWorkspace();

    await waitFor(() => expect(queryTitleInput(source)).not.toBeNull());
    const presentation = getTitlePresentation(source);
    const field = presentation.closest(".notes-node-title-field");
    expect(field).toHaveAttribute("data-markdown-block", "quote");
    expect(presentation).toHaveTextContent("Read guide");
    expect(presentation).not.toHaveTextContent("> ");
    expect(
      within(presentation).getByRole("button", { name: "Open link guide" }),
    ).toBeInTheDocument();

    const textarea = getTitleInput(source);
    expect(presentation).toHaveTextContent(source, {
      normalizeWhitespace: false,
    });
    expect(textarea).toHaveValue(source);
  });

  it("renders, edits, and persists resize for a remote Markdown image bullet", async () => {
    const source = "![Quarterly chart](https://example.com/chart.png)";
    const getBoundingClientRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        width: 500,
        height: 0,
        top: 0,
        right: 500,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      });
    configureRepository([
      node({ id: "markdown-image", title: source, markdownImageWidth: 360 }),
    ]);

    try {
      renderNotesWorkspace();
      await waitFor(() => expect(queryTitleInput(source)).not.toBeNull());
      const loadingImage = await waitFor(() => {
        const image = document.querySelector("img");
        expect(image).not.toBeNull();
        return image!;
      });
      Object.defineProperties(loadingImage, {
        naturalWidth: { configurable: true, value: 720 },
        naturalHeight: { configurable: true, value: 360 },
      });
      fireEvent.load(loadingImage);

      const image = screen.getByRole("img", { name: "Quarterly chart" });
      expect(image).toBeVisible();
      const handle = screen.getByRole("separator", {
        name: "Resize Quarterly chart",
      });
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await waitFor(() =>
        expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
          "/vault",
          expect.objectContaining({
            id: "markdown-image",
            markdownImageWidth: 376,
          }),
          expect.objectContaining({ commandKind: "text" }),
        ),
      );

      fireEvent.doubleClick(
        screen.getByRole("img", { name: "Quarterly chart" }),
      );
      await waitFor(() => expect(queryTitleInput(source)).toHaveFocus());
      expect(queryTitleInput(source)).toHaveValue(source);
    } finally {
      getBoundingClientRect.mockRestore();
    }
  });

  it("clears persisted Markdown image width when its title becomes text", async () => {
    const source = "![Quarterly chart](https://example.com/chart.png)";
    configureRepository([
      node({ id: "markdown-image", title: source, markdownImageWidth: 360 }),
    ]);
    renderNotesWorkspace();

    await waitFor(() => expect(queryTitleInput(source)).not.toBeNull());
    const textarea = queryTitleInput(source)!;
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Quarterly chart" } });
    fireEvent.blur(textarea);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({
          id: "markdown-image",
          title: "Quarterly chart",
          markdownImageWidth: null,
        }),
        expect.objectContaining({ commandKind: "text" }),
      ),
    );
  });

  it("keeps ordinary readonly bullets in the native editor while restoring temporary content", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "readonly",
        title: "Protected title",
        note: "Protected note",
        isReadonly: true,
      }),
    ]);
    notesStoreMock.setReadonly.mockImplementation(async (_vaultRoot, input) => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === input.nodeId
          ? { ...current, isReadonly: input.isReadonly }
          : current,
      );
      return workspace(confirmedNodes);
    });
    renderNotesWorkspace();

    const title = await findTitleInput("Protected title");
    const row = title.closest<HTMLElement>("[data-outline-id='readonly']")!;
    expect(row).not.toHaveClass("notes-node-readonly");
    const lock = within(row).getByRole("img", { name: "읽기 전용" });
    expect(lock).not.toHaveAttribute("tabindex");
    expect(lock.closest(".notes-node-readonly-actions")).toBe(
      row.querySelector(".notes-node-title-field")?.nextElementSibling,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-content-line\[data-readonly="true"\]\s*{[^}]*display:\s*flex;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node\[data-readonly="true"\]\s+\.notes-node-readonly-actions\s*{[^}]*opacity:\s*0;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node\[data-readonly="true"\]:hover\s+\.notes-node-readonly-actions,[^}]*\.notes-node\[data-readonly="true"\]:focus-within\s+\.notes-node-readonly-actions\s*{[^}]*opacity:\s*1;/s,
    );

    fireEvent.change(title, { target: { value: "Temporary title" } });
    expect(title).toHaveValue("Temporary title");
    fireEvent.blur(title);
    expect(title).toHaveValue("Protected title");
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();

    const note = await findTextareaByName("Supporting note: Protected title");
    fireEvent.change(note, { target: { value: "Temporary note" } });
    fireEvent.keyDown(note, { key: "Escape" });
    expect(note).toHaveValue("Protected note");
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();

    const menu = await openNodeMenu("Protected title", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Make editable" }),
    );
    await waitFor(() =>
      expect(notesStoreMock.setReadonly).toHaveBeenCalledWith(
        "/vault",
        { nodeId: "readonly", isReadonly: false },
        historyContextMatcher(),
      ),
    );
  });

  it("preserves a focused readonly row draft across lifecycle updates and clamps backing sync", async () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    configureRepository([
      node({
        id: "readonly",
        title: "Protected title",
        isReadonly: true,
      }),
    ]);
    renderNotesWorkspace();
    const title = await findTitleInput("Protected title");
    fireEvent.change(title, { target: { value: "Temporary title" } });
    title.setSelectionRange(15, 15);

    fireEvent.keyDown(title, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(notesStoreMock.toggleComplete).toHaveBeenCalledOnce(),
    );
    expect(title).toHaveValue("Temporary title");
    expect(title).toHaveFocus();

    notesStoreMock.toggleComplete.mockImplementationOnce(async () => {
      confirmedNodes = confirmedNodes.map((current) =>
        current.id === "readonly"
          ? { ...current, title: "Synced", completedAt: null }
          : current,
      );
      return workspace(confirmedNodes);
    });
    fireEvent.keyDown(title, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(title).toHaveValue("Synced");
      expect(title).toHaveFocus();
      expect(title.selectionStart).toBe("Synced".length);
      expect(title.selectionEnd).toBe("Synced".length);
    });
  });

  it("does not restore or navigate a readonly note during IME composition", async () => {
    configureRepository([
      node({
        id: "readonly",
        title: "Protected title",
        note: "원본",
        isReadonly: true,
      }),
    ]);
    renderNotesWorkspace();
    const note = await findTextareaByName("Supporting note: Protected title");

    fireEvent.compositionStart(note);
    fireEvent.change(note, { target: { value: "작성 중" } });
    fireEvent.keyDown(note, { key: "Escape", isComposing: true });

    expect(note).toHaveValue("작성 중");
    expect(note).toHaveFocus();
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
  });

  it("omits the stored GN subtree when the provider page is absent", async () => {
    configureRepository([
      node({ id: "ordinary-root", title: "Ordinary root" }),
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({
        id: "stored-github-date",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: "2026.07.24",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.24" },
      }),
    ]);
    renderNotesWorkspace(undefined, undefined, {
      ...githubSources([]),
      pages: [],
    });

    await findTitleInput("Ordinary root");
    const outline = screen.getByLabelText("Notes outline");
    expect(
      outline.querySelector(
        `[data-outline-id="${GITHUB_NOTIFICATIONS_ROOT_ID}"]`,
      ),
    ).toBeNull();
    expect(
      outline.querySelector('[data-outline-id="stored-github-date"]'),
    ).toBeNull();
  });

  it("returns an open GN page to All when the provider page disappears", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
    ]);
    const sources = githubSources([]);
    const rendered = renderNotesWorkspace(undefined, undefined, sources);

    await user.click(
      await within(screen.getByLabelText("Notes library")).findByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "All notes" }))
        .not.toHaveAttribute("aria-current"),
    );

    rendered.rerender(
      notesWorkspaceElement(undefined, undefined, {
        ...sources,
        pages: [],
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "All notes" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(
      within(screen.getByLabelText("Notes library")).queryByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
      }),
    ).not.toBeInTheDocument();
  });

  it("composes the stored GN root and hybrid rows in one outline without zoom-only editors", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "root-a", sortKey: 1, title: "Root A" }),
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 2,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({ id: "root-b", sortKey: 3, title: "Root B" }),
      node({
        id: "date-node",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: "2026.07.22",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.22" },
      }),
      node({
        id: "saved-notification",
        parentId: "date-node",
        sortKey: 1,
        title: "Saved notification",
        isReadonly: undefined,
        pluginMeta: {
          kind: "notification",
          notificationKey:
            '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/42",
          updatedAt: "2026-07-22T10:00:00Z",
          unread: true,
        },
      }),
      node({
        id: "user-child",
        parentId: "saved-notification",
        sortKey: 1,
        title: "User child",
      }),
    ]);
    renderNotesWorkspace();

    await findTitleInput("Root A");
    const outline = screen.getByLabelText("Notes outline");
    const list = outline.querySelector(".notes-outline-list");
    const topLevelIds = Array.from(list?.children ?? [])
      .map(
        (item) =>
          item.querySelector<HTMLElement>(":scope > .notes-node")?.dataset
            .outlineId,
      )
      .filter((id): id is string => id !== undefined);
    expect(topLevelIds).toEqual([
      "root-a",
      GITHUB_NOTIFICATIONS_ROOT_ID,
      "root-b",
    ]);
    const githubRootRow = outline.querySelector<HTMLElement>(
      `[data-outline-id="${GITHUB_NOTIFICATIONS_ROOT_ID}"]`,
    );
    expect(githubRootRow).not.toBeNull();
    expect(githubRootRow?.querySelector("textarea")).toBeNull();
    expect(githubRootRow).not.toHaveAttribute("data-notes-attachment-target");
    expect(
      githubRootRow &&
        within(githubRootRow).queryByRole("button", {
          name: `More actions for ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
        }),
    ).toBeNull();
    const githubRootActivator = within(githubRootRow!).getByRole("button", {
      name: `Zoom into ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
    });
    expect(githubRootActivator).toHaveAttribute(
      "data-sortable-activator",
      "true",
    );
    fireEvent.click(githubRootActivator, { shiftKey: true });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "All notes" }),
      ).not.toHaveAttribute("aria-current");
    });
    expect(
      screen.queryByRole("toolbar", { name: /selected notes/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "All notes" }));
    expect(outline.querySelector('[data-outline-id="date-node"]')).toBeNull();
    const dateGroup = within(outline).getByRole("group", {
      name: "Notifications for 07.22",
    });
    expect(dateGroup.querySelectorAll("[data-outline-id]")).toHaveLength(1);
    const savedNotificationRow = queryTitleInput(
      "Saved notification",
    )?.closest<HTMLElement>("[data-external-bullet-key]");
    expect(savedNotificationRow).not.toBeNull();
    expect(savedNotificationRow).not.toHaveAttribute(
      "data-notes-attachment-target",
    );
    expect(savedNotificationRow).not.toHaveAttribute("data-outline-id");
    expect(
      within(savedNotificationRow!).getByRole("img", {
        name: "GitHub에서 관리됨",
      }),
    ).toBeVisible();
    fireEvent.pointerDown(
      within(savedNotificationRow!).getByRole("group", {
        name: "Edit node title",
      }),
      { shiftKey: true },
    );
    expect(
      screen.queryByRole("toolbar", { name: /selected notes/ }),
    ).toBeNull();

    fireEvent.pointerDown(queryTitleInput("Saved notification")!, {
      button: 0,
      metaKey: true,
    });
    const savedTitle = getTitleInput("Saved notification");
    fireEvent.keyDown(savedTitle, {
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(
      screen.queryByRole("toolbar", { name: /selected notes/ }),
    ).toBeNull();

    fireEvent.pointerDown(
      within(
        outline.querySelector<HTMLElement>('[data-outline-id="user-child"]')!,
      ).getByRole("group", { name: "Edit node title" }),
      { button: 0, shiftKey: true },
    );
    expect(
      await screen.findByRole("toolbar", {
        name: "Actions for 1 selected notes",
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    const userChildSelectionSurface = queryTitleInput("User child");
    const savedNotificationSelectionSurface =
      queryTitleInput("Saved notification");
    expect(userChildSelectionSurface).not.toBeNull();
    expect(savedNotificationSelectionSurface).not.toBeNull();
    fireEvent.pointerDown(userChildSelectionSurface!, {
      button: 0,
      pointerId: 73,
    });
    fireEvent.pointerMove(savedNotificationSelectionSurface!, {
      buttons: 1,
      pointerId: 73,
    });
    fireEvent.pointerUp(savedNotificationSelectionSurface!, {
      button: 0,
      pointerId: 73,
    });
    expect(selectedOutlineIds()).toEqual([]);
    expect(
      screen.queryByRole("toolbar", { name: /selected notes/ }),
    ).toBeNull();
    expect(
      within(outline).getByText("Connect GitHub to view notifications."),
    ).not.toHaveAttribute("data-outline-id");

    await user.click(
      within(screen.getByLabelText("Notes library")).getByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "All notes" }),
      ).not.toHaveAttribute("aria-current");
    });
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add child" })).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Edit page title" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Completed items" }),
    ).toBeVisible();
    expect(within(outline).getAllByText("Saved notification")[0]).toBeVisible();
    expect(within(outline).getAllByText("User child")[0]).toBeVisible();
  });

  it("marks a stored GitHub notification read after provider completion and settles the workspace", async () => {
    const user = userEvent.setup();
    const notificationKey =
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]';
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({
        id: "date-node",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: "2026.07.22",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.22" },
      }),
      node({
        id: "saved-notification",
        parentId: "date-node",
        sortKey: 1,
        title: "Saved notification",
        isReadonly: undefined,
        pluginMeta: {
          kind: "notification",
          notificationKey,
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/42",
          updatedAt: "2026-07-22T10:00:00Z",
          unread: true,
        },
      }),
    ]);
    const sources = githubSources([]);
    renderNotesWorkspace(undefined, undefined, sources);

    const savedTitle = await findTitleInput("Saved notification");
    savedTitle.focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(sources.complete).toHaveBeenCalledWith({
        providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
        connectionId: '["https://api.github.com","account-7"]',
        remoteId: "42",
      });
      expect(
        notesStoreMock.markMaterializedGithubNotificationRead,
      ).toHaveBeenCalledWith("/vault", {
        rootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        notificationKey,
        updatedAt: "2026-07-22T10:00:00Z",
      });
    });
    expect(
      notesStoreMock.markMaterializedGithubNotificationRead,
    ).toHaveBeenCalledOnce();
    expect(
      notesStoreMock.refreshMaterializedGithubNotifications,
    ).not.toHaveBeenCalled();
    expect(
      queryTitleInput("Saved notification")?.closest(
        "[data-external-bullet-key]",
      ),
    ).toHaveAttribute("data-completed", "true");
  });

  it("creates an unlocked sibling from a saved notification and lets normal Tab indent it", async () => {
    const notificationKey =
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]';
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({
        id: "date-node",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: "2026.07.22",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.22" },
      }),
      node({
        id: "saved-notification",
        parentId: "date-node",
        sortKey: 1,
        title: "Saved notification",
        note: "Repository: acme/yonalist",
        isReadonly: undefined,
        pluginMeta: {
          kind: "notification",
          notificationKey,
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/42",
          updatedAt: "2026-07-22T10:00:00Z",
          unread: true,
        },
      }),
    ]);
    notesStoreMock.moveNode.mockImplementation(
      async (_vaultRoot: string, input: MoveNoteNodeInput) => {
        confirmedNodes = confirmedNodes.map((current) =>
          current.id === input.id
            ? { ...current, parentId: input.parentId }
            : current,
        );
        return workspace(confirmedNodes);
      },
    );
    renderNotesWorkspace();

    const savedTitle = await findTitleInput("Saved notification");
    fireEvent.keyDown(savedTitle, { key: "Enter" });

    await waitFor(() => {
      expect(
        notesStoreMock.materializeGithubNotificationAndCreateSibling,
      ).toHaveBeenCalledOnce();
    });
    expect(
      notesStoreMock.materializeGithubNotificationAndCreateSibling,
    ).toHaveBeenCalledWith(
      "/vault",
      {
        rootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        snapshot: {
          dateKey: "2026.07.22",
          notificationKey,
          title: "Saved notification",
          note: "Repository: acme/yonalist",
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/42",
          updatedAt: "2026-07-22T10:00:00Z",
          unread: true,
        },
        target: {
          kind: "sibling",
          siblingId: expect.any(String),
        },
      },
      historyContextMatcher(),
    );

    const siblingTitle = await findTitleInput("");
    const siblingId =
      siblingTitle.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId;
    expect(siblingId).toBeTruthy();
    expect(
      confirmedNodes.find((current) => current.id === siblingId)?.parentId,
    ).toBe("date-node");

    fireEvent.keyDown(siblingTitle, { key: "Tab" });
    await waitFor(() => {
      expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({
          id: siblingId,
          parentId: "saved-notification",
        }),
        historyContextMatcher(),
      );
    });
    expect(
      confirmedNodes.find((current) => current.id === siblingId)?.parentId,
    ).toBe("saved-notification");
  });

  it("atomically materializes a projected notification and imports a pasted child forest", async () => {
    const connectionId = '["https://api.github.com","account-7"]';
    const dateKey = {
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
      connectionId,
      remoteId: "date:2026.07.22",
    };
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
    ]);
    const dateBullet: ExternalBullet = {
      key: dateKey,
      parentKey: null,
      title: "2026.07.22",
      note: "",
      updatedAt: "2026-07-22T12:00:00Z",
      completed: false,
      capabilities: {
        expand: true,
        openDetails: false,
        complete: false,
        uncomplete: false,
        edit: false,
        move: false,
        delete: false,
        createChild: false,
      },
    };
    const projectedBullet: ExternalBullet = {
      key: { ...dateKey, remoteId: "43" },
      parentKey: dateKey,
      icon: "issue",
      externalUrl: "https://github.com/acme/yonalist/issues/43",
      title: "Projected notification",
      note: "Repository: acme/yonalist",
      updatedAt: "2026-07-22T11:00:00Z",
      completed: false,
      capabilities: {
        expand: false,
        openDetails: true,
        complete: true,
        uncomplete: false,
        edit: false,
        move: false,
        delete: false,
        createChild: false,
      },
    };
    renderNotesWorkspace(
      undefined,
      undefined,
      githubSources([dateBullet, projectedBullet]),
    );

    const projected = await findTitleInput("Projected notification");
    fireEvent.paste(projected, {
      clipboardData: {
        items: [],
        getData: () => "- first\n  - nested\n- second",
      },
    });

    await waitFor(() => {
      expect(
        notesStoreMock.materializeGithubNotificationAndCreateSibling,
      ).toHaveBeenCalledOnce();
    });
    expect(
      notesStoreMock.materializeGithubNotificationAndCreateSibling,
    ).toHaveBeenCalledWith(
      "/vault",
      {
        rootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        snapshot: {
          dateKey: "2026.07.22",
          notificationKey:
            '["github","[\\"https://api.github.com\\",\\"account-7\\"]","43"]',
          title: "Projected notification",
          note: "Repository: acme/yonalist",
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/43",
          updatedAt: "2026-07-22T11:00:00Z",
          unread: true,
        },
        target: {
          kind: "children",
          nodes: [
            {
              title: "first",
              children: [{ title: "nested", children: [] }],
            },
            { title: "second", children: [] },
          ],
        },
      },
      historyContextMatcher(),
    );
    expect(
      notesStoreMock.materializeGithubNotificationAndCreateSibling.mock
        .calls[0]?.[2],
    ).toMatchObject({ commandKind: "import" });
  });

  it("drops one ordinary bullet onto a projected notification with one atomic reparent", async () => {
    const user = userEvent.setup();
    const connectionId = '["https://api.github.com","account-7"]';
    const dateKey = {
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
      connectionId,
      remoteId: "date:2026.07.22",
    };
    const projectedBullet: ExternalBullet = {
      key: { ...dateKey, remoteId: "drop-target" },
      parentKey: dateKey,
      icon: "pull-request",
      externalUrl: "https://github.com/acme/yonalist/pull/44",
      title: "Drop target notification",
      note: "Repository: acme/yonalist",
      updatedAt: "2026-07-22T11:00:00Z",
      completed: false,
      capabilities: {
        expand: false,
        openDetails: true,
        complete: true,
        uncomplete: false,
        edit: false,
        move: false,
        delete: false,
        createChild: false,
      },
    };
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({ id: "moving", sortKey: 2, title: "Moving bullet" }),
    ]);
    notesStoreMock.materializeGithubNotificationAndReparent.mockResolvedValue(
      workspace(confirmedNodes),
    );
    renderNotesWorkspace(
      undefined,
      undefined,
      githubSources([
        {
          ...projectedBullet,
          key: dateKey,
          parentKey: null,
          title: "2026.07.22",
          note: "",
          externalUrl: undefined,
          capabilities: {
            ...projectedBullet.capabilities,
            expand: true,
            openDetails: false,
            complete: false,
          },
        },
        projectedBullet,
      ]),
    );

    const moving = await screen.findByRole("button", {
      name: "Zoom into Moving bullet",
    });
    const movingRow = moving.closest<HTMLElement>("[data-outline-id]")!;
    const targetRow = document.querySelector<HTMLElement>(
      "[data-github-notification-drop-target]",
    )!;
    movingRow.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 500,
        bottom: 40,
        width: 500,
        height: 40,
        toJSON: () => ({}),
      }) as DOMRect;
    targetRow.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 80,
        left: 0,
        top: 80,
        right: 500,
        bottom: 120,
        width: 500,
        height: 40,
        toJSON: () => ({}),
      }) as DOMRect;

    await user.pointer({
      keys: "[MouseLeft>]",
      target: moving,
      coords: { clientX: 12, clientY: 20 },
    });
    await user.pointer({
      target: targetRow,
      coords: { clientX: 120, clientY: 100 },
    });
    await user.pointer({
      target: targetRow,
      coords: { clientX: 121, clientY: 101 },
    });
    expect(
      screen.getByTestId("notes-selection-drag-preview"),
    ).toBeInTheDocument();
    expect(
      notesStoreMock.materializeGithubNotificationAndReparent,
    ).not.toHaveBeenCalled();
    await user.pointer({
      keys: "[/MouseLeft]",
      target: targetRow,
      coords: { clientX: 120, clientY: 100 },
    });

    await waitFor(() =>
      expect(
        notesStoreMock.materializeGithubNotificationAndReparent,
      ).toHaveBeenCalledOnce(),
    );
    expect(
      notesStoreMock.materializeGithubNotificationAndReparent,
    ).toHaveBeenCalledWith(
      "/vault",
      {
        rootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        nodeId: "moving",
        snapshot: {
          dateKey: "2026.07.22",
          notificationKey:
            '["github","[\\"https://api.github.com\\",\\"account-7\\"]","drop-target"]',
          title: "Drop target notification",
          note: "Repository: acme/yonalist",
          notificationType: "PullRequest",
          url: "https://github.com/acme/yonalist/pull/44",
          updatedAt: "2026-07-22T11:00:00Z",
          unread: true,
        },
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
  });

  it("moves composite focus across saved notifications, user rows, and projected notifications", async () => {
    const connectionId = '["https://api.github.com","account-7"]';
    const dateKey = {
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
      connectionId,
      remoteId: "date:2026.07.22",
    };
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({
        id: "date-node",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: "2026.07.22",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.22" },
      }),
      node({
        id: "saved-notification",
        parentId: "date-node",
        sortKey: 1,
        title: "Saved notification",
        note: "Saved note",
        isReadonly: undefined,
        pluginMeta: {
          kind: "notification",
          notificationKey:
            '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/42",
          updatedAt: "2026-07-22T10:00:00Z",
          unread: true,
        },
      }),
      node({
        id: "user-child",
        parentId: "saved-notification",
        sortKey: 1,
        title: "User child",
      }),
    ]);
    const dateBullet: ExternalBullet = {
      key: dateKey,
      parentKey: null,
      title: "2026.07.22",
      note: "",
      updatedAt: "2026-07-22T12:00:00Z",
      completed: false,
      capabilities: {
        expand: true,
        openDetails: false,
        complete: false,
        uncomplete: false,
        edit: false,
        move: false,
        delete: false,
        createChild: false,
      },
    };
    const projectedBullet: ExternalBullet = {
      key: { ...dateKey, remoteId: "43" },
      parentKey: dateKey,
      icon: "issue",
      externalUrl: "https://github.com/acme/yonalist/issues/43",
      title: "Projected notification",
      note: "",
      updatedAt: "2026-07-22T11:00:00Z",
      completed: false,
      capabilities: {
        expand: false,
        openDetails: true,
        complete: true,
        uncomplete: false,
        edit: false,
        move: false,
        delete: false,
        createChild: false,
      },
    };
    renderNotesWorkspace(
      undefined,
      undefined,
      githubSources([dateBullet, projectedBullet]),
    );

    const saved = await findTitleInput("Saved notification");
    const savedNote = getTextareaByName("Supporting note: Saved notification");
    const user = await findTitleInput("User child");
    const projected = await findTitleInput("Projected notification");
    fireEvent.focus(saved);

    fireEvent.keyDown(saved, { key: "ArrowDown" });
    expect(document.activeElement).toBe(savedNote);
    savedNote.setSelectionRange(3, 3);
    fireEvent.keyDown(savedNote, { key: "ArrowDown" });
    expect(document.activeElement).toBe(savedNote);
    fireEvent.keyDown(savedNote, { key: "ArrowUp" });
    expect(document.activeElement).toBe(savedNote);
    savedNote.setSelectionRange(savedNote.value.length, savedNote.value.length);
    fireEvent.keyDown(savedNote, { key: "ArrowDown" });
    expect(document.activeElement).toBe(user);
    fireEvent.keyDown(user, { key: "ArrowDown" });
    expect(document.activeElement).toBe(projected);
    fireEvent.keyDown(projected, { key: "ArrowUp" });
    expect(document.activeElement).toBe(user);

    user.setSelectionRange(user.value.length, user.value.length);
    fireEvent.keyDown(user, { key: "ArrowRight" });
    expect(document.activeElement).toBe(projected);
    expect(projected.selectionStart).toBe(0);
    projected.setSelectionRange(0, 0);
    fireEvent.keyDown(projected, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(user);
    expect(user.selectionStart).toBe(user.value.length);
  });

  it("returns projected notification focus to the GN root when the root collapses", async () => {
    const connectionId = '["https://api.github.com","account-7"]';
    const dateKey = {
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
      connectionId,
      remoteId: "date:2026.07.22",
    };
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isCollapsed: false,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
    ]);
    renderNotesWorkspace(
      undefined,
      undefined,
      githubSources([
        {
          key: dateKey,
          parentKey: null,
          title: "2026.07.22",
          note: "",
          updatedAt: "2026-07-22T12:00:00Z",
          completed: false,
          capabilities: {
            expand: true,
            openDetails: false,
            complete: false,
            uncomplete: false,
            edit: false,
            move: false,
            delete: false,
            createChild: false,
          },
        },
        {
          key: { ...dateKey, remoteId: "43" },
          parentKey: dateKey,
          icon: "issue",
          externalUrl: "https://github.com/acme/yonalist/issues/43",
          title: "Projected notification",
          note: "",
          updatedAt: "2026-07-22T11:00:00Z",
          completed: false,
          capabilities: {
            expand: false,
            openDetails: true,
            complete: true,
            uncomplete: false,
            edit: false,
            move: false,
            delete: false,
            createChild: false,
          },
        },
      ]),
    );

    const presentation = await waitFor(() =>
      getTitlePresentation("Projected notification"),
    );
    presentation.focus();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Collapse ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
      }),
    );

    await waitFor(() =>
      expect(queryTitleInput("Projected notification")).toBeNull(),
    );
    expect(
      screen.getByRole("button", {
        name: `Zoom into ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
      }),
    ).toHaveFocus();
  });

  it("returns a projected notification link focus to the GN root when the root collapses", async () => {
    const connectionId = '["https://api.github.com","account-7"]';
    const dateKey = {
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
      connectionId,
      remoteId: "date:2026.07.22",
    };
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isCollapsed: false,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
    ]);
    renderNotesWorkspace(
      undefined,
      undefined,
      githubSources([
        {
          key: dateKey,
          parentKey: null,
          title: "2026.07.22",
          note: "",
          updatedAt: "2026-07-22T12:00:00Z",
          completed: false,
          capabilities: {
            expand: true,
            openDetails: false,
            complete: false,
            uncomplete: false,
            edit: false,
            move: false,
            delete: false,
            createChild: false,
          },
        },
        {
          key: { ...dateKey, remoteId: "44" },
          parentKey: dateKey,
          icon: "issue",
          externalUrl: "https://github.com/acme/yonalist/issues/44",
          title: "Link-focused notification",
          note: "",
          updatedAt: "2026-07-22T10:00:00Z",
          completed: false,
          capabilities: {
            expand: false,
            openDetails: true,
            complete: true,
            uncomplete: false,
            edit: false,
            move: false,
            delete: false,
            createChild: false,
          },
        },
      ]),
    );

    const link = await screen.findByRole("button", {
      name: "웹에서 열기: Link-focused notification",
    });
    link.focus();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Collapse ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
      }),
    );

    await waitFor(() =>
      expect(queryTitleInput("Link-focused notification")).toBeNull(),
    );
    expect(
      screen.getByRole("button", {
        name: `Zoom into ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
      }),
    ).toHaveFocus();
  });

  it.each(["title", "note"] as const)(
    "returns an ordinary GN descendant %s focus to the GN root when the root collapses",
    async (field) => {
      configureRepository([
        node({
          id: GITHUB_NOTIFICATIONS_ROOT_ID,
          title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
          isCollapsed: false,
          isReadonly: undefined,
          pluginState: { collapsedGroups: [] },
        }),
        node({
          id: "date-node",
          parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
          sortKey: 1,
          title: "2026.07.22",
          isReadonly: undefined,
          pluginMeta: { kind: "date", dateKey: "2026.07.22" },
        }),
        node({
          id: "saved-notification",
          parentId: "date-node",
          sortKey: 1,
          title: "Saved notification",
          isReadonly: undefined,
          pluginMeta: {
            kind: "notification",
            notificationKey:
              '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
            notificationType: "Issue",
            url: "https://github.com/acme/yonalist/issues/42",
            updatedAt: "2026-07-22T10:00:00Z",
            unread: true,
          },
        }),
        node({
          id: "user-child",
          parentId: "saved-notification",
          sortKey: 1,
          title: "User child",
          note: "User note",
        }),
      ]);
      renderNotesWorkspace();

      const editor =
        field === "title"
          ? await findTitleInput("User child")
          : await findTextareaByName("Supporting note: User child");
      fireEvent.focus(editor);
      fireEvent.click(
        screen.getByRole("button", {
          name: `Collapse ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
        }),
      );

      await waitFor(() => expect(queryTitleInput("User child")).toBeNull());
      expect(
        screen.getByRole("button", {
          name: `Zoom into ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
        }),
      ).toHaveFocus();
    },
  );

  it("returns a hidden projected notification to the current GN breadcrumb in zoom", async () => {
    const connectionId = '["https://api.github.com","account-7"]';
    const dateKey = {
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
      connectionId,
      remoteId: "date:2026.07.22",
    };
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
    ]);
    renderNotesWorkspace(
      undefined,
      undefined,
      githubSources([
        {
          key: dateKey,
          parentKey: null,
          title: "2026.07.22",
          note: "",
          updatedAt: "2026-07-22T12:00:00Z",
          completed: false,
          capabilities: {
            expand: true,
            openDetails: false,
            complete: false,
            uncomplete: false,
            edit: false,
            move: false,
            delete: false,
            createChild: false,
          },
        },
        {
          key: { ...dateKey, remoteId: "43" },
          parentKey: dateKey,
          icon: "issue",
          externalUrl: "https://github.com/acme/yonalist/issues/43",
          title: "Completed projected notification",
          note: "",
          updatedAt: "2026-07-22T11:00:00Z",
          completed: true,
          capabilities: {
            expand: false,
            openDetails: true,
            complete: false,
            uncomplete: false,
            edit: false,
            move: false,
            delete: false,
            createChild: false,
          },
        },
      ]),
    );
    fireEvent.click(
      await within(screen.getByLabelText("Notes library")).findByRole(
        "button",
        {
          name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        },
      ),
    );
    const projected = await findTitleInput("Completed projected notification");
    projected.focus();

    fireEvent.click(screen.getByRole("button", { name: "Completed items" }));

    await waitFor(() =>
      expect(queryTitleInput("Completed projected notification")).toBeNull(),
    );
    expect(
      within(screen.getByLabelText("Notes breadcrumb")).getByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        current: "page",
      }),
    ).toHaveFocus();
  });

  it("blocks selected date-level Shift+Tab from reparenting user rows under the GN root", async () => {
    const notificationKey =
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]';
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({
        id: "date-node",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: "2026.07.22",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.22" },
      }),
      node({
        id: "saved-notification",
        parentId: "date-node",
        sortKey: 1,
        title: "Saved notification",
        isReadonly: undefined,
        pluginMeta: {
          kind: "notification",
          notificationKey,
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/42",
          updatedAt: "2026-07-22T10:00:00Z",
          unread: true,
        },
      }),
      node({
        id: "date-user-a",
        parentId: "date-node",
        sortKey: 2,
        title: "Date note A",
      }),
      node({
        id: "date-user-b",
        parentId: "date-node",
        sortKey: 3,
        title: "Date note B",
      }),
    ]);
    renderNotesWorkspace();
    const first = await findTitleInput("Date note A");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    await screen.findByRole("toolbar", {
      name: "Actions for 2 selected notes",
    });

    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(
      false,
    );

    expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
    expect(
      within(screen.getByLabelText("Status bar feedback")).getByRole("alert"),
    ).toHaveTextContent(
      "Outdent cannot move the selected roots outside the current zoom.",
    );
  });

  it("outdents selected notification children once to the provider date row", async () => {
    const notificationKey =
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]';
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({
        id: "date-node",
        parentId: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: "2026.07.22",
        isReadonly: undefined,
        pluginMeta: { kind: "date", dateKey: "2026.07.22" },
      }),
      node({
        id: "saved-notification",
        parentId: "date-node",
        sortKey: 1,
        title: "Saved notification",
        isReadonly: undefined,
        pluginMeta: {
          kind: "notification",
          notificationKey,
          notificationType: "Issue",
          url: "https://github.com/acme/yonalist/issues/42",
          updatedAt: "2026-07-22T10:00:00Z",
          unread: true,
        },
      }),
      node({
        id: "notification-child-a",
        parentId: "saved-notification",
        sortKey: 1,
        title: "Notification child A",
      }),
      node({
        id: "notification-child-b",
        parentId: "saved-notification",
        sortKey: 2,
        title: "Notification child B",
      }),
    ]);
    renderNotesWorkspace();
    const first = await findTitleInput("Notification child A");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    await screen.findByRole("toolbar", {
      name: "Actions for 2 selected notes",
    });

    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(
      false,
    );

    await waitFor(() =>
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "outdent",
          nodeIds: ["notification-child-a", "notification-child-b"],
        },
        historyContextMatcher(),
      ),
    );
  });

  it("keeps a projection-only GN root collapsible in All and expanded in zoom", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isCollapsed: true,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
    ]);
    renderNotesWorkspace();

    const outline = screen.getByLabelText("Notes outline");
    expect(
      await within(outline).findByRole("button", {
        name: `Expand ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      within(outline).queryByText("Connect GitHub to view notifications."),
    ).toBeNull();

    await user.click(
      within(screen.getByLabelText("Notes library")).getByRole("button", {
        name: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
      }),
    );
    expect(
      await within(outline).findByText("Connect GitHub to view notifications."),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "All notes" }));
    expect(
      within(outline).queryByText("Connect GitHub to view notifications."),
    ).toBeNull();
    await user.click(
      within(outline).getByRole("button", {
        name: `Expand ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
      }),
    );
    expect(
      await within(outline).findByText("Connect GitHub to view notifications."),
    ).toBeVisible();
  });

  it("restores a backward replay range in a row only after the authoritative title renders", async () => {
    const workspace = rowReplayWorkspace();
    render(
      <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 11 }}>
        <VaultRootContext.Provider value="/vault">
          <NotesImageResidencyProvider scopeKey="/vault">
            <NotesWorkspaceContext.Provider value={workspace}>
              <NotesOutlinePane />
            </NotesWorkspaceContext.Provider>
          </NotesImageResidencyProvider>
        </VaultRootContext.Provider>
      </NotesDateTodayProvider>,
    );

    const title = await waitFor(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Edit node title"]',
      );
      expect(textarea).not.toBeNull();
      return textarea!;
    });
    await waitFor(() => {
      expect(title).toHaveFocus();
      expect(title.selectionStart).toBe(1);
      expect(title.selectionEnd).toBe(5);
      expect(title.selectionDirection).toBe("backward");
    });
    expect(workspace.actions.acknowledgeFocus).toHaveBeenLastCalledWith(
      "row",
      31,
    );
  });

  it("does not focus an insertion target after its dispatch interaction epoch is stale", async () => {
    const workspace = rowReplayWorkspace(1);
    render(
      <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 11 }}>
        <VaultRootContext.Provider value="/vault">
          <NotesImageResidencyProvider scopeKey="/vault">
            <NotesWorkspaceContext.Provider value={workspace}>
              <NotesOutlinePane />
            </NotesWorkspaceContext.Provider>
          </NotesImageResidencyProvider>
        </VaultRootContext.Provider>
      </NotesDateTodayProvider>,
    );

    const title = await waitFor(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Edit node title"]',
      );
      expect(textarea).not.toBeNull();
      return textarea!;
    });
    await act(async () => undefined);

    expect(title).not.toHaveFocus();
    expect(workspace.actions.acknowledgeFocus).not.toHaveBeenCalled();
  });

  it("cancels a signature-mismatched insertion focus before it can focus or acknowledge", async () => {
    const workspace = signatureMismatchInsertionWorkspace();
    const rendered = render(
      <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 11 }}>
        <VaultRootContext.Provider value="/vault">
          <NotesImageResidencyProvider scopeKey="/vault">
            <NotesWorkspaceContext.Provider value={workspace}>
              <NotesOutlinePane />
            </NotesWorkspaceContext.Provider>
          </NotesImageResidencyProvider>
        </VaultRootContext.Provider>
      </NotesDateTodayProvider>,
    );

    const title = await waitFor(() => {
      const textarea = queryTitleInput("inserted");
      expect(textarea).not.toBeNull();
      return textarea!;
    });
    await act(async () => undefined);

    expect(workspace.actions.consumeInsertionMotion).toHaveBeenCalledOnce();
    expect(workspace.actions.consumeInsertionMotion).toHaveBeenCalledWith(
      7,
      "row",
    );
    expect(title).not.toHaveFocus();
    expect(workspace.actions.acknowledgeFocus).not.toHaveBeenCalled();

    rendered.rerender(
      <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 11 }}>
        <VaultRootContext.Provider value="/vault">
          <NotesImageResidencyProvider scopeKey="/vault">
            <NotesWorkspaceContext.Provider
              value={{ ...workspace, projectionPublication: null }}
            >
              <NotesOutlinePane />
            </NotesWorkspaceContext.Provider>
          </NotesImageResidencyProvider>
        </VaultRootContext.Provider>
      </NotesDateTodayProvider>,
    );
    await act(async () => undefined);

    expect(title).not.toHaveFocus();
    expect(workspace.actions.acknowledgeFocus).not.toHaveBeenCalled();
  });

  it("focuses and acknowledges an insertion target whose visible signature still matches", async () => {
    const workspace = signatureMismatchInsertionWorkspace(
      '[["row",null,0,false]]',
    );
    render(
      <NotesDateTodayProvider today={{ year: 2026, month: 7, day: 11 }}>
        <VaultRootContext.Provider value="/vault">
          <NotesImageResidencyProvider scopeKey="/vault">
            <NotesWorkspaceContext.Provider value={workspace}>
              <NotesOutlinePane />
            </NotesWorkspaceContext.Provider>
          </NotesImageResidencyProvider>
        </VaultRootContext.Provider>
      </NotesDateTodayProvider>,
    );

    const title = await waitFor(() => {
      const textarea = queryTitleInput("inserted");
      expect(textarea).toHaveFocus();
      return textarea!;
    });

    expect(workspace.actions.consumeInsertionMotion).toHaveBeenCalledOnce();
    expect(workspace.actions.consumeInsertionMotion).toHaveBeenCalledWith(7);
    expect(title).toHaveFocus();
    expect(workspace.actions.acknowledgeFocus).toHaveBeenCalledOnce();
    expect(workspace.actions.acknowledgeFocus).toHaveBeenCalledWith("row");
  });

  it("places the caret at clicked title and supporting-note positions", async () => {
    configureRepository([
      node({
        id: "alpha",
        title: "Alpha 😀 omega",
        note: "Supporting detail",
      }),
    ]);
    renderNotesWorkspace();

    const originalCaretPositionFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "caretPositionFromPoint",
    );
    try {
      const presentation = await screen.findByRole("group", {
        name: "Edit node title",
      });
      const textNode = presentation.firstChild!;
      const notePresentation = screen.getByRole("group", {
        name: "Supporting note: Alpha 😀 omega",
      });
      const noteTextNode = notePresentation.firstChild!;
      document.caretPositionFromPoint = vi
        .fn()
        .mockReturnValueOnce({
          offsetNode: textNode,
          offset: 8,
          getClientRect: vi.fn(),
        } as CaretPosition)
        .mockReturnValueOnce({
          offsetNode: noteTextNode,
          offset: 4,
          getClientRect: vi.fn(),
        } as CaretPosition);

      fireEvent.pointerDown(presentation, { clientX: 80, clientY: 20 });

      const title = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Edit node title",
      });
      expect(title).toHaveFocus();
      expect(title.selectionStart).toBe(8);
      expect(title.selectionEnd).toBe(8);

      const note =
        notePresentation.parentElement?.querySelector<HTMLTextAreaElement>(
          "textarea",
        );
      expect(note).not.toBeNull();
      if (!note) {
        throw new Error("Expected the note textarea to be rendered.");
      }
      fireEvent.pointerDown(notePresentation, { clientX: 80, clientY: 20 });

      expect(note).toHaveFocus();
      expect(note.selectionStart).toBe(4);
      expect(note.selectionEnd).toBe(4);
      expect(document.caretPositionFromPoint).toHaveBeenCalledTimes(2);
    } finally {
      if (originalCaretPositionFromPoint) {
        Object.defineProperty(
          document,
          "caretPositionFromPoint",
          originalCaretPositionFromPoint,
        );
      } else {
        delete (
          document as unknown as {
            caretPositionFromPoint?: Document["caretPositionFromPoint"];
          }
        ).caretPositionFromPoint;
      }
    }
  });

  it("renders ordered node images beneath the supporting note and loads bytes lazily", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      title: "Project",
      note: "Supporting detail",
    });
    const first = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id,
      sortKey: 100,
      originalName: "first.png",
    });
    const second = attachment({
      id: "8f257d31-d255-4fc8-89dc-4e3b30f24a6e",
      nodeId: root.id,
      sortKey: 200,
      originalName: "second.png",
    });
    configureRepository([root], { [root.id]: [first, second] });
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71]),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => `blob:${blob.type}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    renderNotesWorkspace();

    const groups = await screen.findAllByRole("group", { name: /^Image:/ });
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Image: first.png",
      "Image: second.png",
    ]);
    const supportingNote = await waitFor(() =>
      getTextareaByName("Supporting note: Project"),
    );
    expect(
      supportingNote.compareDocumentPosition(groups[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(notesStoreMock.readAttachmentBytes).not.toHaveBeenCalled();
    for (const group of groups) {
      await user.click(
        within(group).getByRole("button", { name: /^Load image / }),
      );
    }
    await waitFor(() =>
      expect(notesStoreMock.readAttachmentBytes).toHaveBeenCalledTimes(4),
    );
    expect(
      notesStoreMock.readAttachmentBytes.mock.calls.map((call) => call[1]),
    ).toEqual([first.id, first.id, second.id, second.id]);
  });

  it("uploads a menu-selected image through the injected picker and publishes it after import", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      title: "Project",
    });
    configureRepository([root]);
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(["/incoming/diagram.png"]),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn()),
    };
    mockNotesContentWidth(700, 480);
    notesStoreMock.importImageNodePaths.mockImplementation(
      async (_vaultRoot, input, context: NotesHistoryContext) => {
        const item = input.items[0]!;
        const imported = attachment({
          id: item.attachmentId,
          nodeId: item.nodeId,
          originalName: "diagram.png",
        });
        confirmedNodes = [
          ...confirmedNodes,
          node({
            id: item.nodeId,
            nodeKind: "image",
            sortKey: 2,
            title: "diagram.png",
          }),
        ];
        confirmedAttachmentsByNodeId = { [item.nodeId]: [imported] };
        return {
          workspace: workspace(confirmedNodes),
          historyEntryId: context.entryId,
          ...historyState({
            canUndo: true,
            nextUndoEntryId: context.entryId,
          }),
          importedRootIds: [item.nodeId],
        };
      },
    );
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71]),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:diagram"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    renderNotesWorkspace(attachmentUi);

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Upload image" }),
    );

    await waitFor(() =>
      expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(notesStoreMock.importImageNodePaths).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: expect.any(String),
            attachmentId: expect.any(String),
            sourcePath: "/incoming/diagram.png",
          },
        ],
        initialMaxDisplayWidth: 480,
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.importAttachmentPaths).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("group", { name: "Image: diagram.png" }),
    ).toBeVisible();
  });

  it("treats image picker cancellation as a no-op", async () => {
    const user = userEvent.setup();
    configureRepository([node({ id: "project", title: "Project" })]);
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(null),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn()),
    };
    renderNotesWorkspace(attachmentUi);

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Upload image" }),
    );

    await waitFor(() =>
      expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.importAttachmentPaths).not.toHaveBeenCalled();
    expect(screen.queryByText(/image upload failed/i)).toBeNull();
  });

  it("shows a retryable picker error on an image row without rendering legacy attachments", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      nodeKind: "image",
      title: "base.png",
    });
    const base = attachment({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157307",
      nodeId: root.id,
      originalName: "base.png",
    });
    configureRepository([root], { [root.id]: [base] });
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(["/incoming/diagram.png"]),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn()),
    };
    mockNotesContentWidth(480);
    notesStoreMock.importImageNodePaths
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(
        async (_vaultRoot, input, context: NotesHistoryContext) => {
          const item = input.items[0]!;
          const imported = attachment({
            id: item.attachmentId,
            nodeId: item.nodeId,
            originalName: "diagram.png",
          });
          confirmedNodes = [
            ...confirmedNodes,
            node({
              id: item.nodeId,
              nodeKind: "image",
              sortKey: 2,
              title: "diagram.png",
            }),
          ];
          confirmedAttachmentsByNodeId = {
            ...confirmedAttachmentsByNodeId,
            [item.nodeId]: [imported],
          };
          return {
            workspace: workspace(confirmedNodes),
            historyEntryId: context.entryId,
            ...historyState({
              canUndo: true,
              nextUndoEntryId: context.entryId,
            }),
            importedRootIds: [item.nodeId],
          };
        },
      );
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71]),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:diagram"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    renderNotesWorkspace(attachmentUi);

    const menu = await openNodeMenu("base.png", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Upload image" }),
    );

    const alert = await screen.findByRole("alert", {
      name: "Image upload failed",
    });
    const rootRow = screen
      .getByRole("group", { name: "Image: base.png" })
      .closest<HTMLElement>(".notes-node")!;
    expect(alert).toHaveTextContent("disk full");
    expect(rootRow).toContainElement(alert);
    expect(rootRow.querySelector(".notes-attachment-list")).toBeNull();
    expect(
      screen.getAllByRole("group", { name: "Image: base.png" }),
    ).toHaveLength(1);

    await user.click(
      within(alert).getByRole("button", { name: "Retry image upload" }),
    );

    await waitFor(() =>
      expect(
        screen.getAllByRole("group", {
          name: /^Image: (?:base|diagram)\.png$/,
        }),
      ).toHaveLength(2),
    );
    expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce();
    expect(notesStoreMock.importImageNodePaths).toHaveBeenCalledTimes(2);
    expect(notesStoreMock.importAttachmentPaths).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alert", { name: "Image upload failed" }),
    ).toBeNull();
  });

  it("shows a retryable clipboard error on a zoomed image header and reuses the exact attempt", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "88384bb1-f6cc-4848-a1b5-b8d3b9157306",
      nodeKind: "image",
      title: "base.png",
    });
    const base = attachment({
      id: "88384bb1-f6cc-4848-a1b5-b8d3b9157307",
      nodeId: root.id,
      originalName: "base.png",
    });
    configureRepository([root], { [root.id]: [base] });
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(null),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn()),
    };
    mockNotesContentWidth(480);
    notesStoreMock.importImageNodeBytes
      .mockRejectedValueOnce(new Error("clipboard disk full"))
      .mockImplementation(async (_vaultRoot, input, context) => {
        const item = input.items[0]!;
        const imported = attachment({
          id: item.attachmentId,
          nodeId: item.nodeId,
          originalName: item.originalName,
        });
        confirmedNodes = [
          ...confirmedNodes,
          node({
            id: item.nodeId,
            nodeKind: "image",
            parentId: root.id,
            sortKey: 1,
            title: item.originalName,
          }),
        ];
        confirmedAttachmentsByNodeId = {
          ...confirmedAttachmentsByNodeId,
          [item.nodeId]: [imported],
        };
        return {
          workspace: workspace(confirmedNodes),
          historyEntryId: context.entryId,
          ...historyState({
            canUndo: true,
            nextUndoEntryId: context.entryId,
          }),
          importedRootIds: [item.nodeId],
        };
      });
    renderNotesWorkspace(attachmentUi);

    await user.click(
      await screen.findByRole("button", { name: "Zoom into base.png" }),
    );
    fireEvent.blur(document.activeElement as HTMLElement);
    const headerImage = await screen.findByRole("group", {
      name: "Image: base.png",
    });
    const file = new File(["clipboard-bytes"], "pasted.png", {
      type: "image/png",
    });
    const clipboardItems = Object.assign(
      [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => file,
          getAsString: vi.fn(),
          webkitGetAsEntry: vi.fn(),
        },
      ],
      { add: vi.fn(), clear: vi.fn(), remove: vi.fn() },
    ) as unknown as DataTransferItemList;

    expect(
      fireEvent.paste(headerImage, {
        clipboardData: { items: clipboardItems, getData: () => "" },
      }),
    ).toBe(false);

    const alert = await screen.findByRole("alert", {
      name: "Image upload failed",
    });
    const header = headerImage.closest<HTMLElement>(".notes-page-header")!;
    expect(header).toContainElement(alert);
    expect(alert).toHaveTextContent("clipboard disk full");
    expect(header.querySelector(".notes-attachment-list")).toBeNull();
    expect(notesStoreMock.importImageNodeBytes).toHaveBeenCalledTimes(1);

    await user.click(
      within(alert).getByRole("button", { name: "Retry image upload" }),
    );

    await waitFor(() =>
      expect(notesStoreMock.importImageNodeBytes).toHaveBeenCalledTimes(2),
    );
    expect(notesStoreMock.importImageNodeBytes.mock.calls[1]?.[1]).toEqual(
      notesStoreMock.importImageNodeBytes.mock.calls[0]?.[1],
    );
    expect(notesStoreMock.importImageNodeBytes.mock.calls[1]?.[2]).toBe(
      notesStoreMock.importImageNodeBytes.mock.calls[0]?.[2],
    );
    expect(
      notesStoreMock.importImageNodeBytes.mock.calls[1]?.[1].items[0].blob,
    ).toBe(file);
    expect(attachmentUi.openImageFiles).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getAllByRole("group", {
          name: /^Image: (?:base|pasted)\.png$/,
        }),
      ).toHaveLength(2),
    );
  });

  it("requires accessible confirmation before removing an image", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
      title: "Project",
    });
    const image = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id,
      originalName: "diagram.png",
    });
    configureRepository([root], { [root.id]: [image] });
    notesStoreMock.removeAttachment.mockImplementation(async () => {
      confirmedAttachmentsByNodeId = { [root.id]: [] };
      return workspace(confirmedNodes);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderNotesWorkspace();

    await user.click(
      await screen.findByRole("button", { name: "Load image diagram.png" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Image actions for diagram.png",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    let dialog = await screen.findByRole("alertdialog", {
      name: "Remove image?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(notesStoreMock.removeAttachment).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", { name: "Image: diagram.png" }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Image actions for diagram.png",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    dialog = await screen.findByRole("alertdialog", { name: "Remove image?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove image" }),
    );

    await waitFor(() =>
      expect(notesStoreMock.removeAttachment).toHaveBeenCalledWith(
        "/vault",
        image.id,
        historyContextMatcher(),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Image: diagram.png" }),
      ).toBeNull(),
    );
  });

  it.each(["Archive", "Trash"])(
    "renders images read-only in %s without attachment mutation commands",
    async (view) => {
      const user = userEvent.setup();
      const root = node({
        id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306",
        title: "Project",
        archivedAt: view === "Archive" ? "2026-07-12T00:00:00Z" : null,
        deletedAt: view === "Trash" ? "2026-07-12T00:00:00Z" : null,
      });
      const image = attachment({
        id: "1c17ba74-a617-45e7-9e21-74068b63befe",
        nodeId: root.id,
        originalName: "diagram.png",
      });
      configureRepository([root], { [root.id]: [image] });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: vi.fn(() => "blob:diagram"),
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
      renderNotesWorkspace();

      await user.click(await screen.findByRole("button", { name: view }));

      expect(
        await screen.findByRole("group", { name: "Image: diagram.png" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("separator", { name: "Resize diagram.png" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Remove diagram.png" }),
      ).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Upload image" }),
      ).toBeNull();

      const row = document.querySelector<HTMLElement>(
        `[data-outline-id="${root.id}"]`,
      );
      expect(row).not.toHaveAttribute("data-notes-attachment-target");
      expect(notesStoreMock.importAttachmentPaths).not.toHaveBeenCalled();
      expect(notesStoreMock.resizeAttachment).not.toHaveBeenCalled();
      expect(notesStoreMock.removeAttachment).not.toHaveBeenCalled();
    },
  );

  it("keeps native row and page textareas mounted behind interactive resting tags", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "project",
        sortKey: 1,
        title: "Project #today",
        note: "Owned by @Alice",
      }),
      node({ id: "child", parentId: "project", title: "Child" }),
    ]);
    const { container } = renderNotesWorkspace();

    const rowTag = await screen.findByRole("button", {
      name: "#today tag filter is inactive",
    });
    const row = rowTag.closest(".notes-node");
    const rowTitle = row?.querySelector("textarea.notes-node-title");
    const rowNote = row?.querySelector("textarea.notes-node-note");

    expect(rowTitle).toHaveValue("Project #today");
    expect(rowNote).toHaveValue("Owned by @Alice");
    expect(
      within(row as HTMLElement).getByRole("button", {
        name: "@Alice tag filter is inactive",
      }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Zoom into Project #today" }),
    );
    fireEvent.blur(screen.getByRole("textbox", { name: "Edit page title" }));

    const pageHeader = container.querySelector(".notes-page-header");
    expect(pageHeader?.querySelector("textarea.notes-page-title")).toHaveValue(
      "Project #today",
    );
    expect(pageHeader?.querySelector("textarea.notes-page-note")).toHaveValue(
      "Owned by @Alice",
    );
    expect(
      within(pageHeader as HTMLElement).getByRole("button", {
        name: "#today tag filter is inactive",
      }),
    ).toBeVisible();
    expect(
      within(pageHeader as HTMLElement).getByRole("button", {
        name: "@Alice tag filter is inactive",
      }),
    ).toBeVisible();
  });

  it("renders separate arrow and bullet controls with the bullet as sortable activator", async () => {
    renderNotesWorkspace();

    const title = await findTitleInput("Project");
    expect(title.closest("li")).toHaveAttribute("aria-level", "1");
    expect(getTitleInput("Plan").closest("li")).toHaveAttribute(
      "aria-level",
      "2",
    );

    const projectBullet = screen.getByRole("button", {
      name: "Zoom into Project",
    });
    expect(projectBullet).toBeVisible();
    expect(projectBullet).toHaveClass("notes-node-bullet");
    expect(projectBullet).toHaveAttribute(
      "aria-roledescription",
      "sortable note",
    );
    expect(projectBullet).toHaveAttribute("aria-describedby");
    expect(
      screen.getByRole("button", { name: "Collapse Project" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "More actions for Project" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("checkbox", { name: /complete/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move Project" }),
    ).not.toBeInTheDocument();

    const projectRow = projectBullet.closest(".notes-node-main");
    expect(
      Array.from(projectRow?.children ?? []).map((element) =>
        element.classList.contains("notes-node-menu-slot")
          ? "menu"
          : element.classList.contains("notes-node-arrow-slot")
            ? "arrow"
            : element.classList.contains("notes-node-bullet")
              ? "bullet"
              : element.classList.contains("notes-node-content-line")
                ? "content"
                : "other",
      ),
    ).toEqual(["menu", "arrow", "bullet", "content"]);

    const leafRow = getTitleInput("Outside branch").closest(".notes-node-main");
    expect(
      leafRow?.querySelector(".notes-node-arrow-slot"),
    ).toBeEmptyDOMElement();
  });

  it("renders an empty bullet without an Untitled placeholder", async () => {
    configureRepository([
      node({ id: "project", title: "Project" }),
      node({ id: "empty", parentId: "project", sortKey: 1, title: "" }),
    ]);
    renderNotesWorkspace();

    const input = await findTitleInput("");
    const row = input.closest<HTMLElement>(".notes-node");
    expect(row).not.toBeNull();
    expect(within(row!).queryByText("Untitled")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("placeholder");
    expect(input).toHaveValue("");
    expect(input).toHaveAccessibleName("Edit node title");
    expect(row).toHaveAttribute("data-empty-bullet", "true");
    expect(row).toHaveAttribute("data-marker-kind", "bullet");
  });

  it("renders a stable To-do checkbox and direct-child progress only", async () => {
    configureRepository([
      node({ id: "parent", sortKey: 1, title: "Parent" }),
      node({
        id: "open",
        parentId: "parent",
        sortKey: 1,
        title: "Open task",
        markerKind: "todo",
      }),
      node({
        id: "done",
        parentId: "parent",
        sortKey: 2,
        title: "Done task",
        markerKind: "todo",
        completedAt: "2026-07-23T00:00:00Z",
      }),
      node({
        id: "ordinary",
        parentId: "parent",
        sortKey: 3,
        title: "Completed bullet",
        completedAt: "2026-07-23T00:00:00Z",
      }),
      node({
        id: "grandchild",
        parentId: "open",
        sortKey: 1,
        title: "Nested task",
        markerKind: "todo",
        completedAt: "2026-07-23T00:00:00Z",
      }),
    ]);
    renderNotesWorkspace();

    const parent = (await findTitleInput("Parent")).closest<HTMLElement>(
      ".notes-node",
    );
    expect(parent).not.toBeNull();
    expect(
      within(parent!).getByRole("progressbar", {
        name: "1 of 2 To-dos complete",
      }),
    ).toHaveTextContent("(1/2)");
    expect(parent).not.toHaveTextContent("직계 작업의 완료 상태");

    const openRow =
      getTitleInput("Open task").closest<HTMLElement>(".notes-node");
    expect(openRow).toHaveAttribute("data-marker-kind", "todo");
    expect(
      within(openRow!).getByRole("checkbox", {
        name: "Mark complete: Open task",
      }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      Array.from(
        openRow!.querySelector<HTMLElement>(".notes-node-main")?.children ?? [],
      ).map((element) => element.className),
    ).toEqual([
      "notes-node-menu-slot",
      "notes-node-arrow-slot",
      "notes-node-bullet",
      "notes-todo-checkbox",
      "notes-node-content-line",
    ]);
  });

  it("renders an image node as primary row content while legacy text attachments stay below text", async () => {
    const diagramAttachment = attachment({
      id: "diagram-primary",
      nodeId: "diagram-node",
      originalName: "diagram.png",
    });
    const photoAttachment = attachment({
      id: "photo-primary",
      nodeId: "photo-node",
      originalName: "photo.png",
    });
    const legacyAttachment = attachment({
      id: "legacy-image",
      nodeId: "text-node",
      originalName: "legacy.png",
    });
    configureRepository(
      [
        node({
          id: "diagram-node",
          nodeKind: "image",
          sortKey: 1,
          title: "diagram.png",
          note: "Architecture description",
          isCollapsed: true,
        }),
        node({
          id: "diagram-child",
          parentId: "diagram-node",
          title: "Diagram child",
        }),
        node({
          id: "photo-node",
          nodeKind: "image",
          sortKey: 2,
          title: "photo.png",
          note: "Photo description",
        }),
        node({
          id: "photo-child",
          parentId: "photo-node",
          title: "Photo child",
        }),
        node({ id: "text-node", sortKey: 3, title: "Legacy text" }),
      ],
      {
        "diagram-node": [diagramAttachment],
        "photo-node": [photoAttachment],
        "text-node": [legacyAttachment],
      },
    );
    renderNotesWorkspace();

    const diagramContent = await screen.findByRole("group", {
      name: "Image: diagram.png",
    });
    const photoContent = await screen.findByRole("group", {
      name: "Image: photo.png",
    });
    const diagramRow = diagramContent.closest<HTMLElement>(".notes-node")!;
    const photoRow = photoContent.closest<HTMLElement>(".notes-node")!;
    expect(diagramContent.closest(".notes-node-main")).not.toBeNull();
    expect(photoContent.closest(".notes-node-main")).not.toBeNull();
    expect(queryTitleInput("diagram.png")).toBeNull();
    expect(queryTitleInput("photo.png")).toBeNull();
    expect(
      within(diagramRow).getByRole("textbox", { name: "Image note" }),
    ).toBeVisible();
    expect(
      within(photoRow).getByRole("textbox", { name: "Image note" }),
    ).toBeVisible();
    expect(
      within(diagramRow).getByRole("button", {
        name: "Zoom into diagram.png",
      }),
    ).toBeVisible();
    expect(
      within(photoRow).getByRole("button", { name: "Zoom into photo.png" }),
    ).toBeVisible();
    expect(
      within(diagramRow).getByRole("button", {
        name: "More actions for diagram.png",
      }),
    ).toBeVisible();
    expect(
      within(photoRow).getByRole("button", {
        name: "More actions for photo.png",
      }),
    ).toBeVisible();
    expect(
      within(diagramRow).getByRole("button", { name: "Expand diagram.png" }),
    ).toBeVisible();
    expect(
      within(photoRow).getByRole("button", { name: "Collapse photo.png" }),
    ).toBeVisible();
    const diagramDescription = getTextareaByName(
      "Supporting note: diagram.png",
    );
    const photoDescription = getTextareaByName("Supporting note: photo.png");
    expect(diagramRow).toContainElement(diagramDescription);
    expect(photoRow).toContainElement(photoDescription);
    expect(diagramDescription).toHaveValue("Architecture description");
    expect(photoDescription).toHaveValue("Photo description");
    expect(diagramContent).not.toHaveTextContent("diagram.png");
    expect(photoContent).not.toHaveTextContent("photo.png");

    const textTitle = await findTitleInput("Legacy text");
    const legacyImage = screen.getByRole("group", {
      name: "Image: legacy.png",
    });
    expect(textTitle).toBeVisible();
    expect(legacyImage.closest(".notes-node-attachments")).not.toBeNull();
    expect(legacyImage.closest(".notes-node-main")).toBeNull();
  });

  it("keeps a missing image node actionable and renders Image unavailable", async () => {
    configureRepository([
      node({
        id: "missing-image",
        nodeKind: "image",
        title: "missing.png",
        note: "Recovery details",
      }),
    ]);
    renderNotesWorkspace();

    const content = await screen.findByRole("group", {
      name: "Image: missing.png",
    });
    const row = content.closest<HTMLElement>(".notes-node")!;
    expect(within(content).getByRole("alert")).toHaveTextContent(
      "Image unavailable",
    );
    expect(
      within(row).getByRole("button", {
        name: "More actions for missing.png",
      }),
    ).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "Zoom into missing.png" }),
    ).toBeVisible();
    expect(queryTitleInput("missing.png")).toBeNull();
    expect(row).not.toHaveTextContent("missing.png");
    expect(row.outerHTML).toContain("missing.png");
  });

  it("routes image Shift+Enter without using the legacy text split command", async () => {
    const image = node({
      id: "image-node",
      nodeKind: "image",
      title: "diagram.png",
      note: "",
    });
    configureRepository([image], {
      "image-node": [
        attachment({
          id: "image-primary",
          nodeId: "image-node",
          originalName: "diagram.png",
        }),
      ],
    });
    renderNotesWorkspace();
    await screen.findByRole("group", {
      name: "Image: diagram.png",
    });

    const editor = screen.getByRole("textbox", { name: "Image note" });
    expect(fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })).toBe(
      false,
    );
    expect(getTextareaByName("Supporting note: diagram.png")).toHaveFocus();

    expect(notesStoreMock.createNode).not.toHaveBeenCalled();
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
  });

  it("indents and outdents image nodes with Tab and Shift+Tab", async () => {
    configureRepository(
      [
        node({ id: "previous", sortKey: 1, title: "Previous" }),
        node({
          id: "image-node",
          nodeKind: "image",
          sortKey: 2,
          title: "diagram.png",
        }),
      ],
      {
        "image-node": [
          attachment({ id: "image-primary", nodeId: "image-node" }),
        ],
      },
    );
    notesStoreMock.moveNode.mockImplementation(
      async (_vaultRoot: string, input: MoveNoteNodeInput) => {
        confirmedNodes = confirmedNodes.map((current) =>
          current.id === input.id
            ? { ...current, parentId: input.parentId }
            : current,
        );
        return workspace(confirmedNodes);
      },
    );
    renderNotesWorkspace();
    let imageEditor = await screen.findByRole("textbox", {
      name: "Image note",
    });
    act(() => imageEditor.focus());
    await act(async () => {
      fireEvent.keyDown(imageEditor, { key: "Tab" });
    });
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "image-node",
        parentId: "previous",
        afterId: null,
      },
      historyContextMatcher(),
    );

    imageEditor = screen.getByRole("textbox", { name: "Image note" });
    act(() => imageEditor.focus());
    await act(async () => {
      fireEvent.keyDown(imageEditor, { key: "Tab", shiftKey: true });
    });
    await waitFor(() =>
      expect(notesStoreMock.moveNode).toHaveBeenCalledTimes(2),
    );
    expect(notesStoreMock.moveNode).toHaveBeenLastCalledWith(
      "/vault",
      {
        id: "image-node",
        parentId: null,
        afterId: "previous",
      },
      historyContextMatcher(),
    );

    imageEditor = screen.getByRole("textbox", { name: "Image note" });
    act(() => imageEditor.focus());
    await act(async () => {
      fireEvent.keyDown(imageEditor, { key: "ArrowRight", altKey: true });
    });
    await waitFor(() =>
      expect(notesStoreMock.moveNode).toHaveBeenCalledTimes(3),
    );
    expect(notesStoreMock.moveNode).toHaveBeenLastCalledWith(
      "/vault",
      {
        id: "image-node",
        parentId: "previous",
        afterId: null,
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
  });

  it("preserves selected-atom F6 and Escape semantics in an outline image row", async () => {
    configureRepository(
      [
        node({ id: "previous", sortKey: 1, title: "Previous" }),
        node({
          id: "image-node",
          nodeKind: "image",
          sortKey: 2,
          title: "beforeafter",
          imageOffsetUtf16: 6,
        }),
      ],
      {
        "image-node": [
          attachment({
            id: "image-primary",
            nodeId: "image-node",
            originalName: "diagram.png",
          }),
        ],
      },
    );
    const user = userEvent.setup();
    renderNotesWorkspace();

    const editor = await screen.findByRole("textbox", { name: "Image note" });
    const imageRow = editor.closest<HTMLElement>(".notes-node")!;
    const [before, atom, after] = editor.querySelectorAll<HTMLElement>(
      "[data-image-atom-region]",
    );
    act(() =>
      writeImageAtomDomSelection(
        { host: editor, before: before!, atom: atom!, after: after! },
        { anchorUtf16: 7, focusUtf16: 6 },
        document.getSelection()!,
      ),
    );

    const group = within(editor).getByRole("group", {
      name: "Image: diagram.png",
    });
    expect(fireEvent.keyDown(editor, { key: "F6" })).toBe(false);
    expect(group).toHaveFocus();

    await user.tab();
    const firstControl = within(group).getByRole("button", {
      name: "Load image diagram.png",
    });
    expect(firstControl).toHaveFocus();
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();
    expect(imageRow).toHaveAttribute("data-outline-id", "image-node");
    expect(
      confirmedNodes.find((current) => current.id === "image-node"),
    ).toMatchObject({ parentId: null, isCollapsed: false });
    fireEvent.keyDown(firstControl, { key: "Escape" });

    expect(editor).toHaveFocus();
    expect(
      readImageAtomDomSelection(
        { host: editor, before: before!, atom: atom!, after: after! },
        document.getSelection()!,
      ),
    ).toEqual({ anchorUtf16: 7, focusUtf16: 6 });
    expect(document.querySelector("[data-range-selected=true]")).toBeNull();
  });

  it("snapshots leaf, expanded, collapsed, and completed collapsed bullet states", async () => {
    configureRepository([
      node({ id: "leaf", sortKey: 1, title: "Leaf" }),
      node({ id: "expanded", sortKey: 2, title: "Expanded" }),
      node({
        id: "expanded-child",
        parentId: "expanded",
        title: "Expanded child",
      }),
      node({
        id: "collapsed",
        sortKey: 3,
        title: "Collapsed",
        isCollapsed: true,
      }),
      node({
        id: "collapsed-child",
        parentId: "collapsed",
        title: "Collapsed child",
      }),
      node({
        id: "completed-collapsed",
        sortKey: 4,
        title: "Completed collapsed",
        isCollapsed: true,
        completedAt: "2026-07-10T01:00:00Z",
      }),
      node({
        id: "completed-child",
        parentId: "completed-collapsed",
        title: "Completed child",
      }),
    ]);
    renderNotesWorkspace();
    await findTitleInput("Leaf");

    const states = ["Leaf", "Expanded", "Collapsed", "Completed collapsed"].map(
      (title) => {
        const row = getTitleInput(title).closest<HTMLElement>(".notes-node")!;
        const main = row.querySelector(".notes-node-main")!;
        const bullet = within(row).getByRole("button", {
          name: `Zoom into ${title}`,
        });
        return {
          title,
          completed: row.dataset.completed ?? "false",
          collapsed: bullet.dataset.collapsed ?? "false",
          controls: Array.from(main.children).map(
            (element) => element.className,
          ),
        };
      },
    );

    expect(states).toMatchInlineSnapshot(`
      [
        {
          "collapsed": "false",
          "completed": "false",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-node-content-line",
          ],
          "title": "Leaf",
        },
        {
          "collapsed": "false",
          "completed": "false",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-node-content-line",
          ],
          "title": "Expanded",
        },
        {
          "collapsed": "true",
          "completed": "false",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-node-content-line",
          ],
          "title": "Collapsed",
        },
        {
          "collapsed": "true",
          "completed": "true",
          "controls": [
            "notes-node-menu-slot",
            "notes-node-arrow-slot",
            "notes-node-bullet",
            "notes-node-content-line",
          ],
          "title": "Completed collapsed",
        },
      ]
    `);
  });

  it("retains an accent focus ring on collapsed bullet halos", async () => {
    configureRepository([
      node({ id: "collapsed", title: "Collapsed", isCollapsed: true }),
      node({ id: "collapsed-child", parentId: "collapsed", title: "Child" }),
      node({
        id: "completed-collapsed",
        sortKey: 2,
        title: "Completed collapsed",
        isCollapsed: true,
        completedAt: "2026-07-10T01:00:00Z",
      }),
      node({
        id: "completed-child",
        parentId: "completed-collapsed",
        title: "Completed child",
      }),
    ]);
    renderNotesWorkspace();
    await findTitleInput("Collapsed");

    for (const label of ["Collapsed", "Completed collapsed"]) {
      const bullet = screen.getByRole("button", { name: `Zoom into ${label}` });
      expect(bullet).toHaveAttribute("data-collapsed", "true");
      bullet.focus();
      expect(bullet).toHaveFocus();
    }
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\]:focus-visible::before,[\s\S]*\.notes-node\[data-completed="true"\][\s\S]*\.notes-node-bullet\[data-collapsed="true"\]:focus-visible::before\s*{[^}]*box-shadow:\s*0 0 0 2px var\(--accent\),\s*inset 0 0 0 1px var\(--border-strong\);/s,
    );
  });

  it("keeps title and supporting-note input outside drag activation", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    const title = await findTitleInput("Project");
    const projectBullet = screen.getByRole("button", {
      name: "Zoom into Project",
    });

    projectBullet.focus();
    expect(projectBullet).toHaveFocus();
    await user.click(title);
    await user.keyboard(" [ArrowLeft][ArrowRight]");
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();

    const supportingNote = getTextareaByName("Supporting note: Project");
    await user.click(supportingNote);
    await user.keyboard(" [ArrowUp][ArrowDown]");
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
  });

  it("uses the arrow only for collapse and the bullet only for zoom", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    await findTitleInput("Project");
    const collapse = screen.getByRole("button", { name: "Collapse Project" });
    const bullet = screen.getByRole("button", { name: "Zoom into Project" });

    await user.click(collapse);

    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
      "/vault",
      "project",
      historyContextMatcher(),
    );
    expect(screen.getByRole("button", { name: "All notes" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(getTitleInput("Outside branch")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zoom into Project" }),
      ).toHaveAttribute("data-collapsed", "true"),
    );

    await user.click(bullet);

    expect(
      within(screen.getByLabelText("Notes breadcrumb")).getByRole("button", {
        name: "Project",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 }),
    ).toBeVisible();
    const zoomedPlan = getTitleInput("Plan");
    const zoomedMilestone = getTitleInput("Milestone");
    expect(zoomedPlan.closest("li")).toHaveAttribute("aria-level", "1");
    expect(zoomedPlan.closest(".notes-node")).toHaveAttribute(
      "data-guide-end-id",
      "milestone",
    );
    expect(
      zoomedMilestone
        .closest(".notes-node")
        ?.querySelectorAll(".notes-node-guide"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Zoom into Plan" }),
    ).toHaveAttribute("data-sortable-activator", "true");
    expect(queryTitleInput("Outside branch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All notes" }));
    const restoredTitle = await findTitleInput("Project");
    expect(queryTitleInput("Plan")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Project" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce();
    await user.dblClick(restoredTitle);

    expect(screen.getByRole("button", { name: "All notes" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(getTitleInput("Outside branch")).toBeInTheDocument();
  });

  it("focuses a zoomed child page title at its end", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    await user.click(screen.getByRole("button", { name: "Zoom into Plan" }));

    const title = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit page title",
    });
    await waitFor(() => expect(title).toHaveFocus());
    expect(title.selectionStart).toBe(title.value.length);
    expect(title.selectionEnd).toBe(title.value.length);
  });

  it("does not acknowledge rejected or explicit no-op fixture mutations", async () => {
    const context: NotesHistoryContext = {
      sessionId: "fixture-session",
      historyEpoch: "history-epoch",
      entryId: "fixture-entry",
      commandKind: "collapse",
    };
    const rejectedMutation = acknowledgedDefaultMutation(
      async (_context: NotesHistoryContext): Promise<NotesWorkspace> => {
        throw new Error("mutation failed");
      },
    );
    const noOpMutation = acknowledgedDefaultMutation(
      async (_context: NotesHistoryContext) => ({
        ...workspace(confirmedNodes),
        historyEntryId: null,
      }),
    );

    await expect(rejectedMutation(context)).rejects.toThrow("mutation failed");
    await noOpMutation({ ...context, entryId: "no-op-entry" });

    await expect(
      notesStoreMock.historyStatus("/vault", context.sessionId),
    ).resolves.toEqual(historyState());
  });

  it("renders navigation failures only in the bottom status feedback region", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");
    notesStoreMock.historyStatus.mockRejectedValueOnce(
      new Error("status unavailable"),
    );

    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));

    expect(
      within(screen.getByLabelText("Status bar feedback")).getByRole("alert"),
    ).toHaveTextContent("Notes navigation history status is unavailable.");
    expect(document.querySelector(".notes-pane-error")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Project", level: 1 }),
    ).not.toBeInTheDocument();
  });

  it("keeps completion reachable by keyboard and touch-style pointer input", async () => {
    const user = userEvent.setup();
    configureRepository([node({ id: "project", title: "Project" })]);
    renderNotesWorkspace();

    const title = await findTitleInput("Project");
    const bullet = screen.getByRole("button", { name: "Zoom into Project" });

    bullet.focus();
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: "More actions for Project" }),
    ).toHaveFocus();
    await user.keyboard("[Enter]");
    const keyboardMenu = await screen.findByRole("menu");
    expect(
      within(keyboardMenu).getByRole("menuitem", { name: "Complete" }),
    ).toHaveFocus();
    await user.keyboard("[Enter]");

    expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
      "/vault",
      "project",
      historyContextMatcher(),
    );
    const pointerMenu = await openNodeMenu("Project", user);
    const uncomplete = within(pointerMenu).getByRole("menuitem", {
      name: "Uncomplete",
    });

    fireEvent.pointerDown(title, { pointerType: "touch" });
    title.focus();
    expect(title.closest<HTMLElement>(".notes-node-main")).toContainElement(
      document.activeElement as HTMLElement | null,
    );
    fireEvent.pointerDown(uncomplete, { pointerType: "touch" });
    fireEvent.click(uncomplete);

    await waitFor(() =>
      expect(notesStoreMock.toggleComplete).toHaveBeenCalledTimes(2),
    );
  });

  it("suspends bullet drag activation while queued workspace work is loading", async () => {
    const user = userEvent.setup();
    const completion = deferred<NotesWorkspace>();
    notesStoreMock.toggleComplete.mockReturnValue(completion.promise);
    renderNotesWorkspace();
    const projectBullet = await screen.findByRole("button", {
      name: "Zoom into Project",
    });
    expect(projectBullet).toHaveAttribute("aria-describedby");

    const menu = await openNodeMenu("Project", user);
    await user.click(within(menu).getByRole("menuitem", { name: "Complete" }));
    await waitFor(() =>
      expect(notesStoreMock.toggleComplete).toHaveBeenCalledOnce(),
    );
    for (const bullet of screen.getAllByRole("button", {
      name: /^Zoom into /,
    })) {
      expect(bullet).toBeEnabled();
      expect(bullet).not.toHaveAttribute("aria-describedby");
    }

    completion.resolve(workspace(confirmedNodes));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zoom into Project" }),
      ).toHaveAttribute("aria-describedby"),
    );
  });

  it("announces an invalid self drop without queuing a move", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "second", sortKey: 2, title: "Second" }),
    ]);
    renderNotesWorkspace();
    const bullet = await screen.findByRole("button", {
      name: "Zoom into Second",
    });
    mockOutlineRowRects();

    bullet.focus();
    await user.keyboard("[Space][Space]");

    await waitFor(() =>
      expect(document.body).toHaveTextContent("No move was made for Second."),
    );
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
  });

  it("shows an ordinary pointer drag at its original boundary without moving", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "second", sortKey: 2, title: "Second" }),
    ]);
    renderNotesWorkspace();
    const first = await screen.findByRole("button", {
      name: "Zoom into First",
    });
    mockOutlineRowRects();
    const firstRect = first
      .closest<HTMLElement>("[data-outline-id]")!
      .getBoundingClientRect();
    const firstY = firstRect.top + firstRect.height / 2;

    await user.pointer({
      keys: "[MouseLeft>]",
      target: first,
      coords: { clientX: 9, clientY: firstY },
    });
    await user.pointer({
      target: first,
      coords: { clientX: 9, clientY: firstY + 5 },
    });
    await user.pointer({
      target: first,
      coords: { clientX: 9, clientY: firstY + 6 },
    });

    expect(
      document.querySelector(".notes-outline-drop-preview"),
    ).toHaveAttribute("data-before-id", "second");

    await user.pointer({
      keys: "[/MouseLeft]",
      target: first,
      coords: { clientX: 9, clientY: firstY + 6 },
    });

    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
  });

  it("blocks a GN root pointer drop that would reparent it", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 1,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({ id: "destination", sortKey: 2, title: "Destination" }),
      node({
        id: "destination-child",
        parentId: "destination",
        sortKey: 1,
        title: "Destination child",
      }),
      node({ id: "tail", sortKey: 3, title: "Tail" }),
    ]);
    renderNotesWorkspace();
    const github = await screen.findByRole("button", {
      name: `Zoom into ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
    });
    const destinationChild = screen.getByRole("button", {
      name: "Zoom into Destination child",
    });
    mockOutlineRowRects();
    const githubRect = github
      .closest<HTMLElement>("[data-outline-id]")!
      .getBoundingClientRect();
    const destinationChildRect = destinationChild
      .closest<HTMLElement>("[data-outline-id]")!
      .getBoundingClientRect();

    await user.pointer({
      keys: "[MouseLeft>]",
      target: github,
      coords: { clientX: 9, clientY: githubRect.top + githubRect.height / 2 },
    });
    await user.pointer({
      target: destinationChild,
      coords: {
        clientX: 45,
        clientY: destinationChildRect.top + destinationChildRect.height * 0.75,
      },
    });
    await user.pointer({
      target: destinationChild,
      coords: {
        clientX: 81,
        clientY: destinationChildRect.top + destinationChildRect.height * 0.75,
      },
    });

    expect(document.querySelector(".notes-outline-drop-preview")).toBeNull();

    await user.pointer({
      keys: "[/MouseLeft]",
      target: destinationChild,
      coords: {
        clientX: 81,
        clientY: destinationChildRect.top + destinationChildRect.height * 0.75,
      },
    });

    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
  });

  it("allows a GN root pointer reorder at the top level", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "before", sortKey: 1, title: "Before" }),
      node({
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        sortKey: 2,
        title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
        isReadonly: undefined,
        pluginState: { collapsedGroups: [] },
      }),
      node({ id: "after", sortKey: 3, title: "After" }),
    ]);
    renderNotesWorkspace();
    const github = await screen.findByRole("button", {
      name: `Zoom into ${GITHUB_NOTIFICATIONS_PROVIDER_TITLE}`,
    });
    const after = screen.getByRole("button", { name: "Zoom into After" });
    mockOutlineRowRects();
    const githubRect = github
      .closest<HTMLElement>("[data-outline-id]")!
      .getBoundingClientRect();
    const afterRect = after
      .closest<HTMLElement>("[data-outline-id]")!
      .getBoundingClientRect();

    await user.pointer({
      keys: "[MouseLeft>]",
      target: github,
      coords: { clientX: 9, clientY: githubRect.top + githubRect.height / 2 },
    });
    await user.pointer({
      target: after,
      coords: {
        clientX: 9,
        clientY: afterRect.top + afterRect.height * 0.75 - 1,
      },
    });
    await user.pointer({
      target: after,
      coords: { clientX: 9, clientY: afterRect.top + afterRect.height * 0.75 },
    });
    await user.pointer({
      keys: "[/MouseLeft]",
      target: after,
      coords: { clientX: 9, clientY: afterRect.top + afterRect.height * 0.75 },
    });

    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: GITHUB_NOTIFICATIONS_ROOT_ID,
        parentId: null,
        afterId: "after",
      },
      historyContextMatcher(),
    );
  });

  it("keeps an ordinary parent forest fixed and counts a collapsed descendant", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "parent", sortKey: 1, title: "Parent" }),
      node({
        id: "child",
        parentId: "parent",
        sortKey: 1,
        title: "Child",
        isCollapsed: true,
      }),
      node({ id: "hidden", parentId: "child", title: "Hidden" }),
      node({ id: "target", sortKey: 2, title: "Target" }),
    ]);
    renderNotesWorkspace();
    const parent = await screen.findByRole("button", {
      name: "Zoom into Parent",
    });
    const target = screen.getByRole("button", { name: "Zoom into Target" });
    mockOutlineRowRects();

    await user.pointer({
      keys: "[MouseLeft>]",
      target: parent,
      coords: { clientX: 9, clientY: 14 },
    });
    await user.pointer({
      target,
      coords: { clientX: 14, clientY: 70 },
    });

    const preview = screen.getByTestId("notes-selection-drag-preview");
    expect(preview).toHaveTextContent("Parent");
    expect(within(preview).getByText("3")).toHaveClass(
      "notes-selection-drag-preview-count",
    );
    for (const nodeId of ["parent", "child"]) {
      expect(
        document
          .querySelector(`[data-outline-id="${nodeId}"]`)
          ?.closest(".notes-outline-item"),
      ).toHaveAttribute("data-drag-source", "true");
    }
    expect(document.querySelector('[data-outline-id="hidden"]')).toBeNull();
    for (const row of document.querySelectorAll<HTMLElement>(".notes-node")) {
      expect(row.style.transform).toBe("");
      expect(row).not.toHaveAttribute("data-dragging");
    }

    await user.keyboard("[Escape]");

    expect(screen.queryByTestId("notes-selection-drag-preview")).toBeNull();
    expect(document.querySelector("[data-drag-source]")).toBeNull();
    await user.pointer({
      keys: "[/MouseLeft]",
      target,
      coords: { clientX: 14, clientY: 70 },
    });
  });

  it("freezes the representative overlay label while workspace state changes", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "source", sortKey: 1, title: "Original title" }),
      node({ id: "target", sortKey: 2, title: "Target" }),
    ]);
    renderNotesWorkspace();
    const title = await findTitleInput("Original title");
    const source = screen.getByRole("button", {
      name: "Zoom into Original title",
    });
    const target = screen.getByRole("button", { name: "Zoom into Target" });
    mockOutlineRowRects();

    await user.pointer({
      keys: "[MouseLeft>]",
      target: source,
      coords: { clientX: 9, clientY: 14 },
    });
    await user.pointer({
      target,
      coords: { clientX: 14, clientY: 42 },
    });
    const preview = screen.getByTestId("notes-selection-drag-preview");
    expect(preview).toHaveTextContent("Original title");

    fireEvent.change(title, { target: { value: "Confirmed later" } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(queryTitleInput("Confirmed later")).not.toBeNull(),
    );

    expect(preview).toHaveTextContent("Original title");
    expect(preview).not.toHaveTextContent("Confirmed later");

    await user.keyboard("[Escape]");
    await user.pointer({
      keys: "[/MouseLeft]",
      target,
      coords: { clientX: 14, clientY: 42 },
    });
  });

  it("reuses a ready image URL in the drag preview without attachment work", async () => {
    const user = userEvent.setup();
    const imageNode = node({
      id: "diagram-image",
      nodeKind: "image",
      sortKey: 1,
      title: "diagram.png",
    });
    const imageAttachment = attachment({
      id: "diagram-attachment",
      nodeId: imageNode.id,
      originalName: "diagram.png",
    });
    configureRepository(
      [imageNode, node({ id: "target", sortKey: 2, title: "Target" })],
      { [imageNode.id]: [imageAttachment] },
    );
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71]),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const createObjectURL = vi.fn(() => "blob:diagram");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    renderNotesWorkspace();

    await user.click(
      await screen.findByRole("button", { name: "Load image diagram.png" }),
    );
    await screen.findByRole("img", { name: "diagram.png" });
    const imageBullet = screen.getByRole("button", {
      name: "Zoom into diagram.png",
    });
    const targetBullet = screen.getByRole("button", {
      name: "Zoom into Target",
    });
    mockOutlineRowRects();
    const readsBeforeDrag =
      notesStoreMock.readAttachmentBytes.mock.calls.length;
    const urlsBeforeDrag = createObjectURL.mock.calls.length;

    await user.pointer({
      keys: "[MouseLeft>]",
      target: imageBullet,
      coords: { clientX: 9, clientY: 14 },
    });
    await user.pointer({
      target: targetBullet,
      coords: { clientX: 14, clientY: 42 },
    });

    expect(
      screen.getByTestId("notes-selection-drag-thumbnail"),
    ).toHaveAttribute("src", "blob:diagram");
    expect(notesStoreMock.readAttachmentBytes).toHaveBeenCalledTimes(
      readsBeforeDrag,
    );
    expect(createObjectURL).toHaveBeenCalledTimes(urlsBeforeDrag);

    await user.keyboard("[Escape]");
    await user.pointer({
      keys: "[/MouseLeft]",
      target: targetBullet,
      coords: { clientX: 14, clientY: 42 },
    });
  });

  it("uses the filename when a ready image leaves the outline viewport", async () => {
    const user = userEvent.setup();
    const imageNode = node({
      id: "diagram-image",
      nodeKind: "image",
      sortKey: 1,
      title: "diagram.png",
    });
    const imageAttachment = attachment({
      id: "diagram-attachment",
      nodeId: imageNode.id,
      originalName: "diagram.png",
    });
    configureRepository(
      [imageNode, node({ id: "target", sortKey: 2, title: "Target" })],
      { [imageNode.id]: [imageAttachment] },
    );
    notesStoreMock.readAttachmentBytes.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71]),
    );
    let intersectionCallback: IntersectionObserverCallback | undefined;
    let intersectionTarget: Element | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe(target: Element) {
          intersectionTarget = target;
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:diagram"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    renderNotesWorkspace();

    await screen.findByRole("button", { name: "Load image diagram.png" });
    const notifyVisibleIntersection = intersectionCallback;
    const visibleTarget = intersectionTarget;
    if (!notifyVisibleIntersection || !visibleTarget) {
      throw new Error("Expected the image residency observer to be active.");
    }
    act(() => {
      notifyVisibleIntersection(
        [
          {
            target: visibleTarget,
            isIntersecting: true,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });
    await waitFor(() =>
      expect(notesStoreMock.readAttachmentBytes).toHaveBeenCalled(),
    );
    const readsBeforeDrag =
      notesStoreMock.readAttachmentBytes.mock.calls.length;
    const readyImage = await screen.findByRole("img", { name: "diagram.png" });
    const imageBullet = screen.getByRole("button", {
      name: "Zoom into diagram.png",
    });
    const rectangle = (top: number, height: number) =>
      ({
        x: 0,
        y: top,
        top,
        left: 0,
        right: 640,
        bottom: top + height,
        width: 640,
        height,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("notes-outline-rows")) {
          return rectangle(0, 100);
        }
        const row = this.closest<HTMLElement>("[data-outline-id]");
        return row?.dataset.outlineId === imageNode.id
          ? rectangle(-56, 28)
          : rectangle(28, 28);
      },
    );

    vi.useFakeTimers();
    const notifyHiddenIntersection = intersectionCallback;
    const hiddenTarget = intersectionTarget;
    if (!notifyHiddenIntersection || !hiddenTarget) {
      throw new Error("Expected the image residency observer to be active.");
    }
    act(() => {
      notifyHiddenIntersection(
        [
          {
            target: hiddenTarget,
            isIntersecting: false,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });
    expect(readyImage).toBeInTheDocument();
    vi.useRealTimers();

    imageBullet.focus();
    await user.keyboard("[Space]");

    const preview = screen.getByTestId("notes-selection-drag-preview");
    expect(preview).toHaveTextContent("diagram.png");
    expect(screen.queryByTestId("notes-selection-drag-thumbnail")).toBeNull();
    expect(readyImage).toBeInTheDocument();
    expect(notesStoreMock.readAttachmentBytes).toHaveBeenCalledTimes(
      readsBeforeDrag,
    );

    await user.keyboard("[Escape]");
  });

  it("uses the filename while a dragged image is not loaded", async () => {
    const user = userEvent.setup();
    const imageNode = node({
      id: "diagram-image",
      nodeKind: "image",
      sortKey: 1,
      title: "diagram.png",
    });
    const imageAttachment = attachment({
      id: "diagram-attachment",
      nodeId: imageNode.id,
      originalName: "diagram.png",
    });
    configureRepository(
      [imageNode, node({ id: "target", sortKey: 2, title: "Target" })],
      { [imageNode.id]: [imageAttachment] },
    );
    renderNotesWorkspace();
    const imageBullet = await screen.findByRole("button", {
      name: "Zoom into diagram.png",
    });
    const targetBullet = screen.getByRole("button", {
      name: "Zoom into Target",
    });
    mockOutlineRowRects();

    await user.pointer({
      keys: "[MouseLeft>]",
      target: imageBullet,
      coords: { clientX: 9, clientY: 14 },
    });
    await user.pointer({
      target: targetBullet,
      coords: { clientX: 14, clientY: 42 },
    });

    const preview = screen.getByTestId("notes-selection-drag-preview");
    expect(preview).toHaveTextContent("diagram.png");
    expect(screen.queryByTestId("notes-selection-drag-thumbnail")).toBeNull();
    expect(notesStoreMock.readAttachmentBytes).not.toHaveBeenCalled();

    await user.keyboard("[Escape]");
    await user.pointer({
      keys: "[/MouseLeft]",
      target: targetBullet,
      coords: { clientX: 14, clientY: 42 },
    });
  });

  it("uses exact image filenames in drag announcements without rendering them visibly", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "diagram-image",
        nodeKind: "image",
        sortKey: 1,
        title: "diagram.png",
      }),
      node({
        id: "photo-image",
        nodeKind: "image",
        sortKey: 2,
        title: "photo.png",
      }),
    ]);
    renderNotesWorkspace();
    const diagramBullet = await screen.findByRole("button", {
      name: "Zoom into diagram.png",
    });
    const photoBullet = await screen.findByRole("button", {
      name: "Zoom into photo.png",
    });
    mockOutlineRowRects();

    for (const row of document.querySelectorAll(".notes-node")) {
      expect(row).not.toHaveTextContent(/diagram\.png|photo\.png/);
    }

    diagramBullet.focus();
    await user.keyboard("[Space][Space]");

    await waitFor(() =>
      expect(document.body).toHaveTextContent(
        "No move was made for diagram.png.",
      ),
    );
    photoBullet.focus();
    await user.keyboard("[Space][Space]");

    await waitFor(() =>
      expect(document.body).toHaveTextContent(
        "No move was made for photo.png.",
      ),
    );
    for (const row of document.querySelectorAll(".notes-node")) {
      expect(row).not.toHaveTextContent(/diagram\.png|photo\.png/);
    }
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
  });

  it("moves before the first row by keyboard through one queued action without optimistic order", async () => {
    const user = userEvent.setup();
    const move = deferred<NotesWorkspace>();
    configureRepository([
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "second", sortKey: 2, title: "Second" }),
    ]);
    notesStoreMock.moveNode.mockReturnValue(move.promise);
    renderNotesWorkspace();
    const bullet = await screen.findByRole("button", {
      name: "Zoom into Second",
    });
    mockOutlineRowRects();

    bullet.focus();
    await user.keyboard("[Space][ArrowUp][Space]");

    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "second",
        parentId: null,
        afterId: null,
        beforeId: "first",
      },
      historyContextMatcher(),
    );
    expect(
      textareasByName("Edit node title").map((input) => input.value),
    ).toEqual(["First", "Second"]);

    move.resolve(
      workspace([
        node({ id: "first", sortKey: 2, title: "First" }),
        node({ id: "second", sortKey: 1, title: "Second" }),
      ]),
    );
    await waitFor(() =>
      expect(
        textareasByName("Edit node title").map((input) => input.value),
      ).toEqual(["Second", "First"]),
    );
  });

  it("expands a collapsed drop parent before one pointer-driven child move", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "active", sortKey: 1, title: "Active" }),
      node({ id: "parent", sortKey: 2, title: "Parent", isCollapsed: true }),
      node({ id: "hidden", parentId: "parent", title: "Hidden" }),
    ]);
    renderNotesWorkspace();
    const activeBullet = await screen.findByRole("button", {
      name: "Zoom into Active",
    });
    const parentBullet = screen.getByRole("button", {
      name: "Zoom into Parent",
    });
    mockOutlineRowRects();

    await user.pointer({
      keys: "[MouseLeft>]",
      target: activeBullet,
      coords: { clientX: 9, clientY: 14 },
    });
    await user.pointer({
      target: parentBullet,
      coords: { clientX: 14, clientY: 20 },
    });
    expect(activeBullet.closest(".notes-node")).not.toHaveAttribute(
      "data-dragging",
    );
    expect(
      activeBullet.closest<HTMLElement>(".notes-node")?.style.transform,
    ).toBe("");
    expect(
      screen.getByTestId("notes-selection-drag-preview"),
    ).toHaveTextContent("Active");
    await user.pointer({
      target: parentBullet,
      coords: { clientX: 36, clientY: 42 },
    });
    expect(document.body).toHaveTextContent("Active is over Parent.");
    const previews = document.querySelectorAll(".notes-outline-drop-preview");
    const movedBeforeDrop = notesStoreMock.moveNode.mock.calls.length > 0;
    await user.pointer({
      keys: "[/MouseLeft]",
      target: parentBullet,
      coords: { clientX: 36, clientY: 42 },
    });

    expect(previews).toHaveLength(1);
    expect(previews[0]).toHaveAttribute("aria-hidden", "true");
    expect(previews[0]).toHaveAttribute("data-parent-id", "parent");
    expect(previews[0]).toHaveAttribute("data-depth", "1");
    expect(
      (previews[0] as HTMLElement).style.getPropertyValue("--notes-drop-depth"),
    ).toBe("1");
    expect(movedBeforeDrop).toBe(false);

    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(document.body).toHaveTextContent(
        "Queued move for Active at Parent.",
      ),
    );
    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
      "/vault",
      "parent",
      historyContextMatcher(),
    );
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "active",
        parentId: "parent",
        afterId: "hidden",
      },
      historyContextMatcher(),
    );
    expect(
      notesStoreMock.toggleCollapsed.mock.invocationCallOrder[0],
    ).toBeLessThan(notesStoreMock.moveNode.mock.invocationCallOrder[0]);
    expect(screen.getByRole("button", { name: "All notes" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("lists root pages only and zooms through the full breadcrumb trail", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    const library = screen.getByLabelText("Notes library");
    expect(
      await within(library).findByRole("button", { name: "Project" }),
    ).toBeInTheDocument();
    expect(
      within(library).getByRole("button", { name: "Outside branch" }),
    ).toBeInTheDocument();
    expect(
      within(library).queryByRole("button", { name: "Plan" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    const breadcrumb = screen.getByLabelText("Notes breadcrumb");
    expect(
      within(breadcrumb).getByRole("button", { name: "Project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Zoom into Project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Zoom into Plan" }),
    ).toBeVisible();
    expect(getTitleInput("Plan").closest("li")).toHaveAttribute(
      "aria-level",
      "1",
    );
    const projectNote = getTextareaByName("Supporting note: Project");
    expect(projectNote).toHaveValue("Project note");
    expect(projectNote.closest(".notes-page-header")).not.toBeNull();
    expect(projectNote.closest("ol")).toBeNull();
    expect(queryTitleInput("Outside branch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Zoom into Plan" }));
    expect(
      within(breadcrumb).getByRole("button", { name: "Project" }),
    ).toBeInTheDocument();
    expect(
      within(breadcrumb).getByRole("button", { name: "Plan" }),
    ).toBeInTheDocument();
    expect(queryTitleInput("Project")).not.toBeInTheDocument();
  });

  it("uses stable presentation for page fields and every row text field", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    const rowTitle = await findTitleInput("Project");

    const rowNote = getTextareaByName("Supporting note: Project");
    expect(rowTitle.closest(".notes-text-field")).toHaveAttribute(
      "data-stable-presentation",
      "true",
    );
    expect(rowNote.closest(".notes-text-field")).toHaveAttribute(
      "data-stable-presentation",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    await screen.findByRole("heading", { name: "Project", level: 1 });

    const pageTitle = document.querySelector(
      "textarea.notes-page-title",
    ) as HTMLTextAreaElement;
    const pageNote = getTextareaByName("Supporting note: Project");
    expect(pageTitle.closest(".notes-text-field")).toHaveAttribute(
      "data-stable-presentation",
      "true",
    );
    expect(pageNote.closest(".notes-text-field")).toHaveAttribute(
      "data-stable-presentation",
      "true",
    );
  });

  it("uses the owned filename fallback in image breadcrumbs", async () => {
    const user = userEvent.setup();
    configureRepository(
      [
        node({
          id: "image-page",
          nodeKind: "image",
          title: "",
          imageOffsetUtf16: 0,
        }),
      ],
      {
        "image-page": [
          attachment({
            id: "image-attachment",
            nodeId: "image-page",
            originalName: "private-filename.png",
          }),
        ],
      },
    );
    renderNotesWorkspace();

    await user.click(
      await screen.findByRole("button", {
        name: "Image: private-filename.png",
      }),
    );
    const breadcrumb = screen.getByLabelText("Notes breadcrumb");

    expect(
      within(breadcrumb).getByRole("button", { name: "private-filename.png" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(breadcrumb).queryByRole("button", {
        name: "Image",
      }),
    ).not.toBeInTheDocument();
  });

  it("draws the native image-drop marker after an expanded target subtree", async () => {
    const target = node({ id: "target", sortKey: 1, title: "Target" });
    const child = node({
      id: "child",
      parentId: target.id,
      sortKey: 1,
      title: "Child",
    });
    const sibling = node({ id: "sibling", sortKey: 2, title: "Sibling" });
    configureRepository([target, child, sibling]);
    let dropListener:
      Parameters<NotesAttachmentUiBoundary["subscribeToImageDrop"]>[0] | null =
      null;
    const attachmentUi: NotesAttachmentUiBoundary = {
      openImageFiles: vi.fn().mockResolvedValue(null),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockImplementation(async (listener) => {
        dropListener = listener;
        return vi.fn();
      }),
    };
    const originalElementFromPoint = Object.getOwnPropertyDescriptor(
      document,
      "elementFromPoint",
    );
    renderNotesWorkspace(attachmentUi);
    const targetRow = (await findTitleInput("Target")).closest(".notes-node");
    const childItem = (await findTitleInput("Child")).closest("li");
    expect(targetRow).not.toBeNull();
    expect(childItem).not.toBeNull();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => targetRow),
    });

    try {
      await waitFor(() => expect(dropListener).toBeTypeOf("function"));
      act(() =>
        dropListener?.({
          type: "enter",
          paths: ["/incoming/subtree.png"],
          position: { x: 10, y: 10 },
        }),
      );

      const markers = await screen.findAllByTestId("notes-image-drop-position");
      expect(markers).toHaveLength(1);
      expect(childItem).toContainElement(markers[0]);
      expect(targetRow).toHaveAttribute("data-image-drop-active", "true");
      expect(targetRow).not.toContainElement(markers[0]);
    } finally {
      if (originalElementFromPoint) {
        Object.defineProperty(
          document,
          "elementFromPoint",
          originalElementFromPoint,
        );
      } else {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    }
  });

  it("focuses a created title exactly once across row unmount and remount", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(notesStoreMock.createNode).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({ parentId: null, title: "", note: "" }),
      historyContextMatcher(),
    );
    expect(await findTitleInput("")).toHaveFocus();
    const blankTitleFocusCount = () =>
      focusSpy.mock.contexts.filter(
        (context) =>
          context instanceof HTMLTextAreaElement && context.value === "",
      ).length;
    expect(blankTitleFocusCount()).toBe(1);

    await user.click(screen.getByRole("button", { name: "Project" }));
    await waitFor(() => expect(queryTitleInput("")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "All notes" }));

    expect(await findTitleInput("")).toBeInTheDocument();
    expect(blankTitleFocusCount()).toBe(1);
    expect(notesStoreMock.createNode).toHaveBeenCalledOnce();
  });

  it("unzooms an All view before focusing a newly created root page", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    expect(
      screen.getByRole("heading", { name: "Project", level: 1 }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(await findTitleInput("")).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: "Project", level: 1 }),
    ).not.toBeInTheDocument();
  });

  it("returns to unzoomed All so a page created from zoomed Starred stays visible and focused", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "starred", title: "Starred page", isStarred: true }),
      node({ id: "outside", title: "Outside page" }),
    ]);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(
          scope.kind === "starred"
            ? confirmedNodes.filter((current) => current.isStarred)
            : confirmedNodes,
        ),
    );
    renderNotesWorkspace();
    await findTitleInput("Starred page");

    await user.click(screen.getByRole("button", { name: "Starred" }));
    await waitFor(() => expect(queryTitleInput("Outside page")).toBeNull());
    await user.click(
      screen.getByRole("button", { name: "Zoom into Starred page" }),
    );
    expect(
      screen.getByRole("heading", { name: "Starred page", level: 1 }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "New page" }));

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await findTitleInput("")).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: "Starred page", level: 1 }),
    ).not.toBeInTheDocument();
    expect(queryTitleInput("Outside page")).toBeInTheDocument();
    expect(notesStoreMock.createNode).toHaveBeenCalledOnce();
  });

  it("marks the active library root as the current page", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();

    const library = screen.getByLabelText("Notes library");
    const project = await within(library).findByRole("button", {
      name: "Project",
    });

    await user.click(project);

    expect(project).toHaveAttribute("aria-current", "page");
  });

  it("exposes visible outline rows as list items with accurate levels", async () => {
    renderNotesWorkspace();

    const outline = screen.getByLabelText("Notes outline");
    await findTitleInput("Project");

    expect(within(outline).getByRole("list")).toHaveAttribute("role", "list");
    expect(
      within(outline)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-level")),
    ).toEqual(["1", "2", "3", "1"]);
    for (const item of within(outline).getAllByRole("listitem")) {
      expect(item).toHaveAttribute("role", "listitem");
    }

    const projectRow =
      getTitleInput("Project").closest<HTMLElement>(".notes-node");
    const planRow = getTitleInput("Plan").closest<HTMLElement>(".notes-node");
    const milestoneRow =
      getTitleInput("Milestone").closest<HTMLElement>(".notes-node");
    const outsideRow =
      getTitleInput("Outside branch").closest<HTMLElement>(".notes-node");

    expect(projectRow).toHaveAttribute("data-guide-end-id", "milestone");
    expect(planRow).toHaveAttribute("data-guide-end-id", "milestone");
    expect(milestoneRow).not.toHaveAttribute("data-guide-end-id");
    expect(outsideRow).not.toHaveAttribute("data-guide-end-id");
    expect(projectRow?.querySelectorAll(".notes-node-guide")).toHaveLength(0);
    expect(planRow?.querySelectorAll(".notes-node-guide")).toHaveLength(1);
    expect(milestoneRow?.querySelectorAll(".notes-node-guide")).toHaveLength(2);
    for (const guide of outline.querySelectorAll(".notes-node-guide")) {
      expect(guide).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("composes the labelled breadcrumb home button with an icon tooltip", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");

    const home = screen.getByRole("button", { name: "All notes" });

    expect(home).toHaveAttribute("aria-label", "All notes");
    expect(home).toHaveAttribute("data-base-ui-tooltip-trigger");
  });

  it("shares one centered content column between the page header and outline", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    const outline = screen.getByLabelText("Notes outline");
    const allNotesContent = within(outline)
      .getByRole("list")
      .closest<HTMLElement>(".notes-outline-content");

    expect(allNotesContent).not.toHaveAttribute("data-zoomed-page");

    await user.click(screen.getByRole("button", { name: "Project" }));

    const heading = await screen.findByRole("heading", {
      name: "Project",
      level: 1,
    });
    const content = heading.closest<HTMLElement>(".notes-outline-content");

    expect(content).not.toBeNull();
    expect(content).toHaveAttribute("data-zoomed-page", "true");
    expect(within(content!).getByRole("list")).toBeInTheDocument();
    expect(content?.querySelector(".notes-child-composer")).not.toBeNull();
  });

  it("uses uncapped depth-based indentation from the outline root", async () => {
    configureRepository(
      Array.from({ length: 12 }, (_, index) =>
        node({
          id: `depth-${index + 1}`,
          parentId: index === 0 ? null : `depth-${index}`,
          sortKey: 1,
          title: `Depth ${index + 1}`,
        }),
      ),
    );
    renderNotesWorkspace();

    const deepestTitle = await findTitleInput("Depth 12");
    const deepestRow = deepestTitle.closest<HTMLElement>(".notes-node");

    expect(deepestRow).not.toBeNull();
    expect(deepestRow?.style.getPropertyValue("--notes-depth")).toBe("11");
    expect(deepestRow?.style.getPropertyValue("--notes-indent")).toBe("");
    expect(
      screen
        .getByLabelText("Notes outline")
        .style.getPropertyValue("--notes-outline-indent"),
    ).toBe("36px");
  });

  it("uses the 28px runtime indent token at narrow widths", async () => {
    mockNarrowViewport(true);
    renderNotesWorkspace();

    await findTitleInput("Project");

    expect(
      screen
        .getByLabelText("Notes outline")
        .style.getPropertyValue("--notes-outline-indent"),
    ).toBe("28px");
  });

  it("persists collapse and completion only after authoritative responses", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Plan");

    const collapse = screen.getByRole("button", { name: "Collapse Project" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);

    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
      "/vault",
      "project",
      historyContextMatcher(),
    );
    await waitFor(() =>
      expect(queryTitleInput("Plan")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Expand Project" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Zoom into Project" }),
    ).toHaveAttribute("data-collapsed", "true");

    const menu = await openNodeMenu("Project", user);
    await user.click(within(menu).getByRole("menuitem", { name: "Complete" }));
    expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
      "/vault",
      "project",
      historyContextMatcher(),
    );
    await waitFor(() =>
      expect(notesStoreMock.toggleComplete).toHaveBeenCalledOnce(),
    );
    const updatedMenu = await openNodeMenu("Project", user);
    expect(
      within(updatedMenu).getByRole("menuitem", { name: "Uncomplete" }),
    ).toBeVisible();
  });

  it("hides completed node subtrees only in the visible projection", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "done",
        sortKey: 1,
        title: "Completed project",
        completedAt: "2026-07-10T01:00:00Z",
      }),
      node({ id: "done-child", parentId: "done", title: "Hidden child" }),
      node({ id: "active", sortKey: 2, title: "Active project" }),
    ]);
    renderNotesWorkspace();
    await findTitleInput("Completed project");

    const toggle = screen.getByRole("button", { name: "Completed items" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);

    expect(queryTitleInput("Completed project")).toBeNull();
    expect(queryTitleInput("Hidden child")).toBeNull();
    expect(getTitleInput("Active project")).toBeVisible();
    expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    expect(toggle).toHaveAccessibleName("Completed items");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(await findTitleInput("Completed project")).toBeVisible();
    expect(getTitleInput("Hidden child")).toBeVisible();
  });

  it("explains when all root rows are hidden and the toggle restores them", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "done",
        title: "Completed project",
        completedAt: "2026-07-10T01:00:00Z",
      }),
      node({ id: "done-child", parentId: "done", title: "Hidden child" }),
    ]);
    renderNotesWorkspace();
    await findTitleInput("Completed project");
    const toggle = screen.getByRole("button", { name: "Completed items" });

    await user.click(toggle);

    expect(screen.getByText("Completed items are hidden.")).toBeVisible();
    expect(screen.queryByText("No outline yet.")).toBeNull();
    expect(queryTitleInput("Completed project")).toBeNull();

    await user.click(toggle);

    expect(await findTitleInput("Completed project")).toBeVisible();
    expect(screen.queryByText("Completed items are hidden.")).toBeNull();
  });

  it("keeps a completed zoom root header and its commands when rows are hidden", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "done",
        title: "Completed project",
        completedAt: "2026-07-10T01:00:00Z",
      }),
      node({ id: "done-child", parentId: "done", title: "Hidden child" }),
    ]);
    renderNotesWorkspace();
    await findTitleInput("Completed project");
    await user.click(
      screen.getByRole("button", { name: "Zoom into Completed project" }),
    );

    const toggle = screen.getByRole("button", { name: "Completed items" });
    await user.click(toggle);

    expect(
      screen.getByRole("heading", { name: "Completed project", level: 1 }),
    ).toBeVisible();
    expect(queryTitleInput("Hidden child")).toBeNull();
    expect(screen.getByText("Completed items are hidden.")).toBeVisible();
    const menu = await openNodeMenu("Completed project", user);
    expect(
      within(menu).getByRole("menuitem", { name: "Uncomplete" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(toggle);
    expect(await findTitleInput("Hidden child")).toBeVisible();
    expect(screen.queryByText("Completed items are hidden.")).toBeNull();
  });

  it("writes a title on blur with the current supporting note", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    expect(title).toHaveAccessibleName("Edit node title");

    await user.clear(title);
    await user.type(title, "Renamed project");
    expect(title).toHaveAccessibleName("Edit node title");
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    fireEvent.blur(title);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "Renamed project",
          note: "Project note",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
  });

  it("persists the slash Today command from an outline title", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace(undefined, { year: 2026, month: 7, day: 11 });
    const title = await findTitleInput("Project");

    await user.clear(title);
    await user.type(title, "/");
    await user.click(screen.getByRole("option", { name: /Today/ }));

    await waitFor(() => expect(title).toHaveValue("2026-07-11"));
    fireEvent.blur(title);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "2026-07-11",
          note: "Project note",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
  });

  it("persists the slash Today command from a zoomed page title", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace(undefined, { year: 2026, month: 7, day: 11 });
    await findTitleInput("Project");
    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    const title = await activatePageTitle();

    await user.clear(title);
    await user.type(title, "/tod");
    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);

    await waitFor(() => expect(title).toHaveValue("2026-07-11"));
    fireEvent.blur(title);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "2026-07-11",
          note: "Project note",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
  });

  it("coalesces rapid title edits into one write after 300 ms", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    vi.useFakeTimers();

    fireEvent.change(title, { target: { value: "Project one" } });
    fireEvent.change(title, { target: { value: "Project latest" } });

    await vi.advanceTimersByTimeAsync(299);
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "project",
        title: "Project latest",
        note: "Project note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
  });

  it("flushes a title on blur without a later duplicate timer write", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    vi.useFakeTimers();

    fireEvent.change(title, { target: { value: "Blurred project" } });
    fireEvent.blur(title);

    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("keeps a failed title draft visible and retries the failed patch", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(
        workspace(
          initialNodes().map((current) =>
            current.id === "project"
              ? { ...current, title: "Project next" }
              : current,
          ),
        ),
      );
    renderNotesWorkspace();
    const title = await findTitleInput("Project");

    fireEvent.change(title, { target: { value: "Project next" } });
    fireEvent.blur(title);

    const failedMenu = await openNodeMenu("Project next", user);
    expect(title).toHaveValue("Project next");
    await user.click(
      within(failedMenu).getByRole("menuitem", { name: "Retry save" }),
    );

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2),
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "project",
        title: "Project next",
        note: "Project note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    const savedMenu = await openNodeMenu("Project next", user);
    expect(
      within(savedMenu).queryByRole("menuitem", { name: "Retry save" }),
    ).toBeNull();
  });

  it("retries the latest visible draft instead of a stale failed patch", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(
        workspace(
          initialNodes().map((current) =>
            current.id === "project"
              ? { ...current, title: "Newest visible title" }
              : current,
          ),
        ),
      );
    renderNotesWorkspace();
    const title = await findTitleInput("Project");

    fireEvent.change(title, { target: { value: "Failed title" } });
    fireEvent.blur(title);
    const failedMenu = await openNodeMenu("Failed title", user);
    const retry = within(failedMenu).getByRole("menuitem", {
      name: "Retry save",
    });
    title.focus();
    fireEvent.change(title, { target: { value: "Newest visible title" } });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2),
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "project",
        title: "Newest visible title",
        note: "Project note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    expect(title).toHaveValue("Newest visible title");
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2),
    );
  });

  it("renders and retries a failed unmount draft after a same-vault remount", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode.mockRejectedValueOnce(new Error("disk full"));
    const firstMount = renderNotesWorkspace();
    const firstTitle = await findTitleInput("Project");

    fireEvent.change(firstTitle, { target: { value: "Recovered project" } });
    firstMount.unmount();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();

    renderNotesWorkspace();
    const recoveredTitle = await findTitleInput("Recovered project");
    expect(recoveredTitle).toHaveValue("Recovered project");

    const failedMenu = await openNodeMenu("Recovered project", user);
    await user.click(
      within(failedMenu).getByRole("menuitem", { name: "Retry save" }),
    );

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2),
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "project",
        title: "Recovered project",
        note: "Project note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    const savedMenu = await openNodeMenu("Recovered project", user);
    expect(
      within(savedMenu).queryByRole("menuitem", { name: "Retry save" }),
    ).toBeNull();
  });

  it("retries only the failed draft belonging to the clicked row", async () => {
    const user = userEvent.setup();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("project failed"))
      .mockRejectedValueOnce(new Error("outside failed"));
    renderNotesWorkspace();
    const projectTitle = await findTitleInput("Project");
    const outsideTitle = getTitleInput("Outside branch");

    fireEvent.change(projectTitle, {
      target: { value: "Failed project draft" },
    });
    fireEvent.blur(projectTitle);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(1),
    );

    fireEvent.change(outsideTitle, {
      target: { value: "Failed outside draft" },
    });
    fireEvent.blur(outsideTitle);
    const projectMenu = await openNodeMenu("Failed project draft", user);
    await user.click(
      within(projectMenu).getByRole("menuitem", { name: "Retry save" }),
    );

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(3),
    );
    expect(notesStoreMock.updateNode).toHaveBeenNthCalledWith(
      3,
      "/vault",
      {
        id: "project",
        title: "Failed project draft",
        note: "Project note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    const savedProjectMenu = await openNodeMenu("Failed project draft", user);
    expect(
      within(savedProjectMenu).queryByRole("menuitem", { name: "Retry save" }),
    ).toBeNull();
    await user.keyboard("{Escape}");
    const outsideMenu = await openNodeMenu("Failed outside draft", user);
    expect(
      within(outsideMenu).getByRole("menuitem", { name: "Retry save" }),
    ).toBeVisible();
    expect(outsideTitle).toHaveValue("Failed outside draft");
  });

  it("shows and writes a nonempty supporting note on blur with the current title", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    const note = getTextareaByName("Supporting note: Project");
    expect(note).toHaveValue("Project note");

    await user.clear(note);
    await user.type(note, "Updated context");
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    fireEvent.blur(note);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "Project",
          note: "Updated context",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
  });

  it("removes a row supporting note through the draft queue without deleting its node", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");
    const trigger = screen.getByRole("button", {
      name: "More actions for Project",
    });

    const menu = await openNodeMenu("Project", user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Remove note" }),
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() =>
      expect(
        queryTextareaByName("Supporting note: Project"),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "Project",
          note: "",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
    expect(getTitleInput("Project")).toBeInTheDocument();
    expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
  });

  it("keeps an empty supporting note hidden until the bullet menu opens it", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Outside branch");

    expect(
      queryTextareaByName("Supporting note: Outside branch"),
    ).not.toBeInTheDocument();

    const menu = await openNodeMenu("Outside branch", user);
    const trigger = screen.getByRole("button", {
      name: "More actions for Outside branch",
    });
    await user.click(within(menu).getByRole("menuitem", { name: "Add note" }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() =>
      expect(
        getTextareaByName("Supporting note: Outside branch"),
      ).toHaveFocus(),
    );
    expect(trigger).not.toHaveFocus();

    const note = getTextareaByName("Supporting note: Outside branch");
    fireEvent.blur(note);
    await waitFor(() =>
      expect(
        queryTextareaByName("Supporting note: Outside branch"),
      ).not.toBeInTheDocument(),
    );
  });

  it("collapses a whitespace-only supporting note and normalizes its draft on blur", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");

    fireEvent.change(note, { target: { value: " \t " } });
    fireEvent.blur(note);

    await waitFor(() =>
      expect(
        queryTextareaByName("Supporting note: Project"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "Project",
          note: "",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
  });

  it("settles a blurred composing empty supporting note from its final value", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Outside branch");
    const menu = await openNodeMenu("Outside branch", user);
    await user.click(within(menu).getByRole("menuitem", { name: "Add note" }));
    const note = await findTextareaByName("Supporting note: Outside branch");

    vi.useFakeTimers();
    notesStoreMock.updateNode.mockClear();
    fireEvent.compositionStart(note);
    note.blur();
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(
      queryTextareaByName("Supporting note: Outside branch"),
    ).toBeInTheDocument();

    fireEvent.compositionEnd(note, { target: { value: "Committed IME note" } });

    expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "outside",
        title: "Outside branch",
        note: "Committed IME note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(1);
    expect(
      queryTextareaByName("Supporting note: Outside branch"),
    ).toBeInTheDocument();
  });

  it("reflows a revealed long row note when its observed width narrows", async () => {
    const user = userEvent.setup();
    const callbacksByTarget = new Map<Element, ResizeObserverCallback>();
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    let noteScrollHeight = 40;
    const scrollHeight = vi
      .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLTextAreaElement) {
        return this.classList.contains("notes-node-note")
          ? noteScrollHeight
          : 28;
      });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          observe(target);
          callbacksByTarget.set(target, this.callback);
        }
        unobserve(target: Element) {
          unobserve(target);
          callbacksByTarget.delete(target);
        }
        disconnect = disconnect;
      },
    );
    configureRepository([node({ id: "project", title: "Project" })]);
    const view = renderNotesWorkspace();
    await findTitleInput("Project");

    const menu = await openNodeMenu("Project", user);
    await user.click(within(menu).getByRole("menuitem", { name: "Add note" }));
    const note = await findTextareaByName("Supporting note: Project");
    const longNote =
      "긴 한국어 보조 메모도 데스크톱에서 모바일 너비로 줄어들면 모든 문장이 잘리지 않고 다시 줄바꿈되어야 합니다";
    fireEvent.change(note, { target: { value: longNote } });

    expect(note).toHaveFocus();
    expect(note).toHaveStyle({ height: "40px" });
    expect(observe).toHaveBeenCalledWith(note);

    const callback = callbacksByTarget.get(note);
    act(() =>
      callback?.(
        [
          {
            target: note,
            contentRect: { width: 620 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
    );
    noteScrollHeight = 80;
    act(() =>
      callback?.(
        [
          {
            target: note,
            contentRect: { width: 280 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
    );
    expect(note).toHaveStyle({ height: "80px" });

    const measuredCalls = scrollHeight.mock.calls.length;
    act(() =>
      callback?.(
        [
          {
            target: note,
            contentRect: { width: 280 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
    );
    expect(scrollHeight).toHaveBeenCalledTimes(measuredCalls);

    view.unmount();
    expect(unobserve).toHaveBeenCalledWith(note);
    expect(disconnect).toHaveBeenCalled();
  });

  it("debounces supporting-note edits with the latest title patch", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");
    vi.useFakeTimers();

    fireEvent.change(note, { target: { value: "First note" } });
    fireEvent.change(note, { target: { value: "Latest note" } });
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "project",
        title: "Project",
        note: "Latest note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
  });

  it("preserves newer title and note drafts when an older blur save resolves", async () => {
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValueOnce(save.promise);
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");

    fireEvent.change(title, { target: { value: "Submitted title" } });
    fireEvent.change(note, { target: { value: "Submitted note" } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "Submitted title",
          note: "Project note",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );

    fireEvent.change(title, { target: { value: "Newer title" } });
    fireEvent.change(note, { target: { value: "Newer note" } });
    await act(async () =>
      save.resolve(
        workspace(
          initialNodes().map((current) =>
            current.id === "project"
              ? {
                  ...current,
                  title: "Submitted title",
                  note: "Submitted note",
                }
              : current,
          ),
        ),
      ),
    );

    await waitFor(() => {
      expect(title).toHaveValue("Newer title");
      expect(note).toHaveValue("Newer note");
    });
  });

  it("creates and focuses a first child from terminal Enter on a parent row", async () => {
    const parent = node({ id: "parent", sortKey: 1, title: "Parent" });
    const existingChild = node({
      id: "existing-child",
      parentId: "parent",
      sortKey: 2,
      title: "Existing child",
    });
    configureRepository([parent, existingChild]);
    const creation = deferred<NotesWorkspace>();
    notesStoreMock.createNode.mockReturnValue(creation.promise);
    const expectedNodeId = "00000000-0000-4000-8000-000000000004";
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue(expectedNodeId);
    renderNotesWorkspace();
    const title = await findTitleInput("Parent");
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);
    const idsBeforeCreate = randomUUID.mock.calls.length;

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    const allocatedAtKeydown =
      randomUUID.mock.calls.length === idsBeforeCreate + 1;

    await waitFor(() =>
      expect(notesStoreMock.createNode).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.createNode).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({
        id: expectedNodeId,
        parentId: "parent",
        afterId: null,
        beforeId: "existing-child",
        title: "",
        note: "",
      }),
      historyContextMatcher(),
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    expect(
      document.querySelectorAll('textarea[aria-label="Edit node title"]'),
    ).toHaveLength(2);
    expect(title).toHaveFocus();

    await act(async () =>
      creation.resolve(
        workspace([
          parent,
          node({
            id: expectedNodeId,
            parentId: "parent",
            sortKey: 1,
            title: "",
            note: "",
          }),
          existingChild,
        ]),
      ),
    );
    expect(allocatedAtKeydown).toBe(true);
    expect(await findTitleInput("")).toHaveFocus();
    randomUUID.mockRestore();
  });

  it("preserves a dirty parent draft and caret when first-child UUID allocation fails", async () => {
    configureRepository([
      node({ id: "parent", sortKey: 1, title: "Parent" }),
      node({
        id: "existing-child",
        parentId: "parent",
        sortKey: 2,
        title: "Existing child",
      }),
    ]);
    renderNotesWorkspace();
    const title = await findTitleInput("Parent");
    fireEvent.change(title, { target: { value: "Parent draft" } });
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);
    const caret = title.value.length;
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementationOnce(() => {
        throw new Error("uuid failed");
      });

    expect(() => fireEvent.keyDown(title, { key: "Enter" })).not.toThrow();
    await act(async () => undefined);
    expect(notesStoreMock.createNode).not.toHaveBeenCalled();
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    expect(title).toHaveValue("Parent draft");
    expect(title).toHaveFocus();
    expect(title.selectionStart).toBe(caret);
    expect(title.selectionEnd).toBe(caret);

    randomUUID.mockRestore();
    fireEvent.blur(title);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "parent",
          title: "Parent draft",
          note: "",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
  });

  it("deduplicates repeated Enter and keeps the first target stale after the later keydown", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaXYZomega" }),
    ]);
    const split = deferred<NotesWorkspace>();
    notesStoreMock.splitNode.mockReturnValue(split.promise);
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    renderNotesWorkspace();
    const title = await findTitleInput("alphaXYZomega");
    const idsBeforeSplit = randomUUID.mock.calls.length;
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    expect(randomUUID).toHaveBeenCalledTimes(idsBeforeSplit + 1);
    await waitFor(() =>
      expect(notesStoreMock.splitNode).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.splitNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "source",
        newNodeId: "00000000-0000-4000-8000-000000000001",
        prefix: "alpha",
        suffix: "omega",
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(title).toHaveFocus();

    await act(async () =>
      split.resolve(
        workspace([
          node({ id: "source", sortKey: 1, title: "alpha" }),
          node({
            id: "00000000-0000-4000-8000-000000000001",
            sortKey: 2,
            title: "omega",
          }),
        ]),
      ),
    );

    expect(await findTitleInput("omega")).not.toHaveFocus();
    expect(title).toHaveFocus();
    expect(notesStoreMock.updateNode).not.toHaveBeenCalled();
    expect(notesStoreMock.splitNode).toHaveBeenCalledOnce();
    randomUUID.mockRestore();
  });

  it("keeps a dirty title blur-saveable when split UUID generation fails", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaomega" }),
    ]);
    renderNotesWorkspace();
    const title = await findTitleInput("alphaomega");
    fireEvent.change(title, { target: { value: "alpha omega" } });
    title.focus();
    title.setSelectionRange(5, 5);
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("uuid failed");
      });

    expect(() => fireEvent.keyDown(title, { key: "Enter" })).not.toThrow();
    randomUUID.mockRestore();
    fireEvent.blur(title);

    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "source",
          title: "alpha omega",
          note: "",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
  });

  it("saves dirty title and note drafts before splitting and adopts the prefix", async () => {
    configureRepository([
      node({
        id: "source",
        sortKey: 1,
        title: "alphaXYZomega",
        note: "old note",
      }),
    ]);
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValue(save.promise);
    notesStoreMock.splitNode.mockResolvedValue(
      workspace([
        node({
          id: "source",
          sortKey: 1,
          title: "alpha",
          note: "draft note",
        }),
        node({
          id: "00000000-0000-4000-8000-000000000002",
          sortKey: 2,
          title: "omega!",
        }),
      ]),
    );
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000002");
    renderNotesWorkspace();
    const title = await findTitleInput("alphaXYZomega");
    const note = getTextareaByName("Supporting note: alphaXYZomega");
    fireEvent.change(title, { target: { value: "alphaXYZomega!" } });
    fireEvent.change(note, { target: { value: "draft note" } });
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "source",
        title: "alphaXYZomega!",
        note: "old note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();

    await act(async () =>
      save.resolve(
        workspace([
          node({
            id: "source",
            sortKey: 1,
            title: "alphaXYZomega!",
            note: "draft note",
          }),
        ]),
      ),
    );
    await waitFor(() =>
      expect(notesStoreMock.splitNode).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.splitNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "source",
        newNodeId: "00000000-0000-4000-8000-000000000002",
        prefix: "alpha",
        suffix: "omega!",
      },
      historyContextMatcher(),
    );

    expect(await findTitleInput("alpha")).toHaveValue("alpha");
    expect(getTitleInput("omega!")).toHaveFocus();
    randomUUID.mockRestore();
  });

  it("keeps a failed split prerequisite dirty and retries it before splitting", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaXYZomega" }),
    ]);
    const retrySave = deferred<NotesWorkspace>();
    notesStoreMock.updateNode
      .mockRejectedValueOnce(new Error("save failed"))
      .mockReturnValueOnce(retrySave.promise);
    notesStoreMock.splitNode.mockResolvedValue(
      workspace([
        node({ id: "source", title: "alpha", sortKey: 1 }),
        node({
          id: "00000000-0000-4000-8000-000000000003",
          title: "omega!",
          sortKey: 2,
        }),
      ]),
    );
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000003");
    renderNotesWorkspace();
    const title = await findTitleInput("alphaXYZomega");
    fireEvent.change(title, { target: { value: "alphaXYZomega!" } });
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(screen.getAllByText("save failed")).toHaveLength(2),
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();

    title.setSelectionRange(5, 8);
    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(2),
    );
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();

    await act(async () =>
      retrySave.resolve(
        workspace([
          node({ id: "source", title: "alphaXYZomega!", sortKey: 1 }),
        ]),
      ),
    );
    await waitFor(() =>
      expect(notesStoreMock.splitNode).toHaveBeenCalledOnce(),
    );
    randomUUID.mockRestore();
  });

  it("restores focus and surfaces a notice when a skipped split drops Enter", async () => {
    configureRepository([
      node({ id: "source", sortKey: 1, title: "alphaXYZomega" }),
    ]);
    // Every draft flush fails, so the split's draft-flush barrier drops the
    // structural command: the coordinator settles it as "skipped".
    notesStoreMock.updateNode.mockRejectedValue(new Error("save failed"));
    renderNotesWorkspace();
    const title = await findTitleInput("alphaXYZomega");
    fireEvent.change(title, { target: { value: "alphaXYZomega!" } });
    title.focus();
    title.setSelectionRange(5, 8);

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledOnce(),
    );
    // The split never reached the backend...
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    // ...and instead of Enter vanishing silently the row explains the pause...
    await screen.findByText(/Command paused/i);
    // ...and hands focus back to the title so the caret is not stranded.
    await waitFor(() => expect(title).toHaveFocus());
  });

  describe("authoritative end-of-line split", () => {
    const FIRST = "00000000-0000-4000-8000-0000000000a1";

    function endCaret(input: HTMLTextAreaElement): void {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    it("renders and focuses the empty sibling only after the split resolves", async () => {
      configureRepository([
        node({ id: "solo", sortKey: 1024, title: "Solo item" }),
      ]);
      const split = deferred<NotesWorkspace>();
      notesStoreMock.splitNode.mockReturnValue(split.promise);
      vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIRST);
      renderNotesWorkspace();
      const title = await findTitleInput("Solo item");
      endCaret(title);

      expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);

      await waitFor(() =>
        expect(notesStoreMock.splitNode).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.splitNode).toHaveBeenCalledWith(
        "/vault",
        { id: "solo", newNodeId: FIRST, prefix: "Solo item", suffix: "" },
        historyContextMatcher(),
      );
      const rowCountBeforeSettlement = document.querySelectorAll(
        'textarea[aria-label="Edit node title"]',
      ).length;
      const sourceFocusedBeforeSettlement = title.matches(":focus");

      await act(async () =>
        split.resolve(
          workspace([
            node({ id: "solo", sortKey: 1024, title: "Solo item" }),
            node({ id: FIRST, sortKey: 2048, title: "" }),
          ]),
        ),
      );
      expect(rowCountBeforeSettlement).toBe(1);
      expect(sourceFocusedBeforeSettlement).toBe(true);
      expect(await findTitleInput("")).toHaveFocus();
    });
  });

  describe("multi-node batch operations (Phase 4.1c)", () => {
    function threeRoots(): NoteNode[] {
      return [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
      ];
    }

    function fourRoots(): NoteNode[] {
      return [
        ...threeRoots(),
        node({ id: "d", sortKey: 4, title: "Delta #later" }),
      ];
    }

    function nestedSelectionTree(): NoteNode[] {
      return [
        node({ id: "parent", sortKey: 1, title: "Parent" }),
        node({ id: "child", parentId: "parent", sortKey: 1, title: "Child" }),
        node({
          id: "grandchild",
          parentId: "child",
          sortKey: 1,
          title: "Grandchild",
        }),
        node({ id: "sibling", sortKey: 2, title: "Sibling" }),
      ];
    }

    function useCtrlPlatform(): void {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    }

    it("includes visible descendants when Shift+Arrow selects a parent", async () => {
      configureRepository(nestedSelectionTree());
      renderNotesWorkspace();
      const parent = await findTitleInput("Parent");

      fireEvent.keyDown(parent, { key: "ArrowDown", shiftKey: true });

      expect(selectedOutlineIds()).toEqual(["parent", "child", "grandchild"]);
      expect(
        screen.getByRole("toolbar", {
          name: "Actions for 3 selected notes",
        }),
      ).toBeVisible();
    });

    it("includes visible descendants when a pointer selection reaches a parent child", async () => {
      configureRepository(nestedSelectionTree());
      renderNotesWorkspace();
      const parent = await findTitleInput("Parent");
      const child = getTitleInput("Child");

      fireEvent.pointerDown(parent, { button: 0, pointerId: 31 });
      fireEvent.pointerMove(child, { buttons: 1, pointerId: 31 });
      fireEvent.pointerUp(child, { button: 0, pointerId: 31 });

      expect(selectedOutlineIds()).toEqual(["parent", "child", "grandchild"]);
    });

    it.each([
      { platform: "MacIntel", modifier: "Meta" },
      { platform: "Win32", modifier: "Ctrl" },
    ])(
      "uses Shift click for a range and $modifier click to toggle a row on $platform",
      async ({ platform, modifier }) => {
        const user = userEvent.setup();
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
        configureRepository(threeRoots());
        renderNotesWorkspace();
        const alphaInput = await waitFor(() => {
          const input = queryTitleInput("Alpha");
          if (!input) throw new Error("Alpha title did not render");
          return input;
        });
        const alpha = getTitlePresentation("Alpha");
        const bravo = getTitlePresentation("Bravo");
        const charlie = getTitlePresentation("Charlie");

        expect(alphaInput.style.pointerEvents).toBe("none");
        expect(alpha.style.pointerEvents).toBe("auto");
        await user.pointer({ keys: "[MouseLeft]", target: alpha });
        await waitFor(() => expect(alphaInput).toHaveFocus());
        await user.keyboard("{Shift>}");
        await user.pointer({ keys: "[MouseLeft]", target: charlie });
        await user.keyboard("{/Shift}");
        expect(selectedOutlineIds()).toEqual(["a", "b", "c"]);

        await user.keyboard(modifier === "Meta" ? "{Meta>}" : "{Control>}");
        await user.pointer({ keys: "[MouseLeft]", target: bravo });
        await user.keyboard(modifier === "Meta" ? "{/Meta}" : "{/Control}");
        expect(selectedOutlineIds()).toEqual(["a", "c"]);
      },
    );

    it.each([
      ["Control", { ctrlKey: true }],
      ["Command", { metaKey: true }],
    ] as const)(
      "moves a mouse-selected range with %s while focus remains on a bullet",
      async (_modifier, modifierKey) => {
        const user = userEvent.setup();
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue(
          "MacIntel",
        );
        configureRepository(fourRoots());
        renderNotesWorkspace();
        const bravo = await findTitleInput("Bravo");
        const deltaBullet = screen.getByRole("button", {
          name: "Zoom into Delta #later",
        });

        bravo.focus();
        await user.keyboard("{Shift>}");
        await user.pointer({ keys: "[MouseLeft]", target: deltaBullet });
        await user.keyboard("{/Shift}");

        expect(selectedOutlineIds()).toEqual(["b", "c", "d"]);
        expect(deltaBullet).toHaveFocus();

        fireEvent.keyDown(deltaBullet, {
          key: "ArrowUp",
          ...modifierKey,
          shiftKey: true,
        });

        await waitFor(() =>
          expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
        );
        expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
          "/vault",
          expect.objectContaining({ op: "move", nodeIds: ["b", "c", "d"] }),
          historyContextMatcher(),
        );
      },
    );

    it("clears a multi-selection on a plain row text click while preserving edit focus", async () => {
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      expect(selectedOutlineIds()).toEqual(["a", "b"]);

      const charlie = queryTitleInput("Charlie");
      if (!charlie) {
        throw new Error("Charlie title did not render");
      }
      const charlieRow = charlie.closest<HTMLElement>(".notes-node");
      if (!charlieRow) {
        throw new Error("Charlie row did not render");
      }
      const charliePresentation = within(charlieRow).getByRole("group", {
        name: "Edit node title",
      });
      fireEvent.pointerDown(charliePresentation, { button: 0, pointerId: 4 });
      fireEvent.pointerUp(charliePresentation, { button: 0, pointerId: 4 });

      expect(selectedOutlineIds()).toEqual([]);
      await waitFor(() => expect(charlie).toHaveFocus());
    });

    it("keeps a same-row text drag native and promotes a downward cross-row drag", async () => {
      configureRepository(fourRoots());
      renderNotesWorkspace();
      await findTitleInput("Alpha");
      const titles = screen.getAllByLabelText<HTMLTextAreaElement>(
        "Edit node title",
        { selector: "textarea" },
      );
      const bravo = titles[1];
      const delta = titles[3];

      fireEvent.focus(bravo);
      bravo.setSelectionRange(0, 3);
      fireEvent.pointerDown(bravo, { button: 0, pointerId: 7 });
      fireEvent.pointerMove(bravo, { buttons: 1, pointerId: 7 });
      expect(selectedOutlineIds()).toEqual([]);
      expect([bravo.selectionStart, bravo.selectionEnd]).toEqual([0, 3]);

      fireEvent.pointerMove(delta, { buttons: 1, pointerId: 7 });
      expect(selectedOutlineIds()).toEqual(["b", "c", "d"]);
      expect(screen.getByLabelText("3 notes selected")).toBeVisible();
      fireEvent.pointerUp(delta, { button: 0, pointerId: 7 });
    });

    it("returns focus to the selection head after a mouse drag so keyboard moves and native copy fire", async () => {
      useCtrlPlatform();
      configureRepository(fourRoots());
      renderNotesWorkspace();
      await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      const titles = screen.getAllByLabelText<HTMLTextAreaElement>(
        "Edit node title",
        { selector: "textarea" },
      );
      const bravo = titles[1];
      const delta = titles[3];

      fireEvent.pointerDown(bravo, { button: 0, pointerId: 12 });
      fireEvent.pointerMove(bravo, { buttons: 1, pointerId: 12 });
      fireEvent.pointerMove(delta, { buttons: 1, pointerId: 12 });
      expect(selectedOutlineIds()).toEqual(["b", "c", "d"]);
      fireEvent.pointerUp(delta, { button: 0, pointerId: 12 });

      // Drag promotion blurred the editor; ending the gesture must hand focus
      // back to the selection head so the state matches a keyboard-built
      // selection (otherwise no row receives the shortcuts below).
      await waitFor(() => expect(delta).toHaveFocus());
      expect(selectedOutlineIds()).toEqual(["b", "c", "d"]);

      // Native copy now originates inside the pane subtree again.
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      delta.setSelectionRange(0, 0);
      const copied = dispatchClipboardEvent("copy", delta);
      expect(copied.event.defaultPrevented).toBe(true);
      expect(copied.setData).toHaveBeenCalledWith(
        "text/plain",
        "- Bravo\n- Charlie\n- Delta #later",
      );

      // Keyboard block move reaches the focused row's keydown handler.
      fireEvent.keyDown(delta, {
        key: "ArrowUp",
        altKey: true,
        shiftKey: true,
      });
      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        expect.objectContaining({ op: "move", nodeIds: ["b", "c", "d"] }),
        historyContextMatcher(),
      );
    });

    it("promotes a user pointer drag across browser-reachable title presentations", async () => {
      const user = userEvent.setup();
      configureRepository(fourRoots());
      renderNotesWorkspace();
      await findTitleInput("Alpha");
      const bravo = getTitlePresentation("Bravo");
      const delta = getTitlePresentation("Delta #later");

      await user.pointer({
        keys: "[MouseLeft>]",
        target: bravo,
        coords: { clientX: 80, clientY: 42 },
      });
      await user.pointer({
        target: delta,
        coords: { clientX: 80, clientY: 98 },
      });
      await user.pointer({
        keys: "[/MouseLeft]",
        target: delta,
        coords: { clientX: 80, clientY: 98 },
      });

      expect(selectedOutlineIds()).toEqual(["b", "c", "d"]);
    });

    it("promotes a cross-row drag over row padding", async () => {
      configureRepository(fourRoots());
      renderNotesWorkspace();
      const bravo = await findTitleInput("Bravo");
      const delta = getTitleInput("Delta #later");
      const deltaRow = delta.closest<HTMLElement>(".notes-node");
      if (!deltaRow) {
        throw new Error("Delta row did not render");
      }

      fireEvent.pointerDown(bravo, { button: 0, pointerId: 10 });
      fireEvent.pointerMove(deltaRow, { buttons: 1, pointerId: 10 });

      expect(selectedOutlineIds()).toEqual(["b", "c", "d"]);
      fireEvent.pointerUp(deltaRow, { button: 0, pointerId: 10 });
    });

    it("hands a captured image atom drag to cross-row selection without restoring its native range", async () => {
      const imageNode = node({
        id: "image-a",
        nodeKind: "image",
        sortKey: 1,
        title: "beforeafter",
        imageOffsetUtf16: 6,
      });
      const targetNode = node({
        id: "target-b",
        sortKey: 2,
        title: "Target",
      });
      configureRepository([imageNode, targetNode], {
        [imageNode.id]: [
          attachment({ id: "image-attachment", nodeId: imageNode.id }),
        ],
      });
      renderNotesWorkspace();
      const editor = await screen.findByRole("textbox", { name: "Image note" });
      const atom = editor.querySelector<HTMLElement>(
        "[data-image-atom-region=atom]",
      )!;
      const targetRow = (await findTitleInput("Target")).closest<HTMLElement>(
        ".notes-node",
      )!;
      const setPointerCapture = vi.fn();
      const releasePointerCapture = vi.fn();
      Object.assign(atom, { setPointerCapture, releasePointerCapture });
      const originalElementFromPoint = Object.getOwnPropertyDescriptor(
        document,
        "elementFromPoint",
      );
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => targetRow),
      });

      try {
        fireEvent.pointerDown(atom, {
          button: 0,
          pointerId: 18,
          clientX: 20,
          clientY: 20,
        });
        const selection = document.getSelection()!;
        const removeAllRanges = vi.spyOn(selection, "removeAllRanges");
        fireEvent.pointerMove(atom, {
          buttons: 1,
          pointerId: 18,
          clientX: 20,
          clientY: 80,
        });

        expect(selectedOutlineIds()).toEqual(["image-a", "target-b"]);
        expect(removeAllRanges).toHaveBeenCalledOnce();
        expect(selection.rangeCount).toBe(0);
        expect(releasePointerCapture).toHaveBeenCalledWith(18);
        fireEvent.pointerUp(atom, { button: 0, pointerId: 18 });
        fireEvent.click(atom);
        expect(removeAllRanges).toHaveBeenCalledOnce();
        expect(selection.rangeCount).toBe(0);
        expect(screen.queryByTestId("notes-selection-drag-preview")).toBeNull();
        expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
      } finally {
        if (originalElementFromPoint) {
          Object.defineProperty(
            document,
            "elementFromPoint",
            originalElementFromPoint,
          );
        } else {
          Reflect.deleteProperty(document, "elementFromPoint");
        }
      }
    });

    it("retires a cross-row drag after an off-list pointer release", async () => {
      configureRepository(fourRoots());
      renderNotesWorkspace();
      const bravo = await findTitleInput("Bravo");
      const delta = queryTitleInput("Delta #later");
      const deltaRow = delta?.closest<HTMLElement>(".notes-node");
      if (!deltaRow) {
        throw new Error("Delta row did not render");
      }

      fireEvent.pointerDown(bravo, { button: 0, pointerId: 11 });
      fireEvent.pointerUp(document.body, { button: 0, pointerId: 11 });
      fireEvent.pointerMove(deltaRow, { buttons: 1, pointerId: 11 });

      expect(selectedOutlineIds()).toEqual([]);
    });

    it("promotes an upward cross-row drag and ignores interactive token drags", async () => {
      configureRepository(fourRoots());
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      const charlie = getTitleInput("Charlie");

      fireEvent.pointerDown(charlie, { button: 0, pointerId: 8 });
      fireEvent.pointerMove(alpha, { buttons: 1, pointerId: 8 });
      fireEvent.pointerUp(alpha, { button: 0, pointerId: 8 });
      expect(selectedOutlineIds()).toEqual(["a", "b", "c"]);

      const tag = screen.getByRole("button", {
        name: "#later tag filter is inactive",
      });
      fireEvent.pointerDown(tag, { button: 0, pointerId: 9 });
      fireEvent.pointerMove(alpha, { buttons: 1, pointerId: 9 });
      fireEvent.pointerUp(alpha, { button: 0, pointerId: 9 });
      expect(selectedOutlineIds()).toEqual(["a", "b", "c"]);
    });

    it("treats a one-row range as selection mode and swaps in the contextual toolbar", async () => {
      configureRepository(threeRoots());
      renderNotesWorkspace();
      await findTitleInput("Alpha");

      fireEvent.click(screen.getByRole("button", { name: "Zoom into Alpha" }), {
        shiftKey: true,
      });

      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 1 selected notes",
      });
      expect(within(toolbar).getByLabelText("1 notes selected")).toBeVisible();
      expect(document.querySelector('[data-outline-id="a"]')).toHaveAttribute(
        "data-range-selected",
        "true",
      );
      expect(
        screen.queryByRole("navigation", { name: "Notes breadcrumb" }),
      ).toBeNull();
    });

    it("moves focus between an outline editor and the selection toolbar with F6", async () => {
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });

      expect(fireEvent.keyDown(alpha, { key: "F6" })).toBe(false);
      const clear = within(toolbar).getByRole("button", {
        name: "Clear selection",
      });
      expect(clear).toHaveFocus();

      expect(fireEvent.keyDown(clear, { key: "F6", shiftKey: true })).toBe(
        false,
      );
      const bravo = getTitleInput("Bravo");
      expect(bravo).toHaveFocus();

      expect(fireEvent.keyDown(bravo, { key: "F6" })).toBe(false);
      expect(clear).toHaveFocus();
      expect(fireEvent.keyDown(clear, { key: "Escape" })).toBe(false);
      await waitFor(() =>
        expect(
          screen.queryByRole("toolbar", {
            name: "Actions for 2 selected notes",
          }),
        ).toBeNull(),
      );
      expect(bravo).toHaveFocus();
    });

    it("starts a zoomed Shift+Click range at the body row instead of the page header", async () => {
      const user = userEvent.setup();
      configureRepository(initialNodes());
      renderNotesWorkspace();
      await findTitleInput("Project");
      await user.click(
        screen.getByRole("button", { name: "Zoom into Project" }),
      );
      await activatePageTitle();

      fireEvent.click(screen.getByRole("button", { name: "Zoom into Plan" }), {
        shiftKey: true,
      });

      expect(
        await screen.findByRole("toolbar", {
          name: "Actions for 2 selected notes",
        }),
      ).toBeVisible();
      expect(
        document.querySelector('[data-outline-id="plan"]'),
      ).toHaveAttribute("data-range-selected", "true");
      expect(
        document.querySelector('[data-outline-id="milestone"]'),
      ).toHaveAttribute("data-range-selected", "true");
    });

    it("routes contextual Complete through one authoritative selection batch", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      await findTitleInput("Alpha");
      fireEvent.click(screen.getByRole("button", { name: "Zoom into Alpha" }), {
        shiftKey: true,
      });

      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 1 selected notes",
      });
      await user.click(
        within(toolbar).getByRole("button", { name: "Complete" }),
      );

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "complete",
          nodeIds: ["a"],
          completed: true,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    });

    it("duplicates a toolbar-selected range once and selects the returned copied roots", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      notesStoreMock.applyBatch.mockImplementationOnce(
        async (
          _vaultRoot: string,
          input: ApplyNotesBatchInput,
          context: NotesHistoryContext,
        ) => {
          if (input.op !== "duplicate") {
            throw new Error("Expected a duplicate batch");
          }
          confirmedNodes = [
            ...confirmedNodes,
            node({ id: "copy-a", sortKey: 4, title: "Alpha copy" }),
            node({ id: "copy-b", sortKey: 5, title: "Bravo copy" }),
          ];
          return {
            workspace: workspace(confirmedNodes),
            historyEntryId: context.entryId,
            ...historyState({
              canUndo: true,
              nextUndoEntryId: context.entryId,
            }),
            duplicatedRootIds: ["copy-a", "copy-b"],
          };
        },
      );
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      const toolbar = screen.getByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });

      await user.click(
        within(toolbar).getByRole("button", { name: "Duplicate" }),
      );

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "duplicate",
          nodeIds: ["a", "b"],
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.duplicateNode).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(selectedOutlineIds()).toEqual(["copy-a", "copy-b"]),
      );
      expect(
        screen.getByRole("toolbar", {
          name: "Actions for 2 selected notes",
        }),
      ).toBeVisible();
    });

    it("routes Cmd+Shift+D through one selected duplicate batch and selects the copies", async () => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
      configureRepository(threeRoots());
      notesStoreMock.applyBatch.mockImplementationOnce(
        async (
          _vaultRoot: string,
          input: ApplyNotesBatchInput,
          context: NotesHistoryContext,
        ) => {
          if (input.op !== "duplicate") {
            throw new Error("Expected a duplicate batch");
          }
          confirmedNodes = [
            ...confirmedNodes,
            node({ id: "copy-a", sortKey: 4, title: "Alpha copy" }),
            node({ id: "copy-b", sortKey: 5, title: "Bravo copy" }),
          ];
          return {
            workspace: workspace(confirmedNodes),
            historyEntryId: context.entryId,
            ...historyState({
              canUndo: true,
              nextUndoEntryId: context.entryId,
            }),
            duplicatedRootIds: ["copy-a", "copy-b"],
          };
        },
      );
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      alpha.focus();
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });

      expect(
        fireEvent.keyDown(alpha, {
          key: "D",
          metaKey: true,
          shiftKey: true,
        }),
      ).toBe(false);

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "duplicate",
          nodeIds: ["a", "b"],
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.duplicateNode).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(selectedOutlineIds()).toEqual(["copy-a", "copy-b"]),
      );
    });

    it("hydrates full Active authority without hiding the materializable toolbar", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "a", sortKey: 1, title: "Alpha", isStarred: true }),
        node({ id: "b", sortKey: 2, title: "Hidden sibling" }),
      ];
      configureRepository(activeNodes);
      const hydration = deferred<NotesWorkspace>();
      let deferActiveAuthority = false;
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (scope.kind === "starred") {
            return workspace(
              activeNodes.filter((current) => current.isStarred),
            );
          }
          if (deferActiveAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Alpha");
      await user.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() => expect(queryTitleInput("Hidden sibling")).toBeNull());

      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferActiveAuthority = true;
      fireEvent.click(screen.getByRole("button", { name: "Zoom into Alpha" }), {
        shiftKey: true,
      });

      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 1 selected notes",
      });
      const moveDown = within(toolbar).getByRole("button", {
        name: "Move down",
      });
      expect(moveDown).toHaveAttribute("aria-disabled", "true");
      expect(moveDown).toHaveAttribute(
        "title",
        "This action requires the complete active workspace.",
      );
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );

      await act(async () => {
        hydration.resolve(workspace(activeNodes));
        deferActiveAuthority = false;
      });
      await waitFor(() =>
        expect(moveDown).toHaveAttribute("aria-disabled", "false"),
      );
    });

    it("claims native Copy with feedback until a filtered selection has full authority", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "a", sortKey: 1, title: "Alpha", isStarred: true }),
        node({ id: "b", sortKey: 2, title: "Hidden sibling" }),
      ];
      configureRepository(activeNodes);
      const hydration = deferred<NotesWorkspace>();
      let deferActiveAuthority = false;
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (scope.kind === "starred") {
            return workspace(
              activeNodes.filter((current) => current.isStarred),
            );
          }
          if (deferActiveAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Alpha");
      await user.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() => expect(queryTitleInput("Hidden sibling")).toBeNull());

      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferActiveAuthority = true;
      fireEvent.click(screen.getByRole("button", { name: "Zoom into Alpha" }), {
        shiftKey: true,
      });
      const title = getTitleInput("Alpha");
      title.setSelectionRange(0, 0);
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBe(activeLoadsBeforeSelection + 1),
      );

      const provisional = dispatchClipboardEvent("copy", title);
      expect(provisional.event.defaultPrevented).toBe(true);
      expect(provisional.setData).not.toHaveBeenCalled();
      expect(
        await screen.findByText(/still preparing for Copy\. Try again/i),
      ).toBeVisible();

      await act(async () => {
        hydration.resolve(workspace(activeNodes));
        deferActiveAuthority = false;
      });
      await act(async () => undefined);
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(activeLoadsBeforeSelection + 1);

      const authoritative = dispatchClipboardEvent("copy", title);
      expect(authoritative.event.defaultPrevented).toBe(true);
      expect(authoritative.values.get("text/plain")).toBe("- Alpha");
      await waitFor(() =>
        expect(
          screen.queryByText(/still preparing for Copy\. Try again/i),
        ).toBeNull(),
      );
    });

    it("consumes repeated selection shortcuts without mutating or clearing the range", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });

      const repeatedShortcuts = [
        { key: "Enter", ctrlKey: true },
        { key: "Backspace", ctrlKey: true, shiftKey: true },
        { key: "Tab" },
        { key: "Tab", shiftKey: true },
        { key: "D", altKey: true, shiftKey: true },
        { key: "ArrowUp", altKey: true, shiftKey: true },
        { key: "ArrowDown", altKey: true, shiftKey: true },
      ] as const;

      for (const shortcut of repeatedShortcuts) {
        expect(fireEvent.keyDown(title, { ...shortcut, repeat: true })).toBe(
          false,
        );
      }
      expect(
        fireEvent.keyDown(title, { key: "c", ctrlKey: true, repeat: true }),
      ).toBe(true);
      expect(
        fireEvent.keyDown(title, { key: "x", ctrlKey: true, repeat: true }),
      ).toBe(true);
      expect(
        fireEvent.keyDown(title, {
          key: "Enter",
          ctrlKey: true,
          isComposing: true,
        }),
      ).toBe(true);

      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
      expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
      expect(notesStoreMock.duplicateNode).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
      expect(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-outline-id][data-range-selected="true"]',
          ),
        ).map((row) => row.dataset.outlineId),
      ).toEqual(["a", "b"]);
    });

    it("replays only the latest bullet navigation after outline composition ends", async () => {
      const user = userEvent.setup();
      configureRepository();
      renderNotesWorkspace();
      const title = await findTitleInput("Project");
      notesStoreMock.historyStatus.mockClear();
      notesStoreMock.prepareNavigation.mockClear();

      fireEvent.compositionStart(title);
      await user.click(
        screen.getByRole("button", { name: "Zoom into Project" }),
      );
      await user.click(screen.getByRole("button", { name: "Zoom into Plan" }));

      expect(notesStoreMock.historyStatus).not.toHaveBeenCalled();
      expect(notesStoreMock.prepareNavigation).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("heading", { name: "Plan", level: 1 }),
      ).not.toBeInTheDocument();

      fireEvent.compositionEnd(title);
      expect(
        await screen.findByRole("heading", { name: "Plan", level: 1 }),
      ).toBeVisible();
      expect(notesStoreMock.historyStatus).toHaveBeenCalledOnce();
      expect(notesStoreMock.prepareNavigation).toHaveBeenCalledOnce();
    });

    it("undoes and redoes bullet navigation from a non-editable Notes surface", async () => {
      const user = userEvent.setup();
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
      configureRepository();
      renderNotesWorkspace();
      await findTitleInput("Project");

      await user.click(
        screen.getByRole("button", { name: "Zoom into Project" }),
      );
      await user.click(screen.getByRole("button", { name: "Zoom into Plan" }));
      await screen.findByRole("heading", { name: "Plan", level: 1 });

      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      expect(
        await screen.findByRole("heading", { name: "Project", level: 1 }),
      ).toBeVisible();

      fireEvent.keyDown(document.body, {
        key: "z",
        metaKey: true,
        shiftKey: true,
      });
      expect(
        await screen.findByRole("heading", { name: "Plan", level: 1 }),
      ).toBeVisible();
    });

    it("owns prepared native Copy while preserving browser text and composition events and consuming outline repeats", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(activeLoadsBeforeSelection + 1);

      title.focus();
      title.setSelectionRange(0, 0);
      const committed = dispatchClipboardEvent("copy", title);
      expect(committed.event.defaultPrevented).toBe(true);
      expect(committed.setData.mock.calls).toEqual([
        ["text/plain", "- Alpha\n- Bravo"],
        ["text/markdown", "- Alpha\n- Bravo"],
      ]);

      title.setSelectionRange(0, 2);
      const nativeText = dispatchClipboardEvent("copy", title);
      expect(nativeText.event.defaultPrevented).toBe(false);
      expect(nativeText.setData).not.toHaveBeenCalled();

      title.setSelectionRange(0, 0);
      fireEvent.keyDown(title, { key: "c", ctrlKey: true, repeat: true });
      const repeated = dispatchClipboardEvent("copy", title);
      expect(repeated.event.defaultPrevented).toBe(true);
      expect(repeated.setData).not.toHaveBeenCalled();
      fireEvent.keyUp(title, { key: "c" });

      fireEvent.compositionStart(title);
      const composing = dispatchClipboardEvent("copy", title);
      expect(composing.event.defaultPrevented).toBe(false);
      expect(composing.setData).not.toHaveBeenCalled();
      fireEvent.compositionEnd(title);

      const content = document.querySelector(".notes-outline-content");
      if (!(content instanceof HTMLElement)) {
        throw new Error("Outline content did not render");
      }
      const getSelection = vi
        .spyOn(window, "getSelection")
        .mockReturnValue({ isCollapsed: false } as Selection);
      const selectedPageText = dispatchClipboardEvent("copy", content);
      expect(selectedPageText.event.defaultPrevented).toBe(false);
      expect(selectedPageText.setData).not.toHaveBeenCalled();
      getSelection.mockRestore();

      const paneCopy = dispatchClipboardEvent("copy", content);
      expect(paneCopy.event.defaultPrevented).toBe(true);
      expect(paneCopy.values.get("text/plain")).toBe("- Alpha\n- Bravo");
    });

    it("leaves composing native Cut unowned while a selection mutation is loading", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      const completion = deferred<NotesWorkspace>();
      notesStoreMock.applyBatch.mockReturnValueOnce(completion.promise);
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });

      await user.click(
        within(toolbar).getByRole("button", { name: "Complete" }),
      );
      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );

      title.focus();
      title.setSelectionRange(0, 0);
      fireEvent.compositionStart(title);
      const composingCut = dispatchClipboardEvent("cut", title);

      expect(composingCut.event.defaultPrevented).toBe(false);
      expect(composingCut.setData).not.toHaveBeenCalled();
      fireEvent.compositionEnd(title);

      await act(async () => {
        completion.resolve(workspace(confirmedNodes));
        await completion.promise;
      });
    });

    it("falls back to plain text for toolbar More Copy and preserves the selected range", async () => {
      const user = userEvent.setup();
      const write = vi.fn(async () => {
        throw new Error("rich clipboard denied");
      });
      const writeText = vi.fn(async () => undefined);
      const restoreClipboard = installNavigatorClipboard({ write, writeText });
      vi.stubGlobal(
        "ClipboardItem",
        class {
          constructor(_items: Record<string, Blob>) {}
        },
      );
      try {
        configureRepository(threeRoots());
        renderNotesWorkspace();
        const alpha = await findTitleInput("Alpha");
        fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
        const toolbar = screen.getByRole("toolbar", {
          name: "Actions for 2 selected notes",
        });

        await user.click(
          within(toolbar).getByRole("button", { name: "More actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Copy" }));

        await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        expect(write).toHaveBeenCalledOnce();
        expect(writeText).toHaveBeenCalledWith("- Alpha\n- Bravo");
        expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
        expect(selectedOutlineIds()).toEqual(["a", "b"]);
        expect(
          await within(screen.getByLabelText("Status bar feedback")).findByRole(
            "status",
          ),
        ).toHaveTextContent("Copied.");
      } finally {
        restoreClipboard();
      }
    });

    it("falls back to plain text before toolbar More Cut deletes the selection", async () => {
      const user = userEvent.setup();
      const write = vi.fn(async () => {
        throw new Error("rich clipboard denied");
      });
      const plainWrite = deferred<void>();
      const writeText = vi.fn(() => plainWrite.promise);
      const restoreClipboard = installNavigatorClipboard({ write, writeText });
      vi.stubGlobal(
        "ClipboardItem",
        class {
          constructor(_items: Record<string, Blob>) {}
        },
      );
      try {
        configureRepository(threeRoots());
        renderNotesWorkspace();
        const alpha = await findTitleInput("Alpha");
        fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
        const toolbar = screen.getByRole("toolbar", {
          name: "Actions for 2 selected notes",
        });

        await user.click(
          within(toolbar).getByRole("button", { name: "More actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Cut" }));

        await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        expect(write).toHaveBeenCalledOnce();
        expect(writeText).toHaveBeenCalledWith("- Alpha\n- Bravo");
        expect(write.mock.invocationCallOrder[0]).toBeLessThan(
          writeText.mock.invocationCallOrder[0],
        );
        expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
        await act(async () => plainWrite.resolve());
        await waitFor(() =>
          expect(notesStoreMock.deleteNodes).toHaveBeenCalledOnce(),
        );
        expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
          "/vault",
          {
            nodeIds: ["a", "b"],
          },
          historyContextMatcher(),
        );
        expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(
          notesStoreMock.deleteNodes.mock.invocationCallOrder[0],
        );
        await waitFor(() => expect(getTitleInput("Charlie")).toHaveFocus());
      } finally {
        restoreClipboard();
      }
    });

    it("preserves the selected range when toolbar More Cut cannot write the clipboard", async () => {
      const user = userEvent.setup();
      const write = vi.fn(async () => {
        throw new Error("rich clipboard denied");
      });
      const writeText = vi.fn(async () => {
        throw new Error("plain clipboard denied");
      });
      const restoreClipboard = installNavigatorClipboard({ write, writeText });
      vi.stubGlobal(
        "ClipboardItem",
        class {
          constructor(_items: Record<string, Blob>) {}
        },
      );
      try {
        configureRepository(threeRoots());
        renderNotesWorkspace();
        const alpha = await findTitleInput("Alpha");
        fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
        const toolbar = screen.getByRole("toolbar", {
          name: "Actions for 2 selected notes",
        });

        await user.click(
          within(toolbar).getByRole("button", { name: "More actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Cut" }));

        expect(
          await within(screen.getByLabelText("Status bar feedback")).findByRole(
            "alert",
          ),
        ).toHaveTextContent("The clipboard could not be written.");
        expect(write).toHaveBeenCalledOnce();
        expect(writeText).toHaveBeenCalledOnce();
        expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
        expect(selectedOutlineIds()).toEqual(["a", "b"]);
      } finally {
        restoreClipboard();
      }
    });

    it("reuses hydrated clipboard authority across pane state and draft lifecycle refreshes", async () => {
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      const preparedLoadCount = activeLoadsBeforeSelection + 1;
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(preparedLoadCount);

      const bravo = getTitleInput("Bravo");
      bravo.setSelectionRange(0, 0);
      await act(async () => undefined);
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(preparedLoadCount);
      expect(dispatchClipboardEvent("copy", bravo).event.defaultPrevented).toBe(
        true,
      );

      fireEvent.change(bravo, { target: { value: "Bravo!" } });
      await act(async () => undefined);
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(preparedLoadCount);
      const afterDraftChange = dispatchClipboardEvent("copy", bravo);
      expect(afterDraftChange.event.defaultPrevented).toBe(false);
      expect(afterDraftChange.setData).not.toHaveBeenCalled();
    });

    it("commits a prepared native Cut synchronously and mutates the range once", async () => {
      useCtrlPlatform();
      const order: string[] = [];
      configureRepository(threeRoots());
      notesStoreMock.deleteNodes.mockImplementation(
        async (_vaultRoot: string, input: { nodeIds: readonly NoteId[] }) => {
          order.push("delete");
          const ids = new Set(input.nodeIds);
          confirmedNodes = confirmedNodes.filter(
            (current) => !ids.has(current.id),
          );
          return workspace(confirmedNodes);
        },
      );
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(activeLoadsBeforeSelection + 1);

      title.focus();
      title.setSelectionRange(0, 0);
      const committed = dispatchClipboardEvent("cut", title, order);
      expect(committed.event.defaultPrevented).toBe(true);
      expect(committed.setData.mock.calls).toEqual([
        ["text/plain", "- Alpha\n- Bravo"],
        ["text/markdown", "- Alpha\n- Bravo"],
      ]);
      expect(order.slice(0, 2)).toEqual(["text/plain", "text/markdown"]);

      fireEvent.keyDown(title, { key: "x", ctrlKey: true, repeat: true });
      const repeated = dispatchClipboardEvent("cut", title, order);
      expect(repeated.event.defaultPrevented).toBe(true);
      expect(repeated.setData).not.toHaveBeenCalled();
      fireEvent.keyUp(title, { key: "x" });

      await waitFor(() =>
        expect(notesStoreMock.deleteNodes).toHaveBeenCalledOnce(),
      );
      expect(order).toEqual(["text/plain", "text/markdown", "delete"]);
      expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
        "/vault",
        {
          nodeIds: ["a", "b"],
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
    });

    it("routes a one-row selected drag through the frozen batch command", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      await findTitleInput("Bravo");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.click(screen.getByRole("button", { name: "Zoom into Bravo" }), {
        shiftKey: true,
      });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(activeLoadsBeforeSelection + 1);
      const bullet = screen.getByRole("button", { name: "Zoom into Bravo" });
      mockOutlineRowRects();

      bullet.focus();
      await user.keyboard("[Space][ArrowDown][Space]");

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["b"],
          parentId: null,
          afterId: "c",
          beforeId: null,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("shows a selected drop line before frozen authority resolves", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
        node({ id: "d", sortKey: 4, title: "Delta" }),
      ];
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const charlie = screen.getByRole("button", { name: "Zoom into Charlie" });
      mockOutlineRowRects();
      const charlieRect = charlie
        .closest<HTMLElement>("[data-outline-id]")!
        .getBoundingClientRect();
      const charlieY = charlieRect.top + charlieRect.height * 0.75;

      await user.pointer({
        keys: "[MouseLeft>]",
        target: alpha,
        coords: { clientX: 9, clientY: 14 },
      });
      await user.pointer({
        target: charlie,
        coords: { clientX: 9, clientY: charlieY - 1 },
      });
      await user.pointer({
        target: charlie,
        coords: { clientX: 9, clientY: charlieY },
      });

      const dropLine = document.querySelector(".notes-outline-drop-preview");
      expect(dropLine).not.toBeNull();
      expect(dropLine).toHaveAttribute("data-before-id", "d");
      expect(dropLine).not.toHaveAttribute("data-parent-id");
      expect(dropLine).toHaveAttribute("data-depth", "0");
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();

      await user.pointer({
        keys: "[/MouseLeft]",
        target: charlie,
        coords: { clientX: 9, clientY: charlieY },
      });
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();

      await act(async () => {
        deferAuthority = false;
        hydration.resolve(workspace(activeNodes));
        await hydration.promise;
      });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["a", "b"],
          parentId: null,
          afterId: "c",
          beforeId: null,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("shows the original pointer boundary over a selected block without moving", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
        node({ id: "d", sortKey: 4, title: "Delta" }),
      ];
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const bravo = screen.getByRole("button", { name: "Zoom into Bravo" });
      mockOutlineRowRects();

      await user.pointer({
        keys: "[MouseLeft>]",
        target: alpha,
        coords: { clientX: 9, clientY: 14 },
      });
      await user.pointer({
        target: bravo,
        coords: { clientX: 9, clientY: 42 },
      });

      const dropLine = document.querySelector(".notes-outline-drop-preview");
      expect(dropLine).not.toBeNull();
      expect(dropLine).toHaveAttribute("data-before-id", "c");
      expect(dropLine).not.toHaveAttribute("data-parent-id");
      expect(dropLine).toHaveAttribute("data-depth", "0");

      await user.pointer({
        keys: "[/MouseLeft]",
        target: bravo,
        coords: { clientX: 9, clientY: 42 },
      });

      await act(async () => {
        deferAuthority = false;
        hydration.resolve(workspace(activeNodes));
        await hydration.promise;
      });

      await act(async () => undefined);
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("keeps a selected child block under its parent at the pointer boundary", async () => {
      const user = userEvent.setup();
      configureRepository([
        node({ id: "parent", sortKey: 1, title: "Parent" }),
        node({ id: "a", parentId: "parent", sortKey: 1, title: "Alpha" }),
        node({ id: "b", parentId: "parent", sortKey: 2, title: "Bravo" }),
        node({ id: "c", parentId: "parent", sortKey: 3, title: "Charlie" }),
        node({ id: "tail", sortKey: 2, title: "Tail" }),
      ]);
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const charlie = screen.getByRole("button", { name: "Zoom into Charlie" });
      mockOutlineRowRects();
      const alphaRect = alpha
        .closest<HTMLElement>("[data-outline-id]")!
        .getBoundingClientRect();
      const charlieRect = charlie
        .closest<HTMLElement>("[data-outline-id]")!
        .getBoundingClientRect();
      const alphaY = alphaRect.top + alphaRect.height / 2;
      const charlieY = charlieRect.top + charlieRect.height * 0.75;

      await user.pointer({
        keys: "[MouseLeft>]",
        target: alpha,
        coords: { clientX: 9, clientY: alphaY },
      });
      await user.pointer({
        target: charlie,
        coords: { clientX: 9, clientY: charlieY - 1 },
      });
      await user.pointer({
        target: charlie,
        coords: { clientX: 9, clientY: charlieY },
      });

      const dropLine = document.querySelector(".notes-outline-drop-preview");
      expect(dropLine).toHaveAttribute("data-before-id", "tail");
      expect(dropLine).toHaveAttribute("data-parent-id", "parent");
      expect(dropLine).toHaveAttribute("data-depth", "1");

      await user.pointer({
        keys: "[/MouseLeft]",
        target: charlie,
        coords: { clientX: 9, clientY: charlieY },
      });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["a", "b"],
          parentId: "parent",
          afterId: "c",
          beforeId: null,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("clears a pending selected pointer preview when frozen authority rejects", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
        node({ id: "d", sortKey: 4, title: "Delta" }),
      ];
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const bravo = screen.getByRole("button", { name: "Zoom into Bravo" });
      mockOutlineRowRects();

      await user.pointer({
        keys: "[MouseLeft>]",
        target: alpha,
        coords: { clientX: 9, clientY: 14 },
      });
      await user.pointer({
        target: bravo,
        coords: { clientX: 9, clientY: 42 },
      });

      expect(
        document.querySelector(".notes-outline-drop-preview"),
      ).not.toBeNull();
      expect(
        within(screen.getByTestId("notes-selection-drag-preview")).getByText(
          "2",
        ),
      ).toHaveClass("notes-selection-drag-preview-count");
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).toHaveAttribute("data-drag-source", "true");
      }

      await act(async () =>
        hydration.reject(new Error("authority unavailable")),
      );

      await waitFor(() =>
        expect(
          within(screen.getByLabelText("Status bar feedback")).getByRole(
            "alert",
          ),
        ).toHaveTextContent(
          "Can't move selection: the selected rows cannot be moved together.",
        ),
      );
      expect(document.querySelector(".notes-outline-drop-preview")).toBeNull();
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).not.toHaveAttribute("data-drag-source");
      }
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("clears an active pending pointer preview when selection changes", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
        node({ id: "d", sortKey: 4, title: "Delta" }),
      ];
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const bravo = screen.getByRole("button", { name: "Zoom into Bravo" });
      mockOutlineRowRects();

      await user.pointer({
        keys: "[MouseLeft>]",
        target: alpha,
        coords: { clientX: 9, clientY: 14 },
      });
      await user.pointer({
        target: bravo,
        coords: { clientX: 9, clientY: 42 },
      });

      expect(
        document.querySelector(".notes-outline-drop-preview"),
      ).not.toBeNull();
      expect(
        within(screen.getByTestId("notes-selection-drag-preview")).getByText(
          "2",
        ),
      ).toHaveClass("notes-selection-drag-preview-count");
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(selectedOutlineIds()).toEqual(["a", "b", "c"]),
      );

      await waitFor(() =>
        expect(
          within(screen.getByLabelText("Status bar feedback")).getByRole(
            "alert",
          ),
        ).toHaveTextContent(
          "Can't move selection: the selected rows cannot be moved together.",
        ),
      );
      expect(document.querySelector(".notes-outline-drop-preview")).toBeNull();
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).not.toHaveAttribute("data-drag-source");
      }

      await act(async () =>
        hydration.reject(new Error("authority unavailable")),
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("clears a promoted selected drag preview when selection changes", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
        node({ id: "d", sortKey: 4, title: "Delta" }),
      ];
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const bravo = screen.getByRole("button", { name: "Zoom into Bravo" });
      mockOutlineRowRects();

      await user.pointer({
        keys: "[MouseLeft>]",
        target: alpha,
        coords: { clientX: 9, clientY: 14 },
      });
      await user.pointer({
        target: bravo,
        coords: { clientX: 9, clientY: 42 },
      });

      expect(
        document.querySelector(".notes-outline-drop-preview"),
      ).not.toBeNull();
      expect(
        within(screen.getByTestId("notes-selection-drag-preview")).getByText(
          "2",
        ),
      ).toHaveClass("notes-selection-drag-preview-count");
      await act(async () => {
        deferAuthority = false;
        hydration.resolve(workspace(activeNodes));
        await hydration.promise;
      });
      await act(async () => undefined);

      expect(
        document.querySelector(".notes-outline-drop-preview"),
      ).not.toBeNull();
      expect(
        within(screen.getByTestId("notes-selection-drag-preview")).getByText(
          "2",
        ),
      ).toHaveClass("notes-selection-drag-preview-count");
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(selectedOutlineIds()).toEqual(["a", "b", "c"]),
      );

      await waitFor(() =>
        expect(
          within(screen.getByLabelText("Status bar feedback")).getByRole(
            "alert",
          ),
        ).toHaveTextContent(
          "Can't move selection: the selected rows cannot be moved together.",
        ),
      );
      expect(document.querySelector(".notes-outline-drop-preview")).toBeNull();
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).not.toHaveAttribute("data-drag-source");
      }
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("moves five selected sibling roots as one pointer-dragged block from a middle bullet", async () => {
      const user = userEvent.setup();
      const movingIds = ["a", "b", "c", "d", "e"];
      configureRepository([
        node({ id: "parent", sortKey: 1, title: "Parent" }),
        ...["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map(
          (title, index) =>
            node({
              id: String.fromCharCode(97 + index),
              parentId: "parent",
              sortKey: index + 1,
              title,
              isCollapsed: index === 2,
            }),
        ),
        node({ id: "c-child", parentId: "c", title: "Charlie child" }),
        node({ id: "destination", sortKey: 2, title: "Destination" }),
      ]);
      notesStoreMock.applyBatch.mockImplementationOnce(
        async (_vaultRoot: string, input: ApplyNotesBatchInput) => {
          if (input.op === "move") {
            confirmedNodes = confirmedNodes.map((current) => {
              const movedIndex = movingIds.indexOf(current.id);
              return movedIndex === -1
                ? current
                : {
                    ...current,
                    parentId: "destination",
                    sortKey: movedIndex + 1,
                  };
            });
          }
          return workspace(confirmedNodes);
        },
      );
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      alpha.focus();
      for (let index = 0; index < 4; index += 1) {
        fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      }
      expect(selectedOutlineIds()).toEqual(movingIds);
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      const active = screen.getByRole("button", { name: "Zoom into Charlie" });
      const destination = screen.getByRole("button", {
        name: "Zoom into Destination",
      });
      mockOutlineRowRects();

      await user.pointer({
        keys: "[MouseLeft>]",
        target: active,
        coords: { clientX: 9, clientY: 98 },
      });
      await user.pointer({
        target: destination,
        coords: { clientX: 14, clientY: 210 },
      });
      await user.pointer({
        target: destination,
        coords: { clientX: 50, clientY: 210 },
      });

      const selectionDragPreview = screen.getByTestId(
        "notes-selection-drag-preview",
      );
      expect(selectionDragPreview).toHaveTextContent("Alpha");
      expect(selectionDragPreview).not.toHaveTextContent("Bravo");
      expect(selectionDragPreview).not.toHaveTextContent("Charlie");
      expect(selectionDragPreview).not.toHaveTextContent("Delta");
      expect(within(selectionDragPreview).getByText("6")).toHaveClass(
        "notes-selection-drag-preview-count",
      );
      expect(selectionDragPreview).not.toHaveTextContent("5 selected");
      expect(document.body).toHaveTextContent(
        "5 selected notes are over Destination.",
      );
      for (const nodeId of movingIds) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).toHaveAttribute("data-drag-source", "true");
      }
      await user.pointer({
        keys: "[/MouseLeft]",
        target: destination,
        coords: { clientX: 50, clientY: 210 },
      });

      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      for (const nodeId of movingIds) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).not.toHaveAttribute("data-drag-source");
      }

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: movingIds,
          parentId: "destination",
          afterId: null,
          beforeId: null,
        },
        historyContextMatcher(),
      );
      await waitFor(() => expect(selectedOutlineIds()).toEqual(movingIds));
      await waitFor(() =>
        expect(
          textareasByName("Edit node title").map((input) => input.value),
        ).toEqual([
          "Parent",
          "Foxtrot",
          "Destination",
          "Alpha",
          "Bravo",
          "Charlie",
          "Delta",
          "Echo",
        ]),
      );
      expect(confirmedNodes.find(({ id }) => id === "c-child")?.parentId).toBe(
        "c",
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("clears every selected source ghost when a group drag is cancelled", async () => {
      const user = userEvent.setup();
      const activeNodes = threeRoots();
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const bullet = screen.getByRole("button", { name: "Zoom into Alpha" });
      mockOutlineRowRects();

      bullet.focus();
      await user.keyboard("[Space]");

      expect(
        within(screen.getByTestId("notes-selection-drag-preview")).getByText(
          "2",
        ),
      ).toHaveClass("notes-selection-drag-preview-count");
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).toHaveAttribute("data-drag-source", "true");
      }

      await user.keyboard("[Escape]");

      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).not.toHaveAttribute("data-drag-source");
      }
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();

      await act(async () => {
        deferAuthority = false;
        hydration.resolve(workspace(activeNodes));
        await hydration.promise;
      });
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      expect(document.querySelector("[data-drag-source]")).toBeNull();
    });

    it("suppresses the active-row drag transform as soon as a selected drag is rejected", async () => {
      const user = userEvent.setup();
      const activeNodes = threeRoots();
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const alphaRow = alpha.closest<HTMLElement>(".notes-node");
      if (!alphaRow) {
        throw new Error("Alpha row did not render");
      }
      mockOutlineRowRects();

      alpha.focus();
      await user.keyboard("[Space]");
      expect(
        within(screen.getByTestId("notes-selection-drag-preview")).getByText(
          "2",
        ),
      ).toHaveClass("notes-selection-drag-preview-count");
      await act(async () =>
        hydration.reject(new Error("authority unavailable")),
      );
      await user.keyboard("[ArrowDown]");

      await waitFor(() =>
        expect(screen.getByLabelText("Status bar feedback")).toHaveTextContent(
          "Can't move selection: the selected rows cannot be moved together.",
        ),
      );

      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      expect(alphaRow).not.toHaveAttribute("data-dragging");
      expect(alphaRow.style.transform).toBe("");
      await user.keyboard("[Space]");
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("reports a pending selected drop that resolves to an invalid projection", async () => {
      const user = userEvent.setup();
      const activeNodes = threeRoots();
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      mockOutlineRowRects();

      alpha.focus();
      await user.keyboard("[Space]");

      expect(
        within(screen.getByTestId("notes-selection-drag-preview")).getByText(
          "2",
        ),
      ).toHaveClass("notes-selection-drag-preview-count");
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).toHaveAttribute("data-drag-source", "true");
      }

      await user.keyboard("[ArrowDown][Space]");

      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      for (const nodeId of ["a", "b"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).not.toHaveAttribute("data-drag-source");
      }

      await act(async () => {
        deferAuthority = false;
        hydration.resolve(workspace(activeNodes));
        await hydration.promise;
      });

      await waitFor(() =>
        expect(
          within(screen.getByLabelText("Status bar feedback")).getByRole(
            "alert",
          ),
        ).toHaveTextContent(
          "Can't move selection: the selected rows cannot be moved together.",
        ),
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      expect(document.querySelector("[data-drag-source]")).toBeNull();
      await act(async () => undefined);
    });

    it("silently retires a pending selected drop after the selection revision changes", async () => {
      const user = userEvent.setup();
      const activeNodes = threeRoots();
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      const alphaTitle = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      mockOutlineRowRects();

      alpha.focus();
      await user.keyboard("[Space][ArrowDown][Space]");
      fireEvent.click(
        screen.getByRole("button", { name: "Zoom into Charlie" }),
        { shiftKey: true },
      );
      expect(selectedOutlineIds()).toEqual(["a", "b", "c"]);

      await act(async () => {
        deferAuthority = false;
        hydration.resolve(workspace(activeNodes));
        await hydration.promise;
      });
      await act(async () => undefined);

      expect(
        within(screen.getByLabelText("Status bar feedback")).queryByRole(
          "alert",
        ),
      ).toBeNull();
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("executes only the latest selected drop while frozen authority is hydrating", async () => {
      const user = userEvent.setup();
      const activeNodes = threeRoots();
      const hydration = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return hydration.promise;
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Bravo");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      deferAuthority = true;
      fireEvent.click(screen.getByRole("button", { name: "Zoom into Bravo" }), {
        shiftKey: true,
      });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const activeLoadsBeforeFirstDrag =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
      const bravo = screen.getByRole("button", { name: "Zoom into Bravo" });
      const charlie = screen.getByRole("button", {
        name: "Zoom into Charlie",
      });
      mockOutlineRowRects();

      await user.pointer({
        keys: "[MouseLeft>]",
        target: bravo,
        coords: { clientX: 9, clientY: 42 },
      });
      await user.pointer({
        target: charlie,
        coords: { clientX: 14, clientY: 70 },
      });
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length,
      ).toBe(activeLoadsBeforeFirstDrag + 1);
      expect(bravo.closest(".notes-node")).not.toHaveAttribute("data-dragging");

      await user.pointer({
        target: charlie,
        coords: { clientX: 14, clientY: 74 },
      });
      await user.pointer({
        keys: "[/MouseLeft]",
        target: charlie,
        coords: { clientX: 14, clientY: 74 },
      });
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      await act(async () => undefined);

      await user.pointer({
        keys: "[MouseLeft>]",
        target: bravo,
        coords: { clientX: 9, clientY: 42 },
      });
      await user.pointer({
        target: alpha,
        coords: { clientX: 14, clientY: 14 },
      });
      expect(bravo.closest(".notes-node")).not.toHaveAttribute("data-dragging");
      await user.pointer({
        target: alpha,
        coords: { clientX: 14, clientY: 10 },
      });
      await user.pointer({
        keys: "[/MouseLeft]",
        target: alpha,
        coords: { clientX: 14, clientY: 10 },
      });
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();

      await act(async () => {
        hydration.resolve(workspace(activeNodes));
        deferAuthority = false;
      });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["b"],
          parentId: null,
          afterId: null,
          beforeId: "a",
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("retries failed filtered authority without accepting a stale result or zooming", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({ id: "moving", title: "Moving", isStarred: true }),
        node({ id: "target", sortKey: 2, title: "Target", isStarred: true }),
      ];
      const staleAuthority = deferred<NotesWorkspace>();
      const failedAuthority = deferred<NotesWorkspace>();
      let deferredActiveLoad = 0;
      let starredScopeLoads = 0;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (starredScopeLoads > 0 && scope.kind === "active") {
            deferredActiveLoad += 1;
            if (deferredActiveLoad === 1) {
              return staleAuthority.promise;
            }
            if (deferredActiveLoad === 2) {
              return failedAuthority.promise;
            }
            return workspace(activeNodes);
          }
          if (scope.kind === "starred") {
            starredScopeLoads += 1;
            return workspace(activeNodes);
          }
          if (scope.kind === "trash") {
            return workspace([]);
          }
          return workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Moving");
      fireEvent.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Starred" })).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );
      let moving = await screen.findByRole("button", {
        name: "Zoom into Moving",
      });
      await waitFor(() =>
        expect(moving).not.toHaveAttribute("data-sortable-activator"),
      );

      fireEvent.click(screen.getByRole("button", { name: "Trash" }));
      await waitFor(() => expect(queryTitleInput("Moving")).toBeNull());
      await act(async () => {
        staleAuthority.resolve(workspace(activeNodes));
        await staleAuthority.promise;
      });

      fireEvent.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Starred" })).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );
      moving = await screen.findByRole("button", { name: "Zoom into Moving" });
      await waitFor(() =>
        expect(moving).not.toHaveAttribute("data-sortable-activator"),
      );
      await act(async () => {
        failedAuthority.reject(new Error("authority unavailable"));
      });
      await waitFor(() =>
        expect(moving).toHaveAttribute(
          "aria-description",
          "Can't move notes: the full outline couldn't be prepared. Try again.",
        ),
      );
      await user.pointer({
        keys: "[MouseLeft>]",
        target: moving,
        coords: { clientX: 0, clientY: 0 },
      });
      await user.pointer({
        target: moving,
        coords: { clientX: 5, clientY: 0 },
      });
      await user.pointer({
        keys: "[/MouseLeft]",
        target: moving,
        coords: { clientX: 5, clientY: 0 },
      });

      expect(
        screen.queryByRole("heading", { name: "Moving", level: 1 }),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(deferredActiveLoad).toBe(3));
      await waitFor(() =>
        expect(moving).toHaveAttribute("data-sortable-activator", "true"),
      );
      moving.focus();
      await user.keyboard("[Space]");
      expect(
        screen.getByTestId("notes-selection-drag-preview"),
      ).toHaveTextContent("Moving");
      await user.keyboard("[Escape]");
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
    });

    it("preflights filtered ordinary drag presentation before enabling its activator", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({
          id: "moving",
          sortKey: 1,
          title: "Moving",
          isStarred: true,
        }),
        node({
          id: "hidden-child",
          parentId: "moving",
          title: "Hidden child",
        }),
        node({
          id: "target",
          sortKey: 2,
          title: "Target",
          isStarred: true,
        }),
      ];
      const authority = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return authority.promise;
          }
          return scope.kind === "starred"
            ? workspace(activeNodes.filter((current) => current.isStarred))
            : workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Moving");
      deferAuthority = true;
      await user.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() => expect(queryTitleInput("Hidden child")).toBeNull());
      let moving = screen.getByRole("button", { name: "Zoom into Moving" });

      await waitFor(() =>
        expect(moving).not.toHaveAttribute("data-sortable-activator"),
      );
      expect(moving).toHaveAttribute(
        "aria-description",
        "Notes are still preparing for drag. Try again.",
      );
      await user.pointer({
        keys: "[MouseLeft>]",
        target: moving,
        coords: { clientX: 0, clientY: 0 },
      });
      await user.pointer({
        target: moving,
        coords: { clientX: 5, clientY: 0 },
      });
      await user.pointer({
        keys: "[/MouseLeft]",
        target: moving,
        coords: { clientX: 5, clientY: 0 },
      });
      expect(
        within(screen.getByLabelText("Status bar feedback")).getByRole("alert"),
      ).toHaveTextContent("Notes are still preparing for drag. Try again.");
      expect(
        screen.queryByRole("heading", { name: "Moving", level: 1 }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();

      await user.click(moving);
      expect(
        await screen.findByRole("heading", { name: "Moving", level: 1 }),
      ).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Starred" }));
      moving = await screen.findByRole("button", { name: "Zoom into Moving" });
      moving.focus();
      await user.keyboard("[Enter]");
      expect(
        await screen.findByRole("heading", { name: "Moving", level: 1 }),
      ).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Starred" }));
      moving = await screen.findByRole("button", { name: "Zoom into Moving" });

      await act(async () => {
        deferAuthority = false;
        authority.resolve(workspace(activeNodes));
        await authority.promise;
      });
      await waitFor(() =>
        expect(moving).toHaveAttribute("data-sortable-activator", "true"),
      );
      moving.focus();
      await user.keyboard("[Space]");

      const preview = screen.getByTestId("notes-selection-drag-preview");
      expect(preview).toHaveTextContent("Moving");
      expect(within(preview).getByText("2")).toHaveClass(
        "notes-selection-drag-preview-count",
      );

      await user.keyboard("[Escape]");
      await waitFor(() =>
        expect(
          screen.queryByTestId("notes-selection-drag-preview"),
        ).not.toBeInTheDocument(),
      );
    });

    it("blocks filtered movement when Active authority reveals a hidden readonly descendant", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({
          id: "moving",
          sortKey: 1,
          title: "Moving",
          isStarred: true,
        }),
        node({
          id: "hidden-readonly",
          parentId: "moving",
          title: "Hidden protected child",
          isReadonly: true,
        }),
        node({
          id: "target",
          sortKey: 2,
          title: "Target",
          isStarred: true,
        }),
      ];
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) =>
          scope.kind === "starred"
            ? workspace(activeNodes.filter((current) => current.isStarred))
            : workspace(activeNodes),
      );
      renderNotesWorkspace();
      await findTitleInput("Moving");
      await user.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() =>
        expect(queryTitleInput("Hidden protected child")).toBeNull(),
      );

      const movingTitle = await findTitleInput("Moving");
      const moving = screen.getByRole("button", { name: "Zoom into Moving" });
      await waitFor(() =>
        expect(moving).not.toHaveAttribute("data-sortable-activator"),
      );

      fireEvent.keyDown(movingTitle, { key: "Tab" });
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();

      const menu = await openNodeMenu("Moving", user);
      expect(
        within(menu).getByRole("menuitem", { name: "Move To..." }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        within(menu).getByRole("menuitem", { name: "Sort A-Z" }),
      ).toHaveAttribute("aria-disabled", "true");

      await user.keyboard("[Escape]");
      await user.pointer({
        keys: "[MouseLeft>]",
        target: moving,
        coords: { clientX: 0, clientY: 0 },
      });
      await user.pointer({
        target: moving,
        coords: { clientX: 6, clientY: 0 },
      });
      await user.pointer({
        keys: "[/MouseLeft]",
        target: moving,
        coords: { clientX: 6, clientY: 0 },
      });
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
    });

    it("clears disabled drag click suppression after an outside release", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({
          id: "moving",
          sortKey: 1,
          title: "Moving",
          isStarred: true,
        }),
        node({
          id: "hidden-child",
          parentId: "moving",
          title: "Hidden child",
        }),
      ];
      const authority = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return authority.promise;
          }
          return scope.kind === "starred"
            ? workspace(activeNodes.filter((current) => current.isStarred))
            : workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Moving");
      deferAuthority = true;
      const starred = screen.getByRole("button", { name: "Starred" });
      await user.click(starred);
      await waitFor(() => expect(queryTitleInput("Hidden child")).toBeNull());
      const moving = screen.getByRole("button", { name: "Zoom into Moving" });
      await waitFor(() =>
        expect(moving).not.toHaveAttribute("data-sortable-activator"),
      );

      await user.pointer({
        keys: "[MouseLeft>]",
        target: moving,
        coords: { clientX: 0, clientY: 0 },
      });
      await user.pointer({
        target: starred,
        coords: { clientX: 5, clientY: 0 },
      });
      await user.pointer({
        keys: "[/MouseLeft]",
        target: starred,
        coords: { clientX: 5, clientY: 0 },
      });
      expect(
        screen.queryByRole("heading", { name: "Moving", level: 1 }),
      ).not.toBeInTheDocument();

      await act(async () => {
        deferAuthority = false;
        authority.resolve(workspace(activeNodes));
        await authority.promise;
      });
      await waitFor(() =>
        expect(moving).toHaveAttribute("data-sortable-activator", "true"),
      );

      await user.click(moving);
      expect(
        await screen.findByRole("heading", { name: "Moving", level: 1 }),
      ).toBeVisible();
    });

    it("preflights filtered selected drag presentation before enabling its activator", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({
          id: "moving",
          sortKey: 1,
          title: "Moving",
          isStarred: true,
        }),
        node({
          id: "hidden-child",
          parentId: "moving",
          title: "Hidden child",
        }),
        node({
          id: "second",
          sortKey: 2,
          title: "Second",
          isStarred: true,
        }),
        node({
          id: "target",
          sortKey: 3,
          title: "Target",
          isStarred: true,
        }),
      ];
      const authority = deferred<NotesWorkspace>();
      let deferAuthority = false;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (deferAuthority && scope.kind === "active") {
            return authority.promise;
          }
          return scope.kind === "starred"
            ? workspace(activeNodes.filter((current) => current.isStarred))
            : workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Moving");
      await user.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() => expect(queryTitleInput("Hidden child")).toBeNull());
      const movingTitle = await findTitleInput("Moving");
      const moving = screen.getByRole("button", { name: "Zoom into Moving" });
      await waitFor(() =>
        expect(moving).toHaveAttribute("data-sortable-activator", "true"),
      );
      deferAuthority = true;

      fireEvent.keyDown(movingTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(selectedOutlineIds()).toEqual(["moving", "second"]),
      );
      await waitFor(() =>
        expect(moving).not.toHaveAttribute("data-sortable-activator"),
      );
      fireEvent.pointerDown(moving, { button: 0, pointerId: 42 });
      fireEvent.pointerMove(window, {
        clientX: 5,
        pointerId: 42,
      });
      expect(
        within(screen.getByLabelText("Status bar feedback")).getByRole("alert"),
      ).toHaveTextContent("Notes are still preparing for drag. Try again.");
      fireEvent.pointerUp(moving, { button: 0, pointerId: 42 });
      expect(
        screen.queryByTestId("notes-selection-drag-preview"),
      ).not.toBeInTheDocument();

      await act(async () => {
        deferAuthority = false;
        authority.resolve(workspace(activeNodes));
        await authority.promise;
      });
      await waitFor(() =>
        expect(moving).toHaveAttribute("data-sortable-activator", "true"),
      );
      moving.focus();
      await user.keyboard("[Space]");

      const preview = screen.getByTestId("notes-selection-drag-preview");
      expect(preview).toHaveTextContent("Moving");
      expect(within(preview).getByText("3")).toHaveClass(
        "notes-selection-drag-preview-count",
      );

      await user.keyboard("[Escape]");
      await waitFor(() =>
        expect(
          screen.queryByTestId("notes-selection-drag-preview"),
        ).not.toBeInTheDocument(),
      );
    });

    it("retries failed filtered selected context from Space without zooming", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({
          id: "parent",
          sortKey: 1,
          title: "Parent",
          isStarred: true,
        }),
        node({
          id: "child",
          parentId: "parent",
          title: "Child",
          isStarred: true,
        }),
        node({
          id: "hidden",
          parentId: "child",
          title: "Hidden",
        }),
        node({
          id: "target",
          sortKey: 2,
          title: "Target",
          isStarred: true,
        }),
      ];
      let failSelectedContext = false;
      let allowSelectedContextRetry = false;
      let activeLoadsAfterSelection = 0;
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) => {
          if (failSelectedContext && scope.kind === "active") {
            activeLoadsAfterSelection += 1;
            if (activeLoadsAfterSelection >= 2 && !allowSelectedContextRetry) {
              throw new Error("selection context unavailable");
            }
          }
          return scope.kind === "starred"
            ? workspace(activeNodes.filter((current) => current.isStarred))
            : workspace(activeNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Parent");
      await user.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() => expect(queryTitleInput("Hidden")).toBeNull());
      const parentTitle = await findTitleInput("Parent");
      const parent = screen.getByRole("button", { name: "Zoom into Parent" });
      await waitFor(() =>
        expect(parent).toHaveAttribute("data-sortable-activator", "true"),
      );
      failSelectedContext = true;

      fireEvent.keyDown(parentTitle, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(selectedOutlineIds()).toEqual(["parent", "child"]),
      );
      await waitFor(() =>
        expect(parent).toHaveAttribute(
          "aria-description",
          "Can't move notes: the full outline couldn't be prepared. Try again.",
        ),
      );
      const loadsBeforeRetry = activeLoadsAfterSelection;
      allowSelectedContextRetry = true;

      parent.focus();
      await user.keyboard("[Space]");

      expect(
        screen.queryByRole("heading", { name: "Parent", level: 1 }),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByLabelText("Status bar feedback")).getByRole("alert"),
      ).toHaveTextContent("Notes are still preparing for drag. Try again.");
      await waitFor(() =>
        expect(activeLoadsAfterSelection).toBe(loadsBeforeRetry + 1),
      );
      await waitFor(() =>
        expect(parent).toHaveAttribute("data-sortable-activator", "true"),
      );

      parent.focus();
      await user.keyboard("[Space]");
      const preview = screen.getByTestId("notes-selection-drag-preview");
      expect(preview).toHaveTextContent("Parent");
      expect(within(preview).getByText("3")).toHaveClass(
        "notes-selection-drag-preview-count",
      );
      await user.keyboard("[Escape]");
      await waitFor(() =>
        expect(
          screen.queryByTestId("notes-selection-drag-preview"),
        ).not.toBeInTheDocument(),
      );
    });

    it("appends a filtered selected drag after hidden children from frozen Active order", async () => {
      const user = userEvent.setup();
      const activeNodes = [
        node({
          id: "moving",
          sortKey: 1,
          title: "Moving",
          isStarred: true,
        }),
        node({
          id: "visible-child",
          parentId: "moving",
          sortKey: 1,
          title: "Visible child",
          isStarred: true,
        }),
        node({
          id: "moving-child",
          parentId: "visible-child",
          title: "Moving child",
        }),
        node({
          id: "second",
          sortKey: 2,
          title: "Second",
          isStarred: true,
        }),
        node({
          id: "parent",
          sortKey: 3,
          title: "Parent",
          isCollapsed: true,
          isStarred: true,
        }),
        node({
          id: "hidden",
          parentId: "parent",
          sortKey: 1,
          title: "Hidden",
        }),
      ];
      configureRepository(activeNodes);
      notesStoreMock.loadWorkspace.mockImplementation(
        async (_vaultRoot: string, scope: { kind: string }) =>
          scope.kind === "starred"
            ? workspace(confirmedNodes.filter((current) => current.isStarred))
            : workspace(confirmedNodes),
      );
      notesStoreMock.applyBatch.mockImplementation(
        async (_vaultRoot: string, input: ApplyNotesBatchInput) => {
          if (input.op === "move") {
            confirmedNodes = confirmedNodes.map((current) =>
              current.id === "moving" || current.id === "second"
                ? {
                    ...current,
                    parentId: "parent",
                    sortKey: current.id === "moving" ? 2 : 3,
                  }
                : current,
            );
          }
          return workspace(confirmedNodes);
        },
      );
      renderNotesWorkspace();
      await findTitleInput("Moving");
      await user.click(screen.getByRole("button", { name: "Starred" }));
      await waitFor(() => expect(queryTitleInput("Hidden")).toBeNull());
      expect(queryTitleInput("Moving child")).toBeNull();
      const moving = screen.getByRole("button", { name: "Zoom into Moving" });
      const parent = screen.getByRole("button", { name: "Zoom into Parent" });
      mockOutlineRowRects();

      await user.pointer({
        keys: "[MouseLeft>]",
        target: moving,
        coords: { clientX: 9, clientY: 14 },
      });
      await user.pointer({
        target: parent,
        coords: { clientX: 14, clientY: 98 },
      });

      const ordinaryPreview = await screen.findByTestId(
        "notes-selection-drag-preview",
      );
      await waitFor(() =>
        expect(within(ordinaryPreview).getByText("3")).toHaveClass(
          "notes-selection-drag-preview-count",
        ),
      );
      for (const nodeId of ["moving", "visible-child"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).toHaveAttribute("data-drag-source", "true");
      }
      for (const row of document.querySelectorAll<HTMLElement>(".notes-node")) {
        expect(row.style.transform).toBe("");
        expect(row).not.toHaveAttribute("data-dragging");
      }

      await user.keyboard("[Escape]");
      await user.pointer({
        keys: "[/MouseLeft]",
        target: parent,
        coords: { clientX: 14, clientY: 98 },
      });

      const movingTitle = await findTitleInput("Moving");
      fireEvent.keyDown(movingTitle, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(movingTitle, { key: "ArrowDown", shiftKey: true });
      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 3 selected notes",
      });
      await waitFor(() =>
        expect(
          within(toolbar).getByRole("button", { name: "Move To" }),
        ).toHaveAttribute("aria-disabled", "false"),
      );
      await user.pointer({
        keys: "[MouseLeft>]",
        target: moving,
        coords: { clientX: 9, clientY: 14 },
      });
      await user.pointer({
        target: parent,
        coords: { clientX: 14, clientY: 98 },
      });
      await user.pointer({
        target: parent,
        coords: { clientX: 36, clientY: 98 },
      });

      const preview = screen.getByTestId("notes-selection-drag-preview");
      expect(preview).toHaveTextContent("Moving");
      expect(preview).not.toHaveTextContent("Second");
      expect(within(preview).getByText("4")).toHaveClass(
        "notes-selection-drag-preview-count",
      );
      for (const nodeId of ["moving", "visible-child", "second"]) {
        expect(
          document
            .querySelector(`[data-outline-id="${nodeId}"]`)
            ?.closest(".notes-outline-item"),
        ).toHaveAttribute("data-drag-source", "true");
      }

      await user.pointer({
        keys: "[/MouseLeft]",
        target: parent,
        coords: { clientX: 36, clientY: 98 },
      });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["moving", "second"],
          parentId: "parent",
          afterId: "hidden",
          beforeId: null,
        },
        historyContextMatcher(),
      );
      await waitFor(() =>
        expect(
          document.querySelector('[data-outline-id="moving"]'),
        ).toHaveAttribute("data-range-selected", "true"),
      );
      expect(
        screen.getByRole("toolbar", {
          name: "Actions for 3 selected notes",
        }),
      ).toBeVisible();
    });

    it("keeps an invalid selected drag inside the range a no-op", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      expect(
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ),
      ).toHaveLength(activeLoadsBeforeSelection + 1);
      const bullet = screen.getByRole("button", { name: "Zoom into Alpha" });
      mockOutlineRowRects();

      bullet.focus();
      await user.keyboard("[Space][ArrowDown][Space]");

      await waitFor(() =>
        expect(document.body).toHaveTextContent(
          "No move was made for 2 selected notes.",
        ),
      );
      expect(screen.getByLabelText("Status bar feedback")).toHaveTextContent(
        "Can't move selection: the selected rows cannot be moved together.",
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
      expect(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-outline-id][data-range-selected="true"]',
          ),
        ).map((row) => row.dataset.outlineId),
      ).toEqual(["a", "b"]);
    });

    it("normalizes an ancestor selected drag to one frozen structural root", async () => {
      const user = userEvent.setup();
      configureRepository([
        node({ id: "parent", sortKey: 1, title: "Parent" }),
        node({ id: "child", parentId: "parent", title: "Child" }),
        node({ id: "tail", sortKey: 2, title: "Tail" }),
      ]);
      renderNotesWorkspace();
      const title = await findTitleInput("Parent");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThanOrEqual(activeLoadsBeforeSelection + 3),
      );
      await act(async () => undefined);
      const bullet = screen.getByRole("button", { name: "Zoom into Child" });
      mockOutlineRowRects();

      bullet.focus();
      await user.keyboard("[Space][ArrowDown][Space]");

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["parent"],
          parentId: null,
          afterId: "tail",
          beforeId: null,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("routes a selected row menu through the full-range command bridge", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });

      const menu = await openNodeMenu("Bravo", user);
      expect(within(menu).queryByRole("menuitem", { name: "Star" })).toBeNull();
      await user.click(
        within(menu).getByRole("menuitem", { name: "Complete" }),
      );

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "complete",
          nodeIds: ["a", "b"],
          completed: true,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    });

    it("keeps the selected menu store safe while Delete clears its range", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });

      const menu = await openNodeMenu("Bravo", user);
      await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));

      await waitFor(() =>
        expect(notesStoreMock.deleteNodes).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
        "/vault",
        {
          nodeIds: ["a", "b"],
        },
        historyContextMatcher(),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("toolbar", {
            name: "Actions for 2 selected notes",
          }),
        ).toBeNull(),
      );
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("clears the range before an unselected row menu performs its ordinary action", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      expect(
        screen.getByRole("toolbar", { name: "Actions for 2 selected notes" }),
      ).toBeVisible();

      const menu = await openNodeMenu("Charlie", user);
      await waitFor(() =>
        expect(
          screen.queryByRole("toolbar", {
            name: "Actions for 2 selected notes",
          }),
        ).toBeNull(),
      );
      await user.click(
        within(menu).getByRole("menuitem", { name: "Complete" }),
      );

      await waitFor(() =>
        expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
          "/vault",
          "c",
          historyContextMatcher(),
        ),
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
    });

    it("moves a selected ancestor forest through frozen structural-root ownership", async () => {
      const user = userEvent.setup();
      configureRepository([
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", parentId: "a", sortKey: 1, title: "Bravo" }),
        node({ id: "c", sortKey: 2, title: "Charlie" }),
      ]);
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });

      const menu = await openNodeMenu("Bravo", user);
      await user.click(within(menu).getByRole("menuitem", { name: "Move To" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Move selection",
      });
      expect(
        within(dialog).queryByRole("option", { name: "Alpha" }),
      ).toBeNull();
      expect(
        within(dialog).queryByRole("option", { name: "Bravo" }),
      ).toBeNull();
      await user.click(within(dialog).getByRole("option", { name: "Charlie" }));

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["a"],
          parentId: "c",
          afterId: null,
          beforeId: null,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("removes a frozen selected-row tag union from every explicit selected row", async () => {
      const user = userEvent.setup();
      configureRepository([
        node({ id: "a", sortKey: 1, title: "Alpha #One" }),
        node({ id: "b", sortKey: 2, title: "Bravo", note: "@Owner" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
      ]);
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha #One");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      const toolbar = screen.getByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });

      await user.click(within(toolbar).getByRole("button", { name: "Tags" }));
      const dialog = await screen.findByRole("dialog", { name: "Edit tags" });
      await user.click(within(dialog).getByRole("tab", { name: "Remove" }));
      expect(
        within(dialog).getByRole("option", { name: "#One" }),
      ).toBeVisible();
      expect(
        within(dialog).getByRole("option", { name: "@Owner" }),
      ).toBeVisible();
      await user.click(within(dialog).getByRole("option", { name: "#One" }));

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "removeTag",
          nodeIds: ["a", "b"],
          tag: { prefix: "#", normalizedTag: "one" },
        },
        historyContextMatcher(),
      );
    });

    it("adds a canonical tag payload to every row selected from the toolbar", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      const toolbar = screen.getByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });

      await user.click(within(toolbar).getByRole("button", { name: "Tags" }));
      const dialog = await screen.findByRole("dialog", { name: "Edit tags" });
      await user.type(
        within(dialog).getByRole("combobox", { name: "Tag to add" }),
        "#Straße{Enter}",
      );

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "addTag",
          nodeIds: ["a", "b"],
          tag: {
            prefix: "#",
            normalizedTag: "strasse",
            displayTag: "Straße",
          },
        },
        historyContextMatcher(),
      );
      expect(selectedOutlineIds()).toEqual(["a", "b"]);
    });

    it("moves a caret row with the Workflowy chord through one node mutation", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const bravo = await findTitleInput("Bravo");
      bravo.focus();

      expect(
        fireEvent.keyDown(bravo, {
          key: "ArrowUp",
          altKey: true,
          shiftKey: true,
        }),
      ).toBe(false);

      await waitFor(() =>
        expect(notesStoreMock.moveNode).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "b",
          parentId: null,
          afterId: null,
          beforeId: "a",
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
    });

    it("moves a Workflowy-selected block through one batch mutation", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      await screen.findByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });

      expect(
        fireEvent.keyDown(alpha, {
          key: "ArrowDown",
          altKey: true,
          shiftKey: true,
        }),
      ).toBe(false);

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "move",
          nodeIds: ["a", "b"],
          parentId: null,
          afterId: "c",
          beforeId: null,
        },
        historyContextMatcher(),
      );
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    });

    it("publishes chooser preparation busy to every selected-row action surface", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const chooserAuthority = deferred<NotesWorkspace>();
      notesStoreMock.loadWorkspace.mockImplementationOnce(
        () => chooserAuthority.promise,
      );

      const openingMenu = await openNodeMenu("Bravo", user);
      await user.click(
        within(openingMenu).getByRole("menuitem", { name: "Tags" }),
      );
      await waitFor(() =>
        expect(notesStoreMock.loadWorkspace).toHaveBeenLastCalledWith(
          "/vault",
          { kind: "active" },
        ),
      );

      const busyMenu = await openNodeMenu("Alpha", user);
      expect(
        within(busyMenu)
          .getAllByRole("menuitem")
          .every((item) => item.getAttribute("aria-disabled") === "true"),
      ).toBe(true);
      await act(async () => chooserAuthority.resolve(workspace(threeRoots())));
      expect(
        await screen.findByRole("dialog", { name: "Edit tags" }),
      ).toBeVisible();
    });

    it("reports a current chooser preparation failure on the shared toolbar", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      notesStoreMock.loadWorkspace.mockRejectedValueOnce(
        new Error("authority unavailable"),
      );
      const toolbar = screen.getByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });

      await user.click(within(toolbar).getByRole("button", { name: "Tags" }));

      expect(
        await within(screen.getByLabelText("Status bar feedback")).findByRole(
          "alert",
        ),
      ).toHaveTextContent(/couldn't open/i);
      expect(screen.queryByRole("dialog", { name: "Edit tags" })).toBeNull();
    });

    it("does not restore a pre-revision router status after a chooser error clears", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const toolbar = screen.getByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });
      const statusBar = screen.getByLabelText("Status bar feedback");

      await user.click(
        within(toolbar).getByRole("button", { name: "Complete" }),
      );
      expect(await within(statusBar).findByRole("status")).toHaveTextContent(
        "Completed selection.",
      );

      notesStoreMock.loadWorkspace.mockRejectedValueOnce(
        new Error("authority unavailable"),
      );
      await user.click(within(toolbar).getByRole("button", { name: "Tags" }));
      expect(await within(statusBar).findByRole("alert")).toHaveTextContent(
        /couldn't open/i,
      );

      await user.click(
        within(toolbar).getByRole("button", { name: "Clear selection" }),
      );
      await waitFor(() => {
        expect(within(statusBar).queryByRole("status")).toBeNull();
        expect(within(statusBar).queryByRole("alert")).toBeNull();
      });
    });

    it("does not restore a pre-revision router error after a chooser error clears", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      const toolbar = screen.getByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });
      const statusBar = screen.getByLabelText("Status bar feedback");

      fireEvent.keyDown(title, { key: "Tab" });
      expect(await within(statusBar).findByRole("alert")).toHaveTextContent(
        "Can't indent selection",
      );

      notesStoreMock.loadWorkspace.mockRejectedValueOnce(
        new Error("authority unavailable"),
      );
      await user.click(within(toolbar).getByRole("button", { name: "Tags" }));
      await waitFor(() =>
        expect(within(statusBar).getByRole("alert")).toHaveTextContent(
          /couldn't open/i,
        ),
      );

      await user.click(
        within(toolbar).getByRole("button", { name: "Clear selection" }),
      );
      await waitFor(() => {
        expect(within(statusBar).queryByRole("status")).toBeNull();
        expect(within(statusBar).queryByRole("alert")).toBeNull();
      });
    });

    it("cancels stale chooser preparation when the selection revision changes", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      const chooserAuthority = deferred<NotesWorkspace>();
      notesStoreMock.loadWorkspace.mockImplementationOnce(
        () => chooserAuthority.promise,
      );
      const activeLoadsBeforeChooser =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;

      const menu = await openNodeMenu("Bravo", user);
      await user.click(within(menu).getByRole("menuitem", { name: "Tags" }));
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeChooser),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Zoom into Charlie" }),
        { shiftKey: true },
      );
      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 3 selected notes",
      });
      await waitFor(() =>
        expect(
          within(toolbar).getByRole("button", { name: "Tags" }),
        ).toHaveAttribute("aria-disabled", "false"),
      );
      const charlie = queryTitleInput("Charlie");
      if (!charlie) {
        throw new Error("Charlie title did not render");
      }
      charlie.focus();

      await act(async () =>
        chooserAuthority.reject(new Error("stale authority failure")),
      );
      expect(
        within(screen.getByLabelText("Status bar feedback")).queryByRole(
          "alert",
        ),
      ).toBeNull();
      expect(charlie).toHaveFocus();

      await user.click(within(toolbar).getByRole("button", { name: "Tags" }));
      expect(
        await screen.findByRole("dialog", { name: "Edit tags" }),
      ).toBeVisible();
    });

    it("returns focus to the selected head after a current menu chooser failure", async () => {
      const user = userEvent.setup();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      const activeLoadsBeforeSelection =
        notesStoreMock.loadWorkspace.mock.calls.filter(
          ([, scope]) => scope.kind === "active",
        ).length;
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      await waitFor(() =>
        expect(
          notesStoreMock.loadWorkspace.mock.calls.filter(
            ([, scope]) => scope.kind === "active",
          ).length,
        ).toBeGreaterThan(activeLoadsBeforeSelection),
      );
      await act(async () => undefined);
      notesStoreMock.loadWorkspace.mockRejectedValueOnce(
        new Error("authority unavailable"),
      );
      const bravo = queryTitleInput("Bravo");
      if (!bravo) {
        throw new Error("Bravo title did not render");
      }

      const menu = await openNodeMenu("Bravo", user);
      await user.click(within(menu).getByRole("menuitem", { name: "Tags" }));

      screen.getByRole("toolbar", {
        name: "Actions for 2 selected notes",
      });
      expect(
        await within(screen.getByLabelText("Status bar feedback")).findByRole(
          "alert",
        ),
      ).toHaveTextContent(/couldn't open/i);
      await waitFor(() => expect(bravo).toHaveFocus());
    });

    it("closes an open chooser when its workspace scope becomes stale", async () => {
      const user = userEvent.setup();
      configureRepository([
        node({ id: "a", sortKey: 1, title: "Alpha", isStarred: true }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
      ]);
      renderNotesWorkspace();
      await findTitleInput("Alpha");
      const starredView = screen.getByRole("button", { name: "Starred" });
      fireEvent.click(screen.getByRole("button", { name: "Zoom into Alpha" }), {
        shiftKey: true,
      });
      const toolbar = await screen.findByRole("toolbar", {
        name: "Actions for 1 selected notes",
      });
      await user.click(within(toolbar).getByRole("button", { name: "Tags" }));
      expect(
        await screen.findByRole("dialog", { name: "Edit tags" }),
      ).toBeVisible();

      fireEvent.click(starredView);

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Edit tags" })).toBeNull(),
      );
    });

    it("clears a range whose endpoints leave the body projection", async () => {
      const user = userEvent.setup();
      configureRepository([
        node({ id: "parent", sortKey: 1, title: "Parent" }),
        node({ id: "a", parentId: "parent", sortKey: 1, title: "Alpha" }),
        node({ id: "b", parentId: "parent", sortKey: 2, title: "Bravo" }),
      ]);
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      expect(
        screen.getByRole("toolbar", { name: "Actions for 2 selected notes" }),
      ).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Collapse Parent" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("toolbar", { name: /Actions for/ }),
        ).toBeNull(),
      );
      await user.click(screen.getByRole("button", { name: "Expand Parent" }));
      await findTitleInput("Alpha");

      expect(screen.queryByRole("toolbar", { name: /Actions for/ })).toBeNull();
      expect(
        document.querySelector('[data-outline-id="a"]'),
      ).not.toHaveAttribute("data-range-selected");
      expect(
        document.querySelector('[data-outline-id="b"]'),
      ).not.toHaveAttribute("data-range-selected");
    });

    it("completes a keyboard-selected range with a single applyBatch call", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      // Shift+ArrowDown twice extends the live selection across all three
      // siblings without moving the caret off Alpha.
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      // History is not wired in this harness, so no history-context arg trails
      // the call (parity with the single-node commands here).
      expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
        "/vault",
        {
          op: "complete",
          nodeIds: ["a", "b", "c"],
          completed: true,
        },
        historyContextMatcher(),
      );
      // The whole-selection path fully replaces the single-node command.
      expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: "Alt+Shift+ArrowUp",
        platform: "Win32",
        modifier: { altKey: true },
        key: "ArrowUp",
        expected: {
          op: "move",
          nodeIds: ["b", "c"],
          parentId: null,
          afterId: null,
          beforeId: "a",
        },
      },
      {
        label: "Ctrl+Shift+ArrowUp",
        platform: "MacIntel",
        modifier: { ctrlKey: true },
        key: "ArrowUp",
        expected: {
          op: "move",
          nodeIds: ["b", "c"],
          parentId: null,
          afterId: null,
          beforeId: "a",
        },
      },
      {
        label: "Alt+Shift+ArrowDown",
        platform: "Win32",
        modifier: { altKey: true },
        key: "ArrowDown",
        expected: {
          op: "move",
          nodeIds: ["b", "c"],
          parentId: null,
          afterId: "d",
          beforeId: null,
        },
      },
      {
        label: "Ctrl+Shift+ArrowDown",
        platform: "MacIntel",
        modifier: { ctrlKey: true },
        key: "ArrowDown",
        expected: {
          op: "move",
          nodeIds: ["b", "c"],
          parentId: null,
          afterId: "d",
          beforeId: null,
        },
      },
    ])(
      "routes $label as one exact selection move",
      async ({ platform, modifier, key, expected }) => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
        configureRepository([
          node({ id: "a", sortKey: 1, title: "Alpha" }),
          node({ id: "b", sortKey: 2, title: "Bravo" }),
          node({ id: "c", sortKey: 3, title: "Charlie" }),
          node({ id: "d", sortKey: 4, title: "Delta" }),
        ]);
        renderNotesWorkspace();
        const bravo = await findTitleInput("Bravo");
        bravo.focus();
        fireEvent.keyDown(bravo, { key: "ArrowDown", shiftKey: true });
        expect(selectedOutlineIds()).toEqual(["b", "c"]);

        expect(
          fireEvent.keyDown(bravo, { key, ...modifier, shiftKey: true }),
        ).toBe(false);

        await waitFor(() =>
          expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
        );
        expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
          "/vault",
          expected,
          historyContextMatcher(),
        );
        expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
        expect(selectedOutlineIds()).toEqual(["b", "c"]);
      },
    );

    it("soft-deletes a keyboard-selected range as one batch", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, {
        key: "Backspace",
        ctrlKey: true,
        shiftKey: true,
      });

      await waitFor(() =>
        expect(notesStoreMock.deleteNodes).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
        "/vault",
        {
          nodeIds: ["a", "b"],
        },
        historyContextMatcher(),
      );
      // The surviving neighbor takes focus.
      await waitFor(() => expect(getTitleInput("Charlie")).toHaveFocus());
      expect(
        await within(screen.getByLabelText("Status bar feedback")).findByRole(
          "status",
        ),
      ).toHaveTextContent("Deleted selection.");
      expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
    });

    it("does not steal note focus from a surviving row entered while a selected delete is pending", async () => {
      useCtrlPlatform();
      const before = [
        node({ id: "a", sortKey: 1, title: "Alpha" }),
        node({ id: "b", sortKey: 2, title: "Bravo" }),
        node({ id: "c", sortKey: 3, title: "Charlie" }),
        node({
          id: "d",
          sortKey: 4,
          title: "Delta",
          note: "Keep this caret",
        }),
      ];
      const after = before.slice(2);
      configureRepository(before);
      const deletion = deferred<NotesWorkspace>();
      notesStoreMock.deleteNodes.mockReturnValueOnce(deletion.promise);
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      act(() => alpha.focus());
      fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(alpha, {
        key: "Backspace",
        ctrlKey: true,
        shiftKey: true,
      });
      await waitFor(() =>
        expect(notesStoreMock.deleteNodes).toHaveBeenCalledOnce(),
      );
      expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
        "/vault",
        {
          nodeIds: ["a", "b"],
        },
        historyContextMatcher(),
      );

      const deltaNote = getTextareaByName("Supporting note: Delta");
      act(() => deltaNote.focus());
      expect(deltaNote).toHaveFocus();

      confirmedNodes = after;
      await act(async () => deletion.resolve(workspace(after)));

      await waitFor(() =>
        expect(queryTextareaByName("Supporting note: Delta")).toHaveFocus(),
      );
      expect(queryTitleInput("Charlie")).not.toHaveFocus();
    });

    it("rejects indent atomically when the selected first sibling has no outside predecessor", async () => {
      const before = [
        node({ id: "parent", sortKey: 1, title: "Parent" }),
        node({ id: "a", parentId: "parent", sortKey: 1, title: "Alpha" }),
        node({ id: "b", parentId: "parent", sortKey: 2, title: "Bravo" }),
        node({ id: "c", parentId: "parent", sortKey: 3, title: "Charlie" }),
        node({ id: "d", parentId: "parent", sortKey: 4, title: "Delta" }),
        node({ id: "e", parentId: "parent", sortKey: 5, title: "Echo" }),
        node({ id: "f", parentId: "parent", sortKey: 6, title: "Foxtrot" }),
      ];
      configureRepository(before);
      renderNotesWorkspace();
      const alpha = await findTitleInput("Alpha");
      act(() => alpha.focus());

      for (let index = 0; index < 4; index += 1) {
        fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
      }
      expect(selectedOutlineIds()).toEqual(["a", "b", "c", "d", "e"]);

      fireEvent.keyDown(alpha, { key: "Tab" });

      expect(selectedOutlineIds()).toEqual(["a", "b", "c", "d", "e"]);
      expect(alpha).toHaveFocus();
      const toolbar = screen.getByRole("toolbar", {
        name: "Actions for 5 selected notes",
      });
      expect(within(toolbar).queryByRole("alert")).not.toBeInTheDocument();
      const status = within(
        screen.getByLabelText("Status bar feedback"),
      ).getByRole("alert");
      await waitFor(() =>
        expect(status).toHaveTextContent(
          /^Can't indent selection: the first selected item has no preceding sibling outside the selection\.$/,
        ),
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      expect(status).toHaveAttribute("data-kind", "error");

      fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
    });

    it.each([
      {
        shortcut: "Tab",
        shiftKey: false,
        op: "indent" as const,
        expectedDepth: "1",
        before: [
          node({ id: "parent", sortKey: 1, title: "Parent" }),
          node({ id: "a", sortKey: 2, title: "Alpha" }),
          node({ id: "b", sortKey: 3, title: "Bravo" }),
        ],
        after: [
          node({ id: "parent", sortKey: 1, title: "Parent" }),
          node({
            id: "a",
            parentId: "parent",
            sortKey: 1,
            title: "Alpha",
          }),
          node({
            id: "b",
            parentId: "parent",
            sortKey: 2,
            title: "Bravo",
          }),
        ],
      },
      {
        shortcut: "Shift+Tab",
        shiftKey: true,
        op: "outdent" as const,
        expectedDepth: "0",
        before: [
          node({ id: "parent", sortKey: 1, title: "Parent" }),
          node({
            id: "a",
            parentId: "parent",
            sortKey: 1,
            title: "Alpha",
          }),
          node({
            id: "b",
            parentId: "parent",
            sortKey: 2,
            title: "Bravo",
          }),
        ],
        after: [
          node({ id: "parent", sortKey: 1, title: "Parent" }),
          node({ id: "a", sortKey: 2, title: "Alpha" }),
          node({ id: "b", sortKey: 3, title: "Bravo" }),
        ],
      },
    ])(
      "keeps the selected rows selected after batch $shortcut",
      async ({ shiftKey, op, expectedDepth, before, after }) => {
        configureRepository(before);
        const batch = deferred<NotesWorkspace>();
        notesStoreMock.applyBatch.mockReturnValueOnce(batch.promise);
        renderNotesWorkspace();
        const alpha = await findTitleInput("Alpha");
        act(() => alpha.focus());

        const selectedOutlineIds = () =>
          Array.from(
            document.querySelectorAll(
              '[data-outline-id][data-range-selected="true"]',
            ),
          ).map((row) => row.getAttribute("data-outline-id"));

        fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
        expect(selectedOutlineIds()).toEqual(["a", "b"]);

        fireEvent.keyDown(alpha, { key: "Tab", shiftKey });

        await waitFor(() =>
          expect(notesStoreMock.applyBatch).toHaveBeenCalledWith(
            "/vault",
            {
              op,
              nodeIds: ["a", "b"],
            },
            historyContextMatcher(),
          ),
        );
        expect(selectedOutlineIds()).toEqual(["a", "b"]);
        await act(async () => batch.resolve(workspace(after)));
        await waitFor(() => expect(selectedOutlineIds()).toEqual(["a", "b"]));
        const alphaRow = document.querySelector<HTMLElement>(
          '[data-outline-id="a"]',
        );
        await waitFor(() =>
          expect(alphaRow?.style.getPropertyValue("--notes-depth")).toBe(
            expectedDepth,
          ),
        );
        const focusedAlpha = await findTitleInput("Alpha");
        expect(focusedAlpha).toHaveFocus();

        // The selection direction also survives the structural refresh:
        // anchor stays on Alpha and head stays on Bravo, so moving the head
        // upward collapses the range back to Alpha.
        fireEvent.keyDown(focusedAlpha, {
          key: "ArrowUp",
          shiftKey: true,
        });
        expect(selectedOutlineIds()).toEqual(["a"]);
      },
    );

    it("keeps the single-node completion path when no selection is active", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

      await waitFor(() =>
        expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
          "/vault",
          "a",
          historyContextMatcher(),
        ),
      );
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
    });

    it("preserves selection and focus when a batch is dropped by a failed draft flush", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      notesStoreMock.updateNode.mockRejectedValue(new Error("save failed"));
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      // The dirty draft is the barrier the batch must clear; typing collapses
      // the selection, so rebuild it with Shift+ArrowDown afterward.
      fireEvent.change(title, { target: { value: "Alpha edited" } });
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      expect(selectedOutlineIds()).toEqual(["a", "b", "c"]);
      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

      await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalled());
      // The batch never reached the backend (Phase 3.5)...
      expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
      // ...and the shared semantic router explains the pause instead of
      // silently swallowing it.
      await screen.findByText(/Save pending changes before continuing/i);
      expect(selectedOutlineIds()).toEqual(["a", "b", "c"]);
      expect(title).toHaveFocus();

      // Settle the failed draft before unmount so its shutdown retry cannot
      // write "Alpha edited" into the next test's shared repository fixture.
      const callsBeforeRetry = notesStoreMock.updateNode.mock.calls.length;
      notesStoreMock.updateNode.mockImplementation(
        async (_vaultRoot: string, input: UpdateNoteNodeInput) => {
          confirmedNodes = confirmedNodes.map((current) =>
            current.id === input.id
              ? { ...current, title: input.title, note: input.note }
              : current,
          );
          return workspace(confirmedNodes);
        },
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
      await waitFor(() =>
        expect(notesStoreMock.updateNode).toHaveBeenCalledTimes(
          callsBeforeRetry + 1,
        ),
      );
      await waitFor(() =>
        expect(screen.queryByText(/editing commands are paused/i)).toBeNull(),
      );
    });

    it("preserves selection and focus when applyBatch rejects", async () => {
      useCtrlPlatform();
      configureRepository(threeRoots());
      notesStoreMock.applyBatch.mockRejectedValueOnce(
        new Error("batch failed"),
      );
      renderNotesWorkspace();
      const title = await findTitleInput("Alpha");
      title.focus();
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });
      expect(selectedOutlineIds()).toEqual(["a", "b"]);

      fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

      await waitFor(() =>
        expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce(),
      );
      expect(await screen.findByText(/couldn't be completed/i)).toBeVisible();
      expect(selectedOutlineIds()).toEqual(["a", "b"]);
      expect(title).toHaveFocus();
      expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    });
  });

  it("saves a dirty draft before Tab move and focuses after the move response", async () => {
    const before = [
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({ id: "first", parentId: "project", sortKey: 1, title: "First" }),
      node({ id: "leaf", parentId: "first", sortKey: 1, title: "Leaf" }),
      node({ id: "second", parentId: "project", sortKey: 2, title: "Second" }),
    ];
    configureRepository(before);
    const save = deferred<NotesWorkspace>();
    const move = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    notesStoreMock.updateNode.mockImplementation(() => {
      invocations.push("update");
      return save.promise;
    });
    notesStoreMock.moveNode.mockImplementation(() => {
      invocations.push("move");
      return move.promise;
    });
    renderNotesWorkspace();
    const title = await findTitleInput("Second");
    fireEvent.change(title, { target: { value: "Second edited" } });
    title.focus();

    expect(fireEvent.keyDown(title, { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(title, { key: "Tab" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "All notes" }).focus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();

    const saved = before.map((current) =>
      current.id === "second"
        ? { ...current, title: "Second edited" }
        : current,
    );
    await act(async () => save.resolve(workspace(saved)));
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(invocations).toEqual(["update", "move"]);
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "second",
        parentId: "first",
        afterId: "leaf",
      },
      historyContextMatcher(),
    );
    expect(screen.getByRole("button", { name: "All notes" })).toHaveFocus();

    await act(async () =>
      move.resolve(
        workspace(
          saved.map((current) =>
            current.id === "second"
              ? { ...current, parentId: "first", sortKey: 2 }
              : current,
          ),
        ),
      ),
    );
    expect(await findTitleInput("Second edited")).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.moveNode).toHaveBeenCalledOnce();
  });

  it("keeps Notes library visually stable during a pending Tab move", async () => {
    const before = [
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({ id: "first", parentId: "project", sortKey: 1, title: "First" }),
      node({ id: "second", parentId: "project", sortKey: 2, title: "Second" }),
    ];
    const move = deferred<NotesWorkspace>();
    configureRepository(before);
    notesStoreMock.moveNode.mockReturnValue(move.promise);
    renderNotesWorkspace();
    const second = await findTitleInput("Second");

    expect(fireEvent.keyDown(second, { key: "Tab" })).toBe(false);
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());

    const library = screen.getByRole("region", { name: "Notes library" });
    expect(library).toHaveAttribute("data-transient-workspace-busy", "true");
    expect(
      within(library).getByRole("button", { name: "New page" }),
    ).toBeDisabled();
    expect(
      within(library).getByRole("button", { name: "Project" }),
    ).toBeDisabled();
    expect(
      within(library).getByRole("button", { name: "Page actions for Project" }),
    ).toBeDisabled();

    await act(async () =>
      move.resolve(
        workspace(
          before.map((current) =>
            current.id === "second"
              ? { ...current, parentId: "first", sortKey: 1 }
              : current,
          ),
        ),
      ),
    );

    await waitFor(() =>
      expect(library).not.toHaveAttribute("data-transient-workspace-busy"),
    );
    expect(getTitleInput("Second").closest("li")).toHaveAttribute(
      "aria-level",
      "3",
    );
    expect(
      within(library).getByRole("button", { name: "New page" }),
    ).toBeEnabled();
    expect(
      within(library).getByRole("button", { name: "Project" }),
    ).toBeEnabled();
    expect(
      within(library).getByRole("button", { name: "Page actions for Project" }),
    ).toBeEnabled();
  });

  it.each([
    ["Tab", false],
    ["Shift+Tab", true],
  ])(
    "keeps title focus at a structural %s boundary",
    async (_label, shiftKey) => {
      configureRepository([
        node({ id: "first", sortKey: 1, title: "First" }),
        node({ id: "second", sortKey: 2, title: "Second" }),
      ]);
      renderNotesWorkspace();
      const title = await findTitleInput("First");
      act(() => title.focus());

      expect(fireEvent.keyDown(title, { key: "Tab", shiftKey })).toBe(false);
      expect(title).toHaveFocus();
      expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    },
  );

  it("expands a collapsed previous sibling before indenting and focusing", async () => {
    const before = [
      node({ id: "first", sortKey: 1, title: "First", isCollapsed: true }),
      node({ id: "hidden", parentId: "first", sortKey: 1, title: "Hidden" }),
      node({ id: "second", sortKey: 2, title: "Second" }),
    ];
    configureRepository(before);
    const expand = deferred<NotesWorkspace>();
    const move = deferred<NotesWorkspace>();
    notesStoreMock.toggleCollapsed.mockReturnValue(expand.promise);
    notesStoreMock.moveNode.mockReturnValue(move.promise);
    renderNotesWorkspace();
    const second = await findTitleInput("Second");
    second.focus();

    expect(fireEvent.keyDown(second, { key: "Tab" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledWith(
        "/vault",
        "first",
        historyContextMatcher(),
      ),
    );
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();

    const expanded = before.map((current) =>
      current.id === "first" ? { ...current, isCollapsed: false } : current,
    );
    await act(async () => expand.resolve(workspace(expanded)));
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "second",
        parentId: "first",
        afterId: "hidden",
      },
      historyContextMatcher(),
    );

    await act(async () =>
      move.resolve(
        workspace(
          expanded.map((current) =>
            current.id === "second"
              ? { ...current, parentId: "first", sortKey: 2 }
              : current,
          ),
        ),
      ),
    );
    expect(await findTitleInput("Second")).toHaveFocus();
  });

  it("saves before Shift+Tab outdent and does not duplicate the handled blur", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Milestone");
    fireEvent.change(title, { target: { value: "Milestone edited" } });
    title.focus();

    expect(fireEvent.keyDown(title, { key: "Tab", shiftKey: true })).toBe(
      false,
    );
    await waitFor(() => expect(notesStoreMock.moveNode).toHaveBeenCalledOnce());
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "milestone",
        title: "Milestone edited",
        note: "",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.moveNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "milestone",
        parentId: "project",
        afterId: "plan",
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.updateNode.mock.invocationCallOrder[0]).toBeLessThan(
      notesStoreMock.moveNode.mock.invocationCallOrder[0],
    );

    fireEvent.blur(title);
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("flushes the pending debounce before a structural move without a timer duplicate", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Milestone");
    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: "Milestone queued" } });
    title.focus();

    expect(fireEvent.keyDown(title, { key: "Tab", shiftKey: true })).toBe(
      false,
    );
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.moveNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.updateNode.mock.invocationCallOrder[0]).toBeLessThan(
      notesStoreMock.moveNode.mock.invocationCallOrder[0],
    );
  });

  it("saves before moving focus through visible rows without a native focus command", async () => {
    const save = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValue(save.promise);
    renderNotesWorkspace();
    const plan = await findTitleInput("Plan");
    fireEvent.change(plan, { target: { value: "Plan edited" } });
    plan.focus();

    expect(fireEvent.keyDown(plan, { key: "ArrowDown" })).toBe(false);
    expect(await findTitleInput("Milestone")).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();

    await act(async () =>
      save.resolve(
        workspace(
          initialNodes().map((current) =>
            current.id === "plan"
              ? { ...current, title: "Plan edited" }
              : current,
          ),
        ),
      ),
    );
    const milestone = getTitleInput("Milestone");
    milestone.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(milestone, { key: "ArrowUp" })).toBe(false);
    expect(await findTitleInput("Plan edited")).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  });

  it("saves the zoomed page title before moving focus to its first child", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");
    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    const pageTitle = await activatePageTitle();
    fireEvent.focus(pageTitle);
    fireEvent.change(pageTitle, { target: { value: "Project edited" } });
    const plan = queryTitleInput("Plan");
    expect(plan).not.toBeNull();
    if (plan === null) {
      throw new Error("Expected Plan title input to be rendered");
    }
    const planFocus = vi.fn();
    plan.addEventListener("focus", planFocus, { once: true });

    expect(fireEvent.keyDown(pageTitle, { key: "ArrowDown" })).toBe(false);
    await waitFor(() => expect(queryTitleInput("Plan")).toHaveFocus());
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "project",
        title: "Project edited",
        note: "Project note",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(planFocus).toHaveBeenCalledOnce();
    expect(notesStoreMock.updateNode.mock.invocationCallOrder[0]).toBeLessThan(
      planFocus.mock.invocationCallOrder[0],
    );
  });

  it("skips hidden completed children from the zoomed page title", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({
        id: "completed",
        parentId: "project",
        sortKey: 1,
        title: "Completed child",
        completedAt: "2026-07-10T01:00:00Z",
      }),
      node({
        id: "visible",
        parentId: "project",
        sortKey: 2,
        title: "Visible child",
      }),
    ]);
    renderNotesWorkspace();
    await findTitleInput("Project");
    await user.click(screen.getByRole("button", { name: "Completed items" }));
    expect(queryTitleInput("Completed child")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    expect(queryTitleInput("Completed child")).not.toBeInTheDocument();
    const pageTitle = await activatePageTitle();

    expect(fireEvent.keyDown(pageTitle, { key: "ArrowDown" })).toBe(false);
    await waitFor(() => expect(queryTitleInput("Visible child")).toHaveFocus());
  });

  it("treats a stored-collapsed zoomed page title as effectively expanded", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({
        id: "project",
        sortKey: 1,
        title: "Project",
        isCollapsed: true,
      }),
      node({ id: "plan", parentId: "project", sortKey: 1, title: "Plan" }),
    ]);
    renderNotesWorkspace();
    await findTitleInput("Project");
    await user.click(screen.getByRole("button", { name: "Zoom into Project" }));
    await waitFor(() => expect(queryTitleInput("Plan")).toBeInTheDocument());
    const pageTitle = await activatePageTitle();
    pageTitle.setSelectionRange(pageTitle.value.length, pageTitle.value.length);

    expect(fireEvent.keyDown(pageTitle, { key: "ArrowRight" })).toBe(false);
    await waitFor(() => expect(queryTitleInput("Plan")).toHaveFocus());
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();
  });

  it("moves Left from a bullet start to the previous visible title end", async () => {
    configureRepository([
      node({ id: "first", sortKey: 1, title: "First bullet" }),
      node({ id: "second", sortKey: 2, title: "Second bullet" }),
    ]);
    renderNotesWorkspace();
    const first = await findTitleInput("First bullet");
    const second = await findTitleInput("Second bullet");
    second.focus();
    second.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(second, { key: "ArrowLeft" })).toBe(false);
    await waitFor(() => expect(first).toHaveFocus());
    expect(first.selectionStart).toBe(first.value.length);
    expect(first.selectionEnd).toBe(first.value.length);
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();
  });

  it("moves Right from a bullet end to the next visible title start", async () => {
    configureRepository([
      node({ id: "first", sortKey: 1, title: "First bullet" }),
      node({ id: "second", sortKey: 2, title: "Second bullet" }),
    ]);
    renderNotesWorkspace();
    const first = await findTitleInput("First bullet");
    const second = await findTitleInput("Second bullet");
    first.focus();
    first.setSelectionRange(first.value.length, first.value.length);

    expect(fireEvent.keyDown(first, { key: "ArrowRight" })).toBe(false);
    await waitFor(() => expect(second).toHaveFocus());
    expect(second.selectionStart).toBe(0);
    expect(second.selectionEnd).toBe(0);
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();
  });

  it("keeps horizontal caret movement native away from cross-bullet boundaries", async () => {
    renderNotesWorkspace();
    const project = await findTitleInput("Project");
    project.focus();
    project.setSelectionRange(1, 1);
    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(true);
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();

    project.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(project, { key: "ArrowLeft" })).toBe(true);
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();

    project.setSelectionRange(project.value.length, project.value.length);
    expect(fireEvent.keyDown(project, { key: "ArrowRight" })).toBe(false);
    const plan = await findTitleInput("Plan");
    expect(plan).toHaveFocus();
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();
  });

  it("serializes rapid non-repeat collapse commands until the first settles", async () => {
    const before = [
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({ id: "plan", parentId: "project", sortKey: 1, title: "Plan" }),
    ];
    configureRepository(before);
    const collapse = deferred<NotesWorkspace>();
    notesStoreMock.toggleCollapsed.mockReturnValue(collapse.promise);
    renderNotesWorkspace();
    await findTitleInput("Project");
    const collapseButton = screen.getByRole("button", {
      name: "Collapse Project",
    });

    fireEvent.click(collapseButton);
    fireEvent.click(collapseButton);
    await waitFor(() =>
      expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce(),
    );

    await act(async () =>
      collapse.resolve(
        workspace(
          before.map((current) =>
            current.id === "project"
              ? { ...current, isCollapsed: true }
              : current,
          ),
        ),
      ),
    );
    await waitFor(() =>
      expect(queryTitleInput("Plan")).not.toBeInTheDocument(),
    );
    expect(notesStoreMock.toggleCollapsed).toHaveBeenCalledOnce();
  });

  it("persists an empty draft before removal and focuses only after success", async () => {
    const before = [
      node({ id: "first", sortKey: 1, title: "First" }),
      node({ id: "empty", sortKey: 2, title: "", note: "" }),
      node({ id: "last", sortKey: 3, title: "Last" }),
    ];
    configureRepository(before);
    const save = deferred<NotesWorkspace>();
    const remove = deferred<NotesWorkspace>();
    notesStoreMock.updateNode.mockReturnValue(save.promise);
    notesStoreMock.removeEmptyNode.mockReturnValue(remove.promise);
    renderNotesWorkspace();
    const empty = await findTitleInput("");
    empty.focus();
    empty.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledOnce(),
    );
    expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "empty",
        title: "",
        note: "",
        imageOffsetUtf16: 0,
        markerKind: "bullet",
      },
      historyContextMatcher(),
    );
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "All notes" }).focus();

    await act(async () => save.resolve(workspace(before)));
    await waitFor(() =>
      expect(notesStoreMock.removeEmptyNode).toHaveBeenCalledWith(
        "/vault",
        "empty",
        historyContextMatcher(),
      ),
    );
    expect(screen.getByRole("button", { name: "All notes" })).toHaveFocus();

    await act(async () =>
      remove.resolve(
        workspace(before.filter((current) => current.id !== "empty")),
      ),
    );
    expect(await findTitleInput("First")).toHaveFocus();
    expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
    expect(notesStoreMock.removeEmptyNode).toHaveBeenCalledOnce();
  });

  it("focuses the first lifted child after removing a collapsed empty parent", async () => {
    const before = [
      node({ id: "empty", sortKey: 1, title: "", isCollapsed: true }),
      node({
        id: "lifted-a",
        parentId: "empty",
        sortKey: 1,
        title: "Lifted A",
      }),
      node({
        id: "lifted-b",
        parentId: "empty",
        sortKey: 2,
        title: "Lifted B",
      }),
      node({ id: "next", sortKey: 2, title: "Next" }),
    ];
    configureRepository(before);
    const remove = deferred<NotesWorkspace>();
    notesStoreMock.removeEmptyNode.mockReturnValue(remove.promise);
    renderNotesWorkspace();
    const empty = await findTitleInput("");
    empty.focus();
    empty.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.removeEmptyNode).toHaveBeenCalledWith(
        "/vault",
        "empty",
        historyContextMatcher(),
      ),
    );

    await act(async () =>
      remove.resolve(
        workspace([
          node({ id: "lifted-a", sortKey: 1, title: "Lifted A" }),
          node({ id: "lifted-b", sortKey: 2, title: "Lifted B" }),
          node({ id: "next", sortKey: 3, title: "Next" }),
        ]),
      ),
    );
    expect(await findTitleInput("Lifted A")).toHaveFocus();
  });

  it("moves a note-only bullet subtree to Trash through the shared delete command", async () => {
    configureRepository([
      node({ id: "page", title: "Page" }),
      node({
        id: "note-only",
        parentId: "page",
        title: "",
        note: "supporting context",
      }),
      node({ id: "child", parentId: "note-only", title: "Child" }),
    ]);
    renderNotesWorkspace();
    const title = await findTitleInput("");
    title.focus();
    title.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(false);
    await waitFor(() =>
      expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
        "/vault",
        { nodeIds: ["note-only"] },
        historyContextMatcher(),
      ),
    );
    expect(
      screen.queryByRole("alertdialog", { name: "Move bullet to Trash?" }),
    ).toBeNull();
  });

  it("opens the shared readonly confirmation directly from a row Trash shortcut", async () => {
    const rootId = "11111111-1111-4111-8111-111111111111";
    const emptyId = "22222222-2222-4222-8222-222222222222";
    const readonlyId = "33333333-3333-4333-8333-333333333333";
    configureRepository([
      node({ id: rootId, title: "Page" }),
      node({
        id: emptyId,
        parentId: rootId,
        title: "",
        note: "Supporting context",
      }),
      node({
        id: readonlyId,
        parentId: emptyId,
        title: "Protected",
        isReadonly: true,
      }),
    ]);
    const deleteNodes = enableReadonlyDeletePreflight([readonlyId]);
    renderNotesWorkspace();
    const empty = await findTitleInput("");
    empty.focus();
    empty.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(empty, { key: "Backspace" })).toBe(false);
    expect(
      screen.queryByRole("alertdialog", { name: "Move bullet to Trash?" }),
    ).toBeNull();
    expect(
      await screen.findByRole("alertdialog", {
        name: "읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?",
      }),
    ).toBeVisible();
    expect(deleteNodes).toHaveBeenCalledWith(
      "/vault",
      { nodeIds: [emptyId] },
      historyContextMatcher(),
    );
  });

  it("opens the shared readonly confirmation directly from a page Trash shortcut", async () => {
    const user = userEvent.setup();
    const rootId = "44444444-4444-4444-8444-444444444444";
    const readonlyId = "55555555-5555-4555-8555-555555555555";
    configureRepository([
      node({ id: rootId, title: "", note: "Page context" }),
      node({
        id: readonlyId,
        parentId: rootId,
        title: "Protected",
        isReadonly: true,
      }),
    ]);
    const deleteNodes = enableReadonlyDeletePreflight([readonlyId]);
    renderNotesWorkspace();
    const library = screen.getByLabelText("Notes library");
    await user.click(
      await within(library).findByRole("button", { name: "Untitled page" }),
    );
    const title = (await screen.findByRole("textbox", {
      name: "Edit page title",
    })) as HTMLTextAreaElement;
    title.focus();
    title.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(false);
    expect(
      screen.queryByRole("alertdialog", { name: "Move page to Trash?" }),
    ).toBeNull();
    expect(
      await screen.findByRole("alertdialog", {
        name: "읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?",
      }),
    ).toBeVisible();
    expect(deleteNodes).toHaveBeenCalledWith(
      "/vault",
      { nodeIds: [rootId] },
      historyContextMatcher(),
    );
  });

  it("opens the shared readonly confirmation directly from the library Trash action", async () => {
    const user = userEvent.setup();
    const rootId = "66666666-6666-4666-8666-666666666666";
    const readonlyId = "77777777-7777-4777-8777-777777777777";
    configureRepository([
      node({ id: rootId, title: "Page" }),
      node({
        id: readonlyId,
        parentId: rootId,
        title: "Protected",
        isReadonly: true,
      }),
    ]);
    const deleteNodes = enableReadonlyDeletePreflight([readonlyId]);
    renderNotesWorkspace();
    const library = screen.getByLabelText("Notes library");
    await user.click(
      await within(library).findByRole("button", {
        name: "Page actions for Page",
      }),
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Move to Trash",
      }),
    );

    expect(
      screen.queryByRole("alertdialog", { name: "Move page to Trash?" }),
    ).toBeNull();
    expect(
      await screen.findByRole("alertdialog", {
        name: "읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?",
      }),
    ).toBeVisible();
    expect(deleteNodes).toHaveBeenCalledWith(
      "/vault",
      { nodeIds: [rootId] },
      historyContextMatcher(),
    );
  });

  it("does not put a generic confirmation before readonly confirmation when Starred hides the descendant", async () => {
    const user = userEvent.setup();
    const root = node({
      id: "88888888-8888-4888-8888-888888888888",
      title: "Starred page",
      isStarred: true,
    });
    const readonly = node({
      id: "99999999-9999-4999-8999-999999999999",
      parentId: root.id,
      title: "Hidden protected child",
      isReadonly: true,
    });
    configureRepository([root, readonly]);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "starred" ? [root] : [root, readonly]),
    );
    const deleteNodes = enableReadonlyDeletePreflight([readonly.id]);
    renderNotesWorkspace();
    const library = screen.getByLabelText("Notes library");
    await user.click(within(library).getByRole("button", { name: "Starred" }));
    await user.click(
      await within(library).findByRole("button", {
        name: "Page actions for Starred page",
      }),
    );
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Move to Trash",
      }),
    );

    expect(
      screen.queryByRole("alertdialog", { name: "Move page to Trash?" }),
    ).toBeNull();
    expect(
      await screen.findByRole("alertdialog", {
        name: "읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?",
      }),
    ).toBeVisible();
    expect(deleteNodes).toHaveBeenCalledWith(
      "/vault",
      { nodeIds: [root.id] },
      historyContextMatcher(),
    );
  });

  it("does not intercept composing, Process, or supporting-note keys", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    title.focus();
    title.setSelectionRange(0, 0);

    expect(fireEvent.keyDown(title, { key: "Enter", isComposing: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(title, { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(title, { key: "Process" })).toBe(true);
    const note = getTextareaByName("Supporting note: Project");
    expect(fireEvent.keyDown(note, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Backspace" })).toBe(true);

    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
    expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
    expect(notesStoreMock.removeEmptyNode).not.toHaveBeenCalled();
  });

  it("starts row notes at one line and exits from selection boundaries during composition", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");
    expect(note).toHaveAttribute("rows", "1");

    note.focus();
    note.setSelectionRange(0, 3);
    expect(fireEvent.keyDown(note, { key: "ArrowUp", isComposing: true })).toBe(
      true,
    );
    expect(note).toHaveFocus();

    fireEvent.focus(note);
    fireEvent.change(note, { target: { value: "Project note revised" } });
    note.setSelectionRange(note.value.length, note.value.length);
    expect(fireEvent.keyDown(note, { key: "ArrowDown" })).toBe(false);
    await waitFor(() => expect(queryTitleInput("Plan")).toHaveFocus());
    await waitFor(() =>
      expect(notesStoreMock.updateNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "project",
          title: "Project",
          note: "Project note revised",
          imageOffsetUtf16: 0,
          markerKind: "bullet",
        },
        historyContextMatcher(),
      ),
    );
  });

  it("keeps modified supporting-note arrows native", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");
    note.focus();
    note.setSelectionRange(note.value.length, note.value.length);

    expect(note).toHaveFocus();
    expect(fireEvent.keyDown(note, { key: "ArrowDown", ctrlKey: true })).toBe(
      true,
    );
    expect(note).toHaveFocus();
  });

  it("moves supporting-note Shift+Enter to the next visible bullet", async () => {
    renderNotesWorkspace();
    await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");
    fireEvent.change(note, { target: { value: "Project note revised" } });

    expect(fireEvent.keyDown(note, { key: "Enter", shiftKey: true })).toBe(
      false,
    );
    await waitFor(() => expect(queryTitleInput("Plan")).toHaveFocus());
    expect(notesStoreMock.createNode).not.toHaveBeenCalled();
  });

  it("creates and focuses a sibling from Shift+Enter in the last bullet note", async () => {
    configureRepository(
      initialNodes().map((current) =>
        current.id === "outside" ? { ...current, note: "Last note" } : current,
      ),
    );
    const eventTrace: string[] = [];
    const updateNode = notesStoreMock.updateNode.getMockImplementation();
    const createNode = notesStoreMock.createNode.getMockImplementation();
    if (!updateNode || !createNode) {
      throw new Error("Expected default Notes repository mutations");
    }
    notesStoreMock.updateNode.mockImplementation((...args) => {
      eventTrace.push("updateNode");
      return updateNode(...args);
    });
    notesStoreMock.createNode.mockImplementation((...args) => {
      eventTrace.push("createNode");
      return createNode(...args);
    });
    renderNotesWorkspace();
    const note = await findTextareaByName("Supporting note: Outside branch");
    fireEvent.change(note, { target: { value: "Last note revised" } });

    expect(fireEvent.keyDown(note, { key: "Enter", shiftKey: true })).toBe(
      false,
    );
    await waitFor(() => expect(queryTitleInput("")).toHaveFocus());
    expect(notesStoreMock.createNode).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({
        parentId: null,
        afterId: "outside",
        title: "",
        note: "",
      }),
      historyContextMatcher(),
    );
    expect(eventTrace).toEqual(["updateNode", "createNode"]);
  });

  it("opens and focuses an empty row note with Shift+Enter", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Outside branch");

    expect(fireEvent.keyDown(title, { key: "Enter", shiftKey: true })).toBe(
      false,
    );
    expect(getTextareaByName("Supporting note: Outside branch")).toHaveFocus();
    expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "Win32", modifier: { ctrlKey: true }, label: "Ctrl" },
    { platform: "MacIntel", modifier: { metaKey: true }, label: "Cmd" },
  ])(
    "toggles completion with $label+Enter on $platform",
    async ({ platform, modifier }) => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
      renderNotesWorkspace();
      const title = await findTitleInput("Outside branch");

      expect(fireEvent.keyDown(title, { key: "Enter", ...modifier })).toBe(
        false,
      );
      await waitFor(() =>
        expect(notesStoreMock.toggleComplete).toHaveBeenCalledWith(
          "/vault",
          "outside",
          historyContextMatcher(),
        ),
      );
    },
  );

  it.each([
    {
      platform: "Win32",
      modifier: { altKey: true },
      label: "Alt",
    },
    {
      platform: "MacIntel",
      modifier: { metaKey: true },
      label: "Cmd",
    },
  ])(
    "duplicates with $label+Shift+D on $platform",
    async ({ platform, modifier }) => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
      renderNotesWorkspace();
      const title = await findTitleInput("Outside branch");

      expect(
        fireEvent.keyDown(title, { key: "D", shiftKey: true, ...modifier }),
      ).toBe(false);
      await waitFor(() =>
        expect(notesStoreMock.duplicateNode).toHaveBeenCalledWith(
          "/vault",
          "outside",
          historyContextMatcher(),
        ),
      );
    },
  );

  it.each([
    { platform: "Win32", modifier: { ctrlKey: true }, label: "Ctrl" },
    { platform: "MacIntel", modifier: { metaKey: true }, label: "Cmd" },
  ])(
    "deletes with $label+Shift+Backspace on $platform",
    async ({ platform, modifier }) => {
      vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
      renderNotesWorkspace();
      const title = await findTitleInput("Outside branch");

      expect(
        fireEvent.keyDown(title, {
          key: "Backspace",
          shiftKey: true,
          ...modifier,
        }),
      ).toBe(false);
      await waitFor(() =>
        expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
          "/vault",
          { nodeIds: ["outside"] },
          historyContextMatcher(),
        ),
      );
    },
  );

  it("ignores composing, repeated, and textarea Workflowy shortcuts", async () => {
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    const note = getTextareaByName("Supporting note: Project");

    expect(
      fireEvent.keyDown(title, {
        key: "Enter",
        ctrlKey: true,
        isComposing: true,
      }),
    ).toBe(true);
    expect(
      fireEvent.keyDown(title, {
        key: "D",
        altKey: true,
        shiftKey: true,
        repeat: true,
      }),
    ).toBe(true);
    expect(
      fireEvent.keyDown(note, {
        key: "Backspace",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);

    expect(notesStoreMock.toggleComplete).not.toHaveBeenCalled();
    expect(notesStoreMock.duplicateNode).not.toHaveBeenCalled();
    expect(notesStoreMock.deleteNodes).not.toHaveBeenCalled();
  });

  it("exposes duplicate and delete through the bullet menu", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    const duplicateMenu = await openNodeMenu("Outside branch", user);
    await user.click(
      within(duplicateMenu).getByRole("menuitem", { name: "Duplicate" }),
    );
    expect(notesStoreMock.duplicateNode).toHaveBeenCalledWith(
      "/vault",
      "outside",
      historyContextMatcher(),
    );

    const deleteMenu = await openNodeMenu("Outside branch", user);
    await user.click(
      within(deleteMenu).getByRole("menuitem", { name: "Delete" }),
    );
    expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
      "/vault",
      { nodeIds: ["outside"] },
      historyContextMatcher(),
    );
  });

  it("shows counted typed tags, AND filter chips, and accessible removal across library views", async () => {
    const user = userEvent.setup();
    notesStoreMock.listTagsWithCounts.mockResolvedValue([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 2,
      },
      {
        prefix: "@",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1,
      },
    ]);
    renderNotesWorkspace();
    await findTitleInput("Project");

    const views = screen.getByRole("group", { name: "Notes library views" });
    await user.click(within(views).getByRole("button", { name: "Starred" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "starred",
      }),
    );
    await user.click(within(views).getByRole("button", { name: "Recent" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "recent",
      }),
    );
    await user.click(within(views).getByRole("button", { name: "Tags" }));
    const hashTag = await screen.findByRole("button", {
      name: "#Work, 2 notes",
    });
    const mentionTag = screen.getByRole("button", {
      name: "@Work, 1 note",
    });
    await user.click(hashTag);
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "tags",
        tags: [{ prefix: "#", normalizedTag: "work" }],
      }),
    );
    expect(hashTag).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Remove #Work filter" }),
    ).toBeVisible();

    await user.click(mentionTag);
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "tags",
        tags: [
          { prefix: "#", normalizedTag: "work" },
          { prefix: "@", normalizedTag: "work" },
        ],
      }),
    );
    expect(
      screen.getByRole("button", { name: "Remove @Work filter" }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Remove #Work filter" }),
    );
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "tags",
        tags: [{ prefix: "@", normalizedTag: "work" }],
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Remove #Work filter" }),
    ).not.toBeInTheDocument();
    await user.click(within(views).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "archive",
      }),
    );
    await user.click(within(views).getByRole("button", { name: "Trash" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "trash",
      }),
    );
    await user.click(within(views).getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(notesStoreMock.loadWorkspace).toHaveBeenCalledWith("/vault", {
        kind: "active",
      }),
    );
  });

  it("shows a zero-count active chip and removes the local result when its sole tag is saved away", async () => {
    const user = userEvent.setup();
    configureRepository([node({ id: "tagged", title: "#Work" })]);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(
          scope.kind === "tags"
            ? confirmedNodes.filter((current) =>
                current.title.includes("#Work"),
              )
            : confirmedNodes,
        ),
    );
    notesStoreMock.listTagsWithCounts.mockImplementation(async () =>
      confirmedNodes.some((current) => current.title.includes("#Work"))
        ? [
            {
              prefix: "#",
              normalizedTag: "work",
              displayTag: "Work",
              count: 1,
            },
          ]
        : [],
    );
    renderNotesWorkspace();

    await user.click(await screen.findByRole("button", { name: "Tags" }));
    await user.click(
      await screen.findByRole("button", { name: "#Work, 1 note" }),
    );
    const title = await findTitleInput("#Work");
    fireEvent.change(title, { target: { value: "No tag" } });
    fireEvent.blur(title);

    await waitFor(() => expect(notesStoreMock.updateNode).toHaveBeenCalled());
    const chips = screen.getByRole("list", { name: "Active tag filters" });
    await waitFor(() => expect(chips).toHaveTextContent("#work0"));
    expect(queryTitleInput("No tag")).toBeNull();
    expect(screen.getByText("No pages yet.")).toBeVisible();
  });

  it("keeps only the newest asynchronous search results", async () => {
    const first = deferred<KindAwareSearchResult[]>();
    const second = deferred<KindAwareSearchResult[]>();
    notesStoreMock.search.mockImplementation(
      async (_vaultRoot: string, query: string) =>
        query === "Old" ? first.promise : second.promise,
    );
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes",
    });

    fireEvent.change(search, { target: { value: "Old" } });
    fireEvent.change(search, { target: { value: "New" } });
    second.resolve([
      searchResult({
        nodeId: "new",
        title: "New result",
        parentTrail: ["Project"],
        matchedField: "title",
      }),
    ]);
    expect(
      await screen.findByRole("option", { name: /New result/ }),
    ).toBeInTheDocument();

    first.resolve([
      searchResult({
        nodeId: "old",
        title: "Old result",
        parentTrail: ["Project"],
        matchedField: "title",
      }),
    ]);
    await act(async () => first.promise);
    expect(
      screen.queryByRole("option", { name: /Old result/ }),
    ).not.toBeInTheDocument();
  });

  it("runs mixed structured queries and renders their ancestor trail", async () => {
    notesStoreMock.searchStructured.mockResolvedValue([
      searchResult({
        nodeId: "plan",
        title: "Plan",
        parentTrail: ["Project", "Roadmap"],
        matchedField: "note",
      }),
    ]);
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes",
    });

    fireEvent.change(search, {
      target: { value: "roadmap #Work -@Alice #Soon OR @Bob" },
    });

    expect(
      await screen.findByRole("option", {
        name: "Plan, in Project / Roadmap, note match",
      }),
    ).toHaveTextContent("Project / Roadmap");
    expect(notesStoreMock.searchStructured).toHaveBeenLastCalledWith("/vault", {
      text: "roadmap",
      requiredTags: [
        { prefix: "#", normalizedTag: "work", displayTag: "Work" },
      ],
      excludedTags: [
        { prefix: "@", normalizedTag: "alice", displayTag: "Alice" },
      ],
      orGroups: [
        [
          { prefix: "#", normalizedTag: "soon", displayTag: "Soon" },
          { prefix: "@", normalizedTag: "bob", displayTag: "Bob" },
        ],
      ],
    });
    expect(notesStoreMock.search).not.toHaveBeenCalled();
  });

  it("shows structured query validation errors without searching", async () => {
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes",
    });
    const invalid = Array.from(
      { length: 65 },
      (_, index) => `#tag${index}`,
    ).join(" ");

    fireEvent.change(search, { target: { value: invalid } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Structured Notes search has more than 64 unique tag alternatives.",
    );
    expect(notesStoreMock.search).not.toHaveBeenCalled();
    expect(notesStoreMock.searchStructured).not.toHaveBeenCalled();
  });

  it("hides rendered search results as soon as the query changes", async () => {
    const oldSearch = deferred<KindAwareSearchResult[]>();
    const newSearch = deferred<KindAwareSearchResult[]>();
    notesStoreMock.search.mockImplementation(
      async (_vaultRoot: string, query: string) =>
        query === "Old" ? oldSearch.promise : newSearch.promise,
    );
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes",
    });

    fireEvent.change(search, { target: { value: "Old" } });
    oldSearch.resolve([
      searchResult({
        nodeId: "project",
        title: "Old result",
        parentTrail: [],
        matchedField: "title",
      }),
    ]);
    expect(
      await screen.findByRole("option", { name: /Old result/ }),
    ).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "New" } });

    expect(
      screen.queryByRole("option", { name: /Old result/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("listbox", { name: "Search results" }),
    ).toBeNull();

    newSearch.resolve([
      searchResult({
        nodeId: "outside",
        title: "New result",
        parentTrail: [],
        matchedField: "title",
      }),
    ]);
    expect(
      await screen.findByRole("option", { name: /New result/ }),
    ).toBeInTheDocument();
  });

  it("supports complete keyboard navigation and selection in search results", async () => {
    const user = userEvent.setup();
    notesStoreMock.search.mockResolvedValue([
      searchResult({
        nodeId: "project",
        title: "Project",
        parentTrail: [],
        matchedField: "title",
      }),
      searchResult({
        nodeId: "plan",
        title: "Plan",
        parentTrail: ["Project"],
        matchedField: "title",
      }),
      searchResult({
        nodeId: "outside",
        title: "Outside branch",
        parentTrail: [],
        matchedField: "title",
      }),
    ]);
    renderNotesWorkspace();
    const search = await screen.findByRole("searchbox", {
      name: "Search notes",
    });

    await user.type(search, "result");
    let options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("tabindex", "0");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("tabindex", "-1");

    options[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveFocus();
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{End}");
    expect(options[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(options[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(options[2]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(options[0]).toHaveFocus();

    await user.keyboard("{Enter}");
    const pageTitle = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit page title",
    });
    expect(pageTitle).toHaveValue("Project");
    expect(pageTitle).toHaveFocus();

    await user.type(search, "result");
    options = await screen.findAllByRole("option");
    options[0].focus();
    await user.keyboard("{End}");
    await user.keyboard(" ");
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Edit page title",
        }),
      ).toHaveValue("Outside branch");
      expect(
        screen.getByRole("textbox", { name: "Edit page title" }),
      ).toHaveFocus();
    });
  });

  it("opens a search result in active context without persisting expansion", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "page", title: "Page", isCollapsed: true }),
      node({
        id: "section",
        parentId: "page",
        title: "Section",
        isCollapsed: true,
      }),
      node({ id: "target", parentId: "section", title: "Target" }),
    ]);
    notesStoreMock.search.mockResolvedValue([
      searchResult({
        nodeId: "target",
        title: "Target",
        parentTrail: ["Page", "Section"],
        matchedField: "title",
      }),
    ]);
    renderNotesWorkspace();

    await user.type(
      await screen.findByRole("searchbox", { name: "Search notes" }),
      "Target",
    );
    await user.click(await screen.findByRole("option", { name: /Target/ }));

    expect(screen.getByLabelText("Notes breadcrumb")).toHaveTextContent("Page");
    expect(await findTitleInput("Target")).toHaveFocus();
    expect(notesStoreMock.toggleCollapsed).not.toHaveBeenCalled();
    expect(notesStoreMock.loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "active",
    });
  });

  it("toggles a row star with state-aware bullet menu copy", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    await findTitleInput("Project");

    const menu = await openNodeMenu("Project", user);
    await user.click(within(menu).getByRole("menuitem", { name: "Star" }));

    expect(notesStoreMock.toggleStar).toHaveBeenCalledWith(
      "/vault",
      "project",
      historyContextMatcher(),
    );
    const updatedMenu = await openNodeMenu("Project", user);
    expect(
      within(updatedMenu).getByRole("menuitem", { name: "Unstar" }),
    ).toBeVisible();
  });

  it("keeps a filtered workspace scoped after a row mutation", async () => {
    const user = userEvent.setup();
    configureRepository([
      node({ id: "starred", title: "Starred page", isStarred: true }),
      node({ id: "outside", title: "Outside page" }),
    ]);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(
          scope.kind === "starred"
            ? confirmedNodes.filter((current) => current.isStarred)
            : confirmedNodes,
        ),
    );
    renderNotesWorkspace();
    await findTitleInput("Starred page");

    await user.click(screen.getByRole("button", { name: "Starred" }));
    await waitFor(() => expect(queryTitleInput("Outside page")).toBeNull());
    const menu = await openNodeMenu("Starred page", user);
    const loadsBeforeMutation = notesStoreMock.loadWorkspace.mock.calls.length;
    await user.click(within(menu).getByRole("menuitem", { name: "Complete" }));

    await waitFor(() =>
      expect(
        notesStoreMock.loadWorkspace.mock.calls
          .slice(loadsBeforeMutation)
          .some(([, scope]) => scope.kind === "starred"),
      ).toBe(true),
    );
    expect(queryTitleInput("Outside page")).toBeNull();
  });

  it("archives root pages from the library and exposes a read-only Archive workflow", async () => {
    const user = userEvent.setup();
    let activeNodes = [
      node({ id: "project", sortKey: 1, title: "Project" }),
      node({ id: "child", parentId: "project", sortKey: 1, title: "Child" }),
      node({ id: "outside", sortKey: 2, title: "Outside" }),
    ];
    let archivedNodes: NoteNode[] = [];
    let deletedNodes: NoteNode[] = [];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) => {
        if (scope.kind === "archive") {
          return workspace(archivedNodes);
        }
        if (scope.kind === "trash") {
          return workspace(deletedNodes);
        }
        return workspace(activeNodes);
      },
    );
    notesStoreMock.archiveNode.mockImplementation(
      acknowledgedDefaultMutation(async (_vault, rootId) => {
        const subtree = activeNodes.filter(
          (current) => current.id === rootId || current.parentId === rootId,
        );
        activeNodes = activeNodes.filter(
          (current) => !subtree.includes(current),
        );
        archivedNodes = subtree.map((current) => ({
          ...current,
          archivedAt: "2026-07-11T01:00:00Z",
          archiveRootId: rootId,
        }));
        return workspace(activeNodes);
      }),
    );
    notesStoreMock.deleteNodes.mockImplementation(
      acknowledgedDefaultMutation(
        async (_vault, input: { nodeIds: readonly NoteId[] }) => {
          const rootIds = new Set(input.nodeIds);
          const subtree = archivedNodes.filter(
            (current) =>
              current.archiveRootId !== null &&
              rootIds.has(current.archiveRootId),
          );
          archivedNodes = archivedNodes.filter(
            (current) =>
              current.archiveRootId === null ||
              !rootIds.has(current.archiveRootId),
          );
          deletedNodes = subtree.map((current) => ({
            ...current,
            deletedAt: "2026-07-11T02:00:00Z",
            archivedAt: null,
            archiveRootId: null,
          }));
          return workspace(activeNodes);
        },
      ),
    );
    notesStoreMock.restoreNode.mockImplementation(
      acknowledgedDefaultMutation(async () => {
        activeNodes = [
          ...activeNodes,
          ...deletedNodes.map((current) => ({
            ...current,
            deletedAt: null,
          })),
        ];
        deletedNodes = [];
        return workspace(activeNodes);
      }),
    );
    renderNotesWorkspace();
    await findTitleInput("Project");
    const library = screen.getByLabelText("Notes library");

    await user.click(within(library).getByRole("button", { name: "Project" }));
    await user.click(
      within(library).getByRole("button", { name: "Page actions for Project" }),
    );
    const pageMenu = await screen.findByRole("menu");
    await user.click(
      within(pageMenu).getByRole("menuitem", { name: "Archive" }),
    );
    await waitFor(() =>
      expect(notesStoreMock.archiveNode).toHaveBeenCalledWith(
        "/vault",
        "project",
        historyContextMatcher(),
      ),
    );
    const activeFallbackTitle = await findTextareaByName("Edit page title");
    expect(activeFallbackTitle).toHaveValue("Outside");
    await waitFor(() => expect(activeFallbackTitle).toHaveFocus());

    await user.click(within(library).getByRole("button", { name: "Archive" }));
    await user.click(
      await within(library).findByRole("button", { name: "Project" }),
    );
    expect(getTextareaByName("Edit page title")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Add child" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "New page" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More actions for Child" }),
    ).toBeNull();

    const rootActions = screen.getByRole("button", {
      name: "More actions for Project",
    });
    expect(rootActions).toBeEnabled();
    await user.click(rootActions);
    const archivedMenu = await screen.findByRole("menu");
    expect(
      within(archivedMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Unarchive", "Move to Trash"]);
    await user.click(
      within(archivedMenu).getByRole("menuitem", { name: "Move to Trash" }),
    );
    await waitFor(() =>
      expect(notesStoreMock.deleteNodes).toHaveBeenCalledWith(
        "/vault",
        { nodeIds: ["project"] },
        historyContextMatcher(),
      ),
    );
    expect(await within(library).findByText("Archive is empty.")).toBeVisible();

    await user.click(within(library).getByRole("button", { name: "Trash" }));
    await user.click(
      await within(library).findByRole("button", { name: "Project" }),
    );
    const trashTitle = getTextareaByName("Edit page title");
    expect(trashTitle).toHaveValue("Project");
    expect(trashTitle).toHaveAttribute("readonly");
    await user.click(
      screen.getByRole("button", { name: "More actions for Project" }),
    );
    const trashHeaderMenu = await screen.findByRole("menu");
    expect(
      within(trashHeaderMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Restore"]);
    await user.click(
      within(trashHeaderMenu).getByRole("menuitem", { name: "Restore" }),
    );
    await waitFor(() =>
      expect(notesStoreMock.restoreNode).toHaveBeenCalledWith(
        "/vault",
        "project",
        historyContextMatcher(),
      ),
    );
    const restoredTitle = await findTextareaByName("Edit page title");
    expect(restoredTitle).toHaveValue("Project");
    expect(restoredTitle).not.toHaveAttribute("readonly");
    await waitFor(() => expect(restoredTitle).toHaveFocus());
    expect(
      within(library).getByRole("button", { name: "All" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the next archived page title read-only after Unarchive closes its menu", async () => {
    const user = userEvent.setup();
    const activeNodes = [node({ id: "active", title: "Active" })];
    let archivedNodes = [
      node({
        id: "archived-first",
        sortKey: 1,
        title: "Archived first",
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first",
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        title: "Archived second 07/12/2026",
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second",
      }),
    ];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "archive" ? archivedNodes : activeNodes),
    );
    notesStoreMock.unarchiveNode.mockImplementation(async (_vault, rootId) => {
      archivedNodes = archivedNodes.filter((current) => current.id !== rootId);
      return workspace(activeNodes);
    });
    renderNotesWorkspace();
    const library = screen.getByLabelText("Notes library");

    await user.click(within(library).getByRole("button", { name: "Archive" }));
    await user.click(
      await within(library).findByRole("button", { name: "Archived first" }),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Archived first" }),
    );
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Unarchive" }));

    const fallbackTitle = await screen.findByRole("group", {
      name: "Page title",
    });
    expect(fallbackTitle).toHaveTextContent("Archived second 07/12/2026");
    expect(fallbackTitle).toHaveAttribute("aria-readonly", "true");
    expect(fallbackTitle).toHaveAttribute("tabindex", "-1");
    expect(fallbackTitle).not.toHaveFocus();
    expect(fallbackTitle.querySelector(".notes-date-token")).toHaveTextContent(
      "07/12/2026",
    );
    expect(
      screen.queryByRole("button", { name: "Edit date 07/12/2026" }),
    ).not.toBeInTheDocument();

    await user.click(fallbackTitle);
    fireEvent.keyDown(fallbackTitle, { key: "Enter" });

    expect(
      screen.queryByRole("textbox", { name: "Edit page title" }),
    ).not.toBeInTheDocument();
    const mountedTitle = queryTextareaByName("Edit page title");
    expect(mountedTitle).toHaveValue("Archived second 07/12/2026");
    expect(mountedTitle).toHaveAttribute("readonly");
    expect(mountedTitle).toHaveAttribute("aria-hidden", "true");
    expect(mountedTitle).toHaveAttribute("tabindex", "-1");
    expect(mountedTitle).not.toHaveFocus();
  });

  it("keeps Trash read-only while allowing restore and confirmed emptying", async () => {
    const user = userEvent.setup();
    const activeNodes = [node({ id: "project", title: "Project" })];
    let deletedNodes = [
      node({
        id: "deleted",
        title: "Deleted note",
        deletedAt: "2026-07-10T01:00:00Z",
      }),
    ];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "trash" ? deletedNodes : activeNodes),
    );
    notesStoreMock.restoreNode.mockImplementation(
      acknowledgedDefaultMutation(async () => {
        deletedNodes = [];
        return workspace(activeNodes);
      }),
    );
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Trash" }));
    expect(
      await screen.findByRole("button", {
        name: "More actions for Deleted note",
      }),
    ).toBeInTheDocument();
    expect(queryTitleInput("Deleted note")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Move Deleted note" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Star Deleted note" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Duplicate Deleted note" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete Deleted note" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "New page" })).toBeNull();

    const trashMenu = await openNodeMenu("Deleted note", user);
    expect(within(trashMenu).getAllByRole("menuitem")).toHaveLength(1);
    await user.click(
      within(trashMenu).getByRole("menuitem", { name: "Restore" }),
    );
    expect(notesStoreMock.restoreNode).toHaveBeenCalledWith(
      "/vault",
      "deleted",
      historyContextMatcher(),
    );

    deletedNodes = [
      node({
        id: "another-deleted",
        title: "Another deleted note",
        deletedAt: "2026-07-10T01:00:00Z",
      }),
    ];
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("button", {
      name: "More actions for Another deleted note",
    });
    await user.click(screen.getByRole("button", { name: "Empty trash" }));
    expect(notesStoreMock.emptyTrash).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "Empty trash?" });
    await user.click(
      within(confirm).getByRole("button", { name: "Empty trash" }),
    );
    expect(notesStoreMock.emptyTrash).toHaveBeenCalledWith("/vault", {
      sessionId: expect.any(String),
      historyEpoch: "history-epoch",
    });
  });

  it("renders a rejected Empty Trash reset in the production status bar", async () => {
    const user = userEvent.setup();
    const activeNodes = [node({ id: "active", title: "Active" })];
    const deletedNodes = [
      node({
        id: "deleted",
        title: "Deleted",
        deletedAt: "2026-07-10T01:00:00Z",
      }),
    ];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "trash" ? deletedNodes : activeNodes),
    );
    notesStoreMock.emptyTrash.mockResolvedValue({
      workspace: workspace([]),
      ...historyState({ historyEpoch: "rejected-epoch" }),
      historyReset: false,
    });
    renderNotesWorkspace();
    await findTitleInput("Active");

    await user.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("button", { name: "Empty trash" });
    await user.click(screen.getByRole("button", { name: "Empty trash" }));
    const confirm = screen.getByRole("alertdialog", { name: "Empty trash?" });
    await user.click(
      within(confirm).getByRole("button", { name: "Empty trash" }),
    );

    expect(
      await within(screen.getByLabelText("Status bar feedback")).findByRole(
        "alert",
      ),
    ).toHaveTextContent("Empty Trash did not acknowledge the history reset.");
  });

  it("does not expose deleted rows for editing while choosing a tag", async () => {
    const user = userEvent.setup();
    const activeNodes = [node({ id: "project", title: "Project" })];
    const deletedNodes = [
      node({
        id: "deleted",
        title: "Deleted note",
        deletedAt: "2026-07-10T01:00:00Z",
      }),
    ];
    configureRepository(activeNodes);
    notesStoreMock.loadWorkspace.mockImplementation(
      async (_vaultRoot: string, scope: { kind: string }) =>
        workspace(scope.kind === "trash" ? deletedNodes : activeNodes),
    );
    notesStoreMock.listTagsWithCounts.mockResolvedValue([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1,
      },
    ]);
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByRole("button", {
      name: "More actions for Deleted note",
    });
    await user.click(screen.getByRole("button", { name: "Tags" }));

    expect(
      await screen.findByRole("button", { name: "#Work, 1 note" }),
    ).toBeInTheDocument();
    expect(queryTitleInput("Deleted note")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Move Deleted note" }),
    ).toBeNull();
  });

  it("flushes drafts before deleting only the Notes database", async () => {
    const user = userEvent.setup();
    renderNotesWorkspace();
    const title = await findTitleInput("Project");
    await user.clear(title);
    await user.type(title, "Unsaved project");

    await user.click(
      screen.getByRole("button", { name: "Notes data settings" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" }),
    );
    const confirm = screen.getByRole("alertdialog", {
      name: "Delete all Notes data?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete Notes data" }),
    );

    await waitFor(() =>
      expect(notesStoreMock.deleteDatabase).toHaveBeenCalledWith("/vault"),
    );
    expect(notesStoreMock.updateNode).toHaveBeenCalled();
    expect(
      notesStoreMock.updateNode.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(notesStoreMock.deleteDatabase.mock.invocationCallOrder[0]);
    expect(queryTextareaByName("Edit node title")).toBeNull();
    expect(screen.getByText("No outline yet.")).toBeInTheDocument();
    expect(notesStoreMock.emptyTrash).not.toHaveBeenCalled();
  });

  it("disables workspace controls while Notes data deletion is pending", async () => {
    const user = userEvent.setup();
    const deletion = deferred<void>();
    notesStoreMock.deleteDatabase.mockReturnValue(deletion.promise);
    renderNotesWorkspace();
    await findTitleInput("Project");

    await user.click(
      screen.getByRole("button", { name: "Notes data settings" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" }),
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" }),
      ).getByRole("button", { name: "Delete Notes data" }),
    );
    await waitFor(() =>
      expect(notesStoreMock.deleteDatabase).toHaveBeenCalledOnce(),
    );

    expect(
      screen.getByRole("searchbox", { name: "Search notes", hidden: true }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "New page", hidden: true }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Starred", hidden: true }),
    ).toBeDisabled();
    for (const titleInput of textareasByName("Edit node title")) {
      expect(titleInput).toBeDisabled();
    }
    expect(
      screen.getByRole("button", {
        name: "More actions for Project",
        hidden: true,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Close Notes data settings" }),
    ).toBeDisabled();

    await act(async () => deletion.resolve());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Notes data" })).toBeNull(),
    );
  });

  it("renders loading, empty, and error states", async () => {
    configureRepository([]);
    notesStoreMock.loadWorkspace.mockRejectedValueOnce(
      new Error("Load failed"),
    );
    renderNotesWorkspace();

    expect(screen.getAllByText("Loading notes...")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "New page" })).toBeDisabled();
    expect(await screen.findAllByText("Load failed")).toHaveLength(2);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      within(screen.getByLabelText("Notes outline")).getByRole("alert"),
    ).toHaveTextContent("Load failed");
    expect(
      within(screen.getByLabelText("Notes library")).queryByRole("alert"),
    ).not.toBeInTheDocument();
  });

  it("keeps long titles and one compact menu trigger in stable layout hooks", async () => {
    const longTitle =
      "아주 긴 한국어 프로젝트 제목은 여러 줄로 자연스럽게 줄바꿈되어도 화살표와 글머리표와 메뉴를 덮지 않아야 합니다";
    let resizeCallback: ResizeObserverCallback | undefined;
    let titleScrollHeight = 52;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      "get",
    ).mockImplementation(() => titleScrollHeight);
    configureRepository([node({ id: "project", title: longTitle })]);
    renderNotesWorkspace();

    const title = await findTitleInput(longTitle);
    const row = title.closest<HTMLElement>(".notes-node-main");
    const menuSlot = row?.querySelector<HTMLElement>(".notes-node-menu-slot");

    expect(row).not.toBeNull();
    expect(menuSlot).not.toBeNull();
    expect(title).toBeInstanceOf(HTMLTextAreaElement);
    expect(title).toHaveAttribute("rows", "1");
    expect(title).toHaveStyle({ height: "52px" });

    titleScrollHeight = 76;
    act(() =>
      resizeCallback?.(
        [
          {
            target: title,
            contentRect: { width: 320 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
    );
    expect(title).toHaveStyle({ height: "76px" });
    expect(title.closest(".notes-node-content-line")?.parentElement).toBe(row);
    expect(menuSlot?.parentElement).toBe(row);
    expect(
      within(row!).getAllByRole("button", {
        name: `More actions for ${longTitle}`,
      }),
    ).toHaveLength(1);
    expect(within(row!).queryByRole("button", { name: /Complete/ })).toBeNull();
    expect(
      within(row!).queryByRole("button", { name: /Duplicate/ }),
    ).toBeNull();

    title.focus();
    expect(row).toContainElement(document.activeElement as HTMLElement | null);
    fireEvent.mouseEnter(row!);
    expect(menuSlot).toBeInTheDocument();
  });

  it("aligns the Notes detail maximize control with the outline toolbar", () => {
    expect(appStyles).toMatch(
      /\.app-shell\[data-active-feature="notes"\]\s+\.pane-toggle-group\[data-position="detail-end"\]\s*\{[^}]*top:\s*calc\(var\(--pane-top\) \+ var\(--content-titlebar-gap\) \+ 1px\);[^}]*height:\s*48px;/s,
    );
  });

  it("uses stable Workflowy row geometry without action overlap", () => {
    expect(notesStyles).toMatch(
      /\.notes-text-field\s*>\s*textarea\s*{[^}]*transform:\s*translateY\(var\(--notes-text-edit-offset\)\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-title-field\s*>\s*textarea\s*{[^}]*transform:\s*none;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-text-field\[data-stable-presentation="true"\]\s*>\s*textarea\s*{[^}]*transform:\s*translateY\(var\(--notes-stable-caret-offset,\s*0\)\);/s,
    );
    expect(appStyles).toMatch(
      /:root\s*{[^}]*--notes-text-edit-offset:\s*-1px;/s,
    );
    expect(appStyles).toMatch(
      /:root\[data-theme="soft-paper"\]\s*{[^}]*--notes-text-edit-offset:\s*-1px;[^}]*font-family:/s,
    );
    const customFontThemes = appStyles.matchAll(
      /:root\[data-theme="([^"]+)"\]\s*{([^}]*font-family:[^}]*)}/gs,
    );
    for (const [, theme, declarations] of customFontThemes) {
      expect(declarations, `${theme} text editing offset`).toContain(
        "--notes-text-edit-offset:",
      );
      expect(declarations, `${theme} title editing offset`).not.toContain(
        "--notes-node-title-edit-offset:",
      );
    }
    expect(appStyles).not.toContain("--notes-node-title-edit-offset:");
    expect(notesStyles).toMatch(
      /\.notes-outline\s*{[^}]*--notes-outline-indent:\s*36px;[^}]*--notes-menu-width:\s*24px;[^}]*--notes-bullet-center-offset:\s*61px;[^}]*--notes-content-offset:\s*74px;[^}]*--notes-page-child-offset:\s*24px;/s,
    );
    expect(notesStyles).not.toMatch(
      /\.notes-node\s*{[^}]*--notes-bullet-center-offset:/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node\s*{[^}]*--notes-depth:\s*0;[^}]*--notes-indent:\s*calc\(var\(--notes-depth\) \* var\(--notes-outline-indent\)\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-outline-content\s*{[^}]*width:\s*min\(100%, 700px\);[^}]*min-width:\s*0;[^}]*margin-inline:\s*auto;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-outline-content\[data-zoomed-page="true"\]\s*>\s*\.notes-outline-list,\s*\.notes-outline-content\[data-zoomed-page="true"\]\s*>\s*\.notes-child-composer\s*{[^}]*margin-inline-start:\s*var\(--notes-page-child-offset\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-outline-rows\s*{[^}]*overflow-x:\s*auto;/s,
    );
    expect(notesStyles).toMatch(/\.notes-page-header\s*{[^}]*width:\s*100%;/s);
    expect(notesStyles).toMatch(
      /\.notes-page-title-row\s*{[^}]*grid-template-columns:\s*var\(--notes-content-offset\) minmax\(0, 1fr\);[^}]*align-items:\s*start;[^}]*gap:\s*0;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-main\s*{[^}]*grid-template-columns:\s*var\(--notes-menu-width\) 20px 18px minmax\(0, 1fr\);[^}]*align-items:\s*start;[^}]*gap:\s*4px;[^}]*min-height:\s*28px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node\[data-marker-kind="todo"\]\s+\.notes-node-main\s*{[^}]*grid-template-columns:\s*var\(--notes-menu-width\) 20px 18px 22px minmax\(0, 1fr\);/s,
    );
    expect(notesStyles).not.toMatch(
      /\.notes-node\[data-marker-kind="todo"\]\s+\.notes-node-main\s*{[^}]*margin-inline-start:/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-arrow-slot\s*{[^}]*width:\s*20px;[^}]*height:\s*28px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\s*{[^}]*width:\s*18px;[^}]*height:\s*28px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-bullet-dot\s*{[^}]*width:\s*7px;[^}]*height:\s*7px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-todo-checkbox\s*{[^}]*grid-column:\s*4;[^}]*align-self:\s*start;[^}]*justify-self:\s*center;[^}]*width:\s*17px;[^}]*height:\s*17px;[^}]*margin:\s*5\.5px 0 0;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node\[data-marker-kind="todo"\]\s+\.notes-node-note-field,[\s\S]*\.notes-node\[data-marker-kind="todo"\]\s+\.notes-node-todo-progress\s*{[^}]*width:\s*calc\([^}]*var\(--notes-content-offset\) - 26px[^}]*\);[^}]*margin-inline-start:\s*calc\([^}]*var\(--notes-content-offset\) \+ 26px[^}]*\);/s,
    );
    expect(notesStyles).not.toMatch(
      /\.notes-node-bullet::before\s*{[^}]*transform:\s*translateY\(/s,
    );
    expect(notesStyles).not.toMatch(
      /\.notes-node-bullet-dot\s*{[^}]*transform:\s*translateY\(/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-title\s*{[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;[^}]*min-height:\s*28px;[^}]*padding:\s*1\.5px 0;[^}]*overflow:\s*hidden;[^}]*resize:\s*none;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*16px;[^}]*line-height:\s*25px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-title-field\s*{[^}]*--notes-stable-caret-color:\s*var\(--text-1\);[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;[^}]*font-size:\s*16px;[^}]*line-height:\s*25px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-menu-slot\s*{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;[^}]*width:\s*var\(--notes-menu-width\);[^}]*min-width:\s*var\(--notes-menu-width\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-main:has\(>\s*\.notes-node-arrow-slot:empty\)\s*>\s*\.notes-node-menu-slot\s*{[^}]*z-index:\s*1;[^}]*grid-column:\s*2;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-arrow-slot:empty\s*{[^}]*pointer-events:\s*none;/s,
    );
    expect(notesStyles).not.toContain(
      '.notes-node[data-marker-kind="todo"] .notes-node-menu-slot',
    );
    expect(notesStyles).not.toContain(
      '.notes-node[data-marker-kind="todo"] .notes-node-arrow-slot',
    );
    expect(notesStyles).toMatch(
      /\.notes-bullet-menu-trigger\s*{[^}]*width:\s*24px;[^}]*height:\s*28px;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*\.notes-node-main \.notes-bullet-menu-trigger,[\s\S]*\.notes-page-title-row \.notes-bullet-menu-trigger\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*\.notes-node-main:hover\s*>\s*\.notes-node-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-node-main:focus-within\s*>\s*\.notes-node-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-page-title-row:hover\s*>\s*\.notes-page-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-page-title-row:focus-within\s*>\s*\.notes-page-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-bullet-menu-trigger:focus-visible,[\s\S]*\.notes-bullet-menu-trigger\[data-popup-open\]\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(hover:\s*none\), \(pointer:\s*coarse\)\s*{[\s\S]*\.notes-bullet-menu-trigger,[\s\S]*\.notes-child-composer-button\s*{[^}]*opacity:\s*0\.68;[^}]*pointer-events:\s*auto;[^}]*}[\s\S]*\.notes-bullet-menu-trigger:disabled,[\s\S]*\.notes-child-composer-button:disabled\s*{[^}]*opacity:\s*0\.34;/s,
    );
    expect(notesStyles).not.toContain("--notes-actions-width: 149px");
    expect(notesStyles).not.toContain(".notes-node-actions");
    expect(notesStyles).toMatch(
      /\.notes-node-title:focus-visible\s*{[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-note-field\s*{[^}]*width:\s*calc\(100% - var\(--notes-indent\) - var\(--notes-content-offset\)\);[^}]*margin:\s*0 0 8px calc\(var\(--notes-indent\) \+ var\(--notes-content-offset\)\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-page-title-field\s*{[^}]*font-size:\s*27px;[^}]*font-weight:\s*700;[^}]*line-height:\s*34px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-page-title\s*{[^}]*min-height:\s*34px;[^}]*overflow:\s*hidden;[^}]*resize:\s*none;[^}]*font-size:\s*27px;[^}]*font-weight:\s*700;[^}]*line-height:\s*34px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-page-note\s*{[^}]*width:\s*calc\(100% - var\(--notes-content-offset\)\);[^}]*margin:\s*4px 0 0 var\(--notes-content-offset\);[^}]*resize:\s*none;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-note\s*{[^}]*width:\s*100%;[^}]*margin:\s*0;[^}]*resize:\s*none;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s,
    );
    expect(notesStyles).not.toContain(".notes-complete-checkbox");
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\]::before[^}]*{[^}]*width:\s*26px;[^}]*height:\s*26px;[^}]*background:\s*var\(--bg-hover\);/s,
    );
    expect(notesStyles).not.toMatch(
      /\.notes-node-main:(?:hover|focus-within)[^{]*{[^}]*background:/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-guides\s*{[^}]*position:\s*absolute;[^}]*grid-template-columns:\s*repeat\([^}]*var\(--notes-outline-indent\)[^}]*\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-guide\s*{[^}]*width:\s*1px;[^}]*margin-inline-start:\s*var\(--notes-bullet-center-offset\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-outline-drop-preview\s*{[^}]*position:\s*absolute;[^}]*inset-inline-start:\s*calc\([^}]*var\(--notes-drop-depth\)[^}]*var\(--notes-outline-indent\)[^}]*var\(--notes-bullet-center-offset\)[^}]*\);[^}]*height:\s*2px;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-outline\s*{[^}]*--notes-outline-indent:\s*28px;[^}]*--notes-menu-width:\s*28px;[^}]*--notes-bullet-center-offset:\s*70px;[^}]*--notes-content-offset:\s*84px;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-outline-toolbar\s*{[^}]*padding-inline:\s*8px;[\s\S]*\.notes-outline-rows\s*{[^}]*padding-inline:\s*12px;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-breadcrumb\s*{[^}]*overflow:\s*hidden;[\s\S]*\.notes-breadcrumb-button\s*{[^}]*max-width:\s*112px;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-node-main,[\s\S]*\.notes-child-composer\s*{[^}]*grid-template-columns:\s*var\(--notes-menu-width\) 28px 28px minmax\(0, 1fr\);[^}]*gap:\s*0;[\s\S]*\.notes-node-arrow-slot,[\s\S]*\.notes-collapse-button,[\s\S]*\.notes-node-bullet,[\s\S]*\.notes-bullet-menu-trigger,[\s\S]*\.notes-child-composer-button\s*{[^}]*width:\s*28px;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-node\[data-marker-kind="todo"\]\s+\.notes-node-main\s*{[^}]*grid-template-columns:\s*var\(--notes-menu-width\) 28px 28px 24px minmax\(0, 1fr\);/s,
    );
    expect(notesStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.notes-node-main:has\(>\s*\.notes-node-arrow-slot:empty\)\s*>\s*\.notes-node-menu-slot\s*{[^}]*grid-column:\s*1;/s,
    );
    expect(notesStyles).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*\.notes-node\s*{[^}]*transition:\s*none !important;/s,
    );
  });

  it("shows only the highest-priority desktop note menu trigger", () => {
    expect(notesStyles).not.toContain(
      '.notes-node[data-selected="true"] .notes-bullet-menu-trigger',
    );
    expect(notesStyles).not.toContain(
      '.notes-page-header[data-selected="true"] .notes-bullet-menu-trigger',
    );
    expect(notesStyles).toMatch(
      /\.notes-outline:has\(\.notes-bullet-menu-trigger\[data-popup-open\]\)\s+\.notes-bullet-menu-trigger:not\(\[data-popup-open\]\)\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-outline:not\(\s*:has\(\.notes-bullet-menu-trigger\[data-popup-open\]\)\s*\):has\(\s*\.notes-node-main:hover,\s*\.notes-page-title-row:hover\s*\)\s+:is\(\.notes-node-main,\s*\.notes-page-title-row\):not\(:hover\)\s+\.notes-bullet-menu-trigger\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
  });

  it("renders image drop position as a non-layout-shifting thin slot", () => {
    const dropPositionRule = notesStyles.match(
      /\.notes-image-drop-position\s*{([^}]*)}/s,
    )?.[1];

    expect(dropPositionRule).toBeDefined();
    expect(dropPositionRule).toMatch(/position:\s*absolute;/);
    expect(dropPositionRule).toMatch(/box-sizing:\s*border-box;/);
    expect(dropPositionRule).toMatch(/inset-block-end:\s*-3px;/);
    expect(dropPositionRule).toMatch(/height:\s*6px;/);
    expect(dropPositionRule).toMatch(/border:\s*1px solid var\(--accent\);/);
    expect(dropPositionRule).toMatch(/border-radius:\s*2px;/);
    expect(dropPositionRule).toMatch(/background:\s*var\(--accent-soft\);/);
  });

  it("resolves collapsed halo tokens in light and dark themes", () => {
    const style = document.createElement("style");
    style.textContent = appStyles.replace(/^@import .*;$/gm, "");
    document.head.append(style);

    document.documentElement.removeAttribute("data-theme");
    const lightStyle = getComputedStyle(document.documentElement);
    const lightHalo = lightStyle.getPropertyValue("--bg-hover").trim();
    const lightHaloStrong = lightStyle.getPropertyValue("--bg-active").trim();
    document.documentElement.dataset.theme = "dark";
    const darkStyle = getComputedStyle(document.documentElement);
    const darkHalo = darkStyle.getPropertyValue("--bg-hover").trim();
    const darkHaloStrong = darkStyle.getPropertyValue("--bg-active").trim();

    const normalizeColor = (value: string) => value.replace(/\s*\/\s*/gu, "/");
    expect(normalizeColor(lightHalo)).toBe("rgb(17 24 39/5%)");
    expect(normalizeColor(lightHaloStrong)).toBe("rgb(17 24 39/8%)");
    expect(normalizeColor(darkHalo)).toBe("rgb(255 255 255/6%)");
    expect(normalizeColor(darkHaloStrong)).toBe("rgb(255 255 255/10%)");
    expect(darkHalo).not.toBe(lightHalo);
    expect(darkHaloStrong).not.toBe(lightHaloStrong);
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\]::before[^}]*background:\s*var\(--bg-hover\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-bullet\[data-collapsed="true"\](?::hover|:focus-visible)::before[^}]*background:\s*var\(--bg-active\);/s,
    );

    style.remove();
    document.documentElement.removeAttribute("data-theme");
  });

  it("keeps a disabled non-empty child composer subdued on hover and focus", () => {
    expect(notesStyles).toMatch(
      /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*\.notes-child-composer\[data-has-children="true"\]:hover[\s\S]*\.notes-child-composer-button:disabled,[\s\S]*\.notes-child-composer:focus-within \.notes-child-composer-button:disabled,[\s\S]*\.notes-child-composer-button:disabled:focus-visible\s*{[^}]*opacity:\s*0\.34;/s,
    );
  });

  it("keeps zoomed page title and description focus free of bottom lines", () => {
    const editorRule = notesStyles.match(
      /\.notes-page-title:focus-visible,\s*\.notes-page-note:focus-visible\s*{([^}]*)}/s,
    )?.[1];
    const presentationRule = notesStyles.match(
      /\.notes-page-title-field > \.notes-token-text:focus-visible,\s*\.notes-page-note-field > \.notes-token-text:focus-visible\s*{([^}]*)}/s,
    )?.[1];

    for (const rule of [editorRule, presentationRule]) {
      expect(rule).toBeDefined();
      expect(rule).toMatch(/outline:\s*0;/);
      expect(rule).toMatch(/box-shadow:\s*none;/);
      expect(rule).not.toMatch(
        /border-bottom|text-decoration|inset\s+0\s+-\d+px/,
      );
    }
  });

  it("keeps supporting-note visuals stable and line-free across focus", () => {
    expect(notesStyles).toMatch(
      /\.notes-text-field\[data-stable-presentation="true"\]\s*>\s*textarea\s*{[^}]*transform:\s*translateY\(var\(--notes-stable-caret-offset,\s*0\)\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-page-note-field\s*{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;[^}]*--notes-stable-caret-color:\s*var\(--text-3\);[^}]*--notes-stable-caret-offset:\s*3px;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-node-note-field\s*{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;[^}]*--notes-stable-caret-color:\s*var\(--text-3\);[^}]*--notes-stable-caret-offset:\s*3px;/s,
    );
    const pageTitleRule = notesStyles.match(
      /\.notes-page-title-field\s*{([^}]*)}/s,
    )?.[1];
    expect(pageTitleRule).toBeDefined();
    expect(pageTitleRule).not.toMatch(/--notes-stable-caret-offset:\s*3px/);

    const editorRule = notesStyles.match(
      /\.notes-node-note:focus-visible\s*{([^}]*)}/s,
    )?.[1];
    const presentationRule = notesStyles.match(
      /\.notes-node-note-field > \.notes-token-text:focus-visible\s*{([^}]*)}/s,
    )?.[1];
    for (const rule of [editorRule, presentationRule]) {
      expect(rule).toBeDefined();
      expect(rule).toMatch(/outline:\s*0;/);
      expect(rule).toMatch(/box-shadow:\s*none;/);
      expect(rule).not.toMatch(
        /border-bottom|text-decoration|inset\s+0\s+-\d+px/,
      );
    }
  });

  it("uses one accessible non-underline focus rule for the resting node title", () => {
    const titlePresentationFocusRules = Array.from(
      notesStyles.matchAll(
        /\.notes-node-title-field > \.notes-token-text:focus-visible\s*{([^}]*)}/gs,
      ),
    ).map((match) => match[1] ?? "");

    expect(titlePresentationFocusRules).toHaveLength(1);
    const [titlePresentationFocusRule] = titlePresentationFocusRules;
    expect(titlePresentationFocusRule).toMatch(
      /outline:\s*2px solid var\(--accent\);/,
    );
    expect(titlePresentationFocusRule).toMatch(/outline-offset:\s*2px;/);
    expect(titlePresentationFocusRule).toMatch(/box-shadow:\s*none;/);
    expect(titlePresentationFocusRule).not.toMatch(
      /border-bottom|text-decoration|inset\s+0\s+-\d+px/,
    );
  });

  it("distinguishes row selection, atom selection, and nested-control focus without color alone", () => {
    expect(notesStyles).toMatch(
      /\.notes-node\[data-range-selected="true"\]\s*>\s*\.notes-node-main\s*\{[^}]*background:/s,
    );
    expect(notesStyles).not.toMatch(
      /\.notes-image-atom-editor\s+\[data-image-atom-region="atom"\]\[data-atom-selected="true"\]/,
    );
    expect(notesStyles).toMatch(
      /\.notes-image-node-content:focus-visible\s*\{[^}]*outline:\s*0;/s,
    );
    expect(notesStyles).not.toMatch(
      /\.notes-image-node-content:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-image-menu-trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);/s,
    );
  });

  it("suppresses the row focus ring on the focused image atom editor", () => {
    const genericNodeFocusRuleIndex = notesStyles.indexOf(
      ".notes-node :focus-visible",
    );
    const imageAtomFocusRuleIndex = notesStyles.indexOf(
      ".notes-image-atom-editor:focus-visible",
    );

    expect(genericNodeFocusRuleIndex).toBeGreaterThanOrEqual(0);
    expect(imageAtomFocusRuleIndex).toBeGreaterThan(genericNodeFocusRuleIndex);
    expect(notesStyles).toMatch(
      /\.notes-image-atom-editor:focus-visible\s*\{[^}]*outline:\s*0;/s,
    );
  });

  it("positions native blue carets at image atom boundaries", () => {
    expect(notesStyles).toMatch(/caret-color:\s*var\(--accent\)/);
    expect(notesStyles).not.toMatch(/caret-color:\s*var\(--danger\)/);
    expect(notesStyles).toMatch(/inset-inline-start:\s*-2px/);
    expect(notesStyles).toMatch(
      /inset-inline-start:\s*calc\(var\(--notes-image-atom-frame-inline-size\) \+ 2px\)/,
    );
    expect(notesStyles).not.toMatch(/notes-image-attachment-frame::before/);
    expect(notesStyles).not.toMatch(/notes-image-attachment-frame::after/);
  });

  it("keeps the editing title textarea free of a focus line", () => {
    const titleEditorFocusRules = Array.from(
      notesStyles.matchAll(/\.notes-node-title:focus-visible\s*{([^}]*)}/gs),
    ).map((match) => match[1] ?? "");

    expect(titleEditorFocusRules).toHaveLength(1);
    const [titleEditorFocusRule] = titleEditorFocusRules;
    expect(titleEditorFocusRule).toMatch(/outline:\s*0;/);
    expect(titleEditorFocusRule).toMatch(/box-shadow:\s*none;/);
    expect(titleEditorFocusRule).not.toMatch(
      /border-bottom|text-decoration|inset\s+0\s+-\d+px/,
    );
  });

  it("gives the library page menu trigger the standard visible focus ring", () => {
    expect(notesStyles).toMatch(
      /\.notes-library-page-menu-trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*-1px;/,
    );
  });

  it("keeps library controls visually stable during transient workspace work", () => {
    expect(notesStyles).toMatch(
      /\.notes-library-pane\[data-transient-workspace-busy="true"\][\s\S]*\.notes-new-page:disabled[^{]*\{[^}]*opacity:\s*1;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-library-pane\[data-transient-workspace-busy="true"\][\s\S]*\.notes-library-page:disabled[^{]*\{[^}]*opacity:\s*1;/s,
    );
    expect(notesStyles).toMatch(
      /\.notes-library-pane\[data-transient-workspace-busy="true"\][\s\S]*\.notes-library-page-menu-trigger:disabled[^{]*\{[^}]*opacity:\s*0\.68;/s,
    );
  });

  it("treats only marked image-editor controls as interactive while preserving blank atom bodies", () => {
    const surface = document.createElement("span");
    surface.dataset.notesNativeSelectionSurface = "true";
    const image = document.createElement("img");
    image.dataset.imageAtomInteractive = "true";
    const menu = document.createElement("button");
    menu.textContent = "Image actions";
    surface.append(image, menu);
    document.body.append(surface);

    expect(isOutlineSelectionTextSurface(surface)).toBe(true);
    expect(isOutlineSelectionInteractiveTarget(surface)).toBe(false);
    expect(isOutlineSelectionInteractiveTarget(image)).toBe(true);
    expect(isOutlineSelectionTextSurface(image)).toBe(false);
    expect(isOutlineSelectionInteractiveTarget(menu)).toBe(true);
    expect(isOutlineSelectionTextSurface(menu)).toBe(false);

    surface.remove();
  });
});
