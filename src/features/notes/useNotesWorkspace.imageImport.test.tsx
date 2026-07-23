import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNotesMutationResult, MAX_NOTE_ATTACHMENT_BATCH_BYTES, MAX_NOTE_ATTACHMENT_BYTES, MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS, type ImportImageNodeBytesInput, type NoteAttachment, type NoteNode, type ImageAtomMutationResult, type NotesHistoryContext, type NotesHistoryState, type NotesMutationResponse, type NotesMutationResult, type NotesStore, type NotesWorkspace, type PendingImageNodeByteItem } from "../../domain/notes";
import { resetImageImportRecoveryForTests, useNotesWorkspace, type UseNotesWorkspaceResult } from "./useNotesWorkspace";
import type { NotesAttachmentUiBoundary } from "./notesAttachmentController";
import { notesWorkspaceCoordinatorRegistry } from "./notesWorkspaceCoordinator";
import { imageAtomPostconditionDigest } from "./notesCommands";
import { type NotesHistorySession } from "./notesHistory";
import type { ImageAtomEditorSelectionAuthority, NotesImageAtomEditorAuthority } from "./notesImageAtomEditorRegistry";
import type { NotesImageAtomCutAuthority } from "./notesWorkspaceTypes";

const createNoteIdMock = vi.hoisted(() => vi.fn());
const notesHistorySpies = vi.hoisted(() => ({
  discard: vi.fn(),
  beginStructural: vi.fn(),
  rememberAfter: vi.fn(),
  acceptMutationResult: vi.fn(),
  acceptReplayResult: vi.fn(),
  sessionsById: new Map<string, unknown>(),
  historyStatesBySessionId: new Map<string, unknown>()
}));

vi.mock("../../domain/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/notes")>()),
  createNoteId: createNoteIdMock
}));

vi.mock("./notesHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notesHistory")>();
  return {
    ...actual,
    createNotesHistorySession: (
      options?: Parameters<typeof actual.createNotesHistorySession>[0]
    ) => {
      const session = actual.createNotesHistorySession(options);
      notesHistorySpies.sessionsById.set(session.sessionId, session);
      const bindInitialization = session.bindInitialization.bind(session);
      const beginStructuralEntry = session.beginStructuralEntry.bind(session);
      const acceptMutationResult = session.acceptMutationResult.bind(session);
      const acceptReplayResult = session.acceptReplayResult.bind(session);
      const reset = session.reset.bind(session);
      const discard = session.discard.bind(session);
      const rememberAfter = session.rememberAfter.bind(session);
      session.bindInitialization = (state) => {
        bindInitialization(state);
        notesHistorySpies.historyStatesBySessionId.set(session.sessionId, state);
      };
      session.beginStructuralEntry = (commandKind, before) => {
        notesHistorySpies.beginStructural(commandKind, before);
        return beginStructuralEntry(commandKind, before);
      };
      session.discard = (entryId) => {
        notesHistorySpies.discard(entryId);
        discard(entryId);
      };
      session.rememberAfter = (entryId, after) => {
        notesHistorySpies.rememberAfter(entryId, after);
        rememberAfter(entryId, after);
      };
      session.acceptMutationResult = (entryId, after, state) => {
        notesHistorySpies.acceptMutationResult(entryId, after, state);
        const acceptance = acceptMutationResult(entryId, after, state);
        if (acceptance.accepted) {
          notesHistorySpies.historyStatesBySessionId.set(session.sessionId, state);
        }
        return acceptance;
      };
      session.acceptReplayResult = (state, direction, entryId) => {
        notesHistorySpies.acceptReplayResult(state, direction, entryId);
        const accepted = acceptReplayResult(state, direction, entryId);
        if (accepted) {
          notesHistorySpies.historyStatesBySessionId.set(session.sessionId, state);
        }
        return accepted;
      };
      session.reset = (historyEpoch) => {
        reset(historyEpoch);
        notesHistorySpies.historyStatesBySessionId.set(
          session.sessionId,
          historyState(historyEpoch)
        );
      };
      return session;
    }
  };
});

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
    markdownImageWidth: overrides.markdownImageWidth ?? null
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

function historyState(historyEpoch = "epoch-a"): NotesHistoryState {
  return {
    canUndo: false,
    canRedo: false,
    historyEpoch,
    nextUndoEntryId: null,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}

function syntheticHistoryStatus(sessionId: string): NotesHistoryState {
  const session = notesHistorySpies.sessionsById.get(sessionId) as
    | NotesHistorySession
    | undefined;
  if (!session) return historyState();
  const state = notesHistorySpies.historyStatesBySessionId.get(sessionId) as
    | NotesHistoryState
    | undefined;
  return {
    ...(state ?? historyState(session.historyEpoch)),
    canUndo: session.canUndo(),
    canRedo: session.canRedo()
  };
}

function mutationResult(
  resultWorkspace: NotesWorkspace,
  context: NotesHistoryContext
): NotesMutationResult {
  return {
    workspace: resultWorkspace,
    historyEntryId: context.entryId,
    ...historyState(context.historyEpoch),
    canUndo: true,
    nextUndoEntryId: context.entryId
  };
}

async function imageAtomMutationResult(
  resultWorkspace: NotesWorkspace,
  context: NotesHistoryContext,
  nodeId: string,
  kind: "edit" | "paste" = "edit",
  postconditionDigest?: string
): Promise<ImageAtomMutationResult> {
  const digest =
    postconditionDigest ??
    (await imageAtomPostconditionDigest(resultWorkspace, [nodeId], kind));
  if (!digest) throw new Error("Test image-atom digest is unavailable.");
  return {
    ...mutationResult(resultWorkspace, context),
    operation: {
      operationId: context.entryId,
      historyEpoch: context.historyEpoch,
      postconditionDigest: digest,
      affectedRootIds: [nodeId],
      focus: { nodeId, anchorUtf16: 0, focusUtf16: 0 }
    }
  };
}

function withEpochAwareMutation<
  TArgument,
  TResult extends NotesMutationResponse
>(
  operation: (
    vaultRoot: string,
    input: TArgument,
    context: NotesHistoryContext
  ) => Promise<TResult>
): (
  vaultRoot: string,
  input: TArgument,
  context: NotesHistoryContext
) => Promise<TResult> {
  return vi.fn(async (vaultRoot, input, context): Promise<TResult> => {
    const result = await operation(vaultRoot, input, context);
    if (
      isNotesMutationResult(result) &&
      result.canUndo &&
      result.nextUndoEntryId === null &&
      result.historyEntryId === context.entryId
    ) {
      return { ...result, nextUndoEntryId: context.entryId };
    }
    return result;
  });
}

function withEpochAwareReplay(
  direction: "undo" | "redo",
  operation: NonNullable<NotesStore["undo"]>
): NonNullable<NotesStore["undo"]> {
  return vi.fn(async (vaultRoot, input) => {
    const result = await operation(vaultRoot, input);
    if (result.kind !== "applied") {
      return result;
    }
    if (
      direction === "undo" &&
      result.canRedo &&
      result.nextRedoEntryId === null
    ) {
      return { ...result, nextRedoEntryId: result.replayedEntryId };
    }
    if (
      direction === "redo" &&
      result.canUndo &&
      result.nextUndoEntryId === null
    ) {
      return { ...result, nextUndoEntryId: result.replayedEntryId };
    }
    return result;
  });
}

function attachment(
  overrides: Partial<NoteAttachment> & Pick<NoteAttachment, "id" | "nodeId">
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
    ...overrides
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

function activateImagePasteAuthority(
  current: UseNotesWorkspaceResult,
  nodeId: string
): NotesImageAtomEditorAuthority {
  const selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
  current.registerActiveImageAtomEditor?.({
    nodeId,
    flush: vi.fn().mockResolvedValue("flushed"),
    flushAndGetSelection: vi.fn().mockResolvedValue({
      anchorUtf16: 0,
      focusUtf16: 0
    }),
    flushAndGetSelectionSnapshot: vi.fn().mockResolvedValue({
      selection: { anchorUtf16: 0, focusUtf16: 0 },
      authority: selectionAuthority
    }),
    isSelectionAuthorityCurrent: (candidate) => candidate === selectionAuthority,
    claimPaste: vi.fn().mockReturnValue(false)
  });
  const editorAuthority = current.captureActiveImageAtomEditorAuthority?.(
    nodeId,
    selectionAuthority
  );
  if (!editorAuthority) throw new Error("Expected active image editor authority");
  return editorAuthority;
}

function sizedImageBlob(size: number): Blob {
  const blob = new Blob([new Uint8Array([0])], { type: "image/png" });
  Object.defineProperty(blob, "size", { value: size });
  return blob;
}

function pendingImageBatch(
  prefix: string,
  sizes: readonly number[]
): PendingImageNodeByteItem[] {
  return sizes.map((size, index) => ({
    originalName: `${prefix}-${index}.png`,
    mimeType: "image/png",
    blob: sizedImageBlob(size)
  }));
}

function mockAttachmentUi(
  openImageFiles = vi.fn().mockResolvedValue(null)
): NotesAttachmentUiBoundary {
  return {
    openImageFiles,
    saveImageFile: vi.fn().mockResolvedValue(null),
    subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
  };
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  const store: NotesStore = {
    initialize: vi.fn().mockResolvedValue(historyState()),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    splitNode: empty,
    applyImageAtomEdit: vi.fn<NotesStore["applyImageAtomEdit"]>(),
    applyImageAtomPaste: vi.fn<NotesStore["applyImageAtomPaste"]>(),
    moveNode: empty,
    applyBatch: empty,
    importSubtree: empty,
    importMarkdown: vi.fn<NotesStore["importMarkdown"]>(),
    toggleComplete: empty,
    toggleCollapsed: empty,
    toggleStar: empty,
    duplicateNode: empty,
    removeEmptyNode: empty,
    softDeleteNode: empty,
    restoreNode: empty,
    archiveNode: empty,
    unarchiveNode: empty,
    undo: vi.fn().mockResolvedValue({
      kind: "entryMissing",
      ...historyState()
    }),
    redo: vi.fn().mockResolvedValue({
      kind: "entryMissing",
      ...historyState()
    }),
    lookupImageAtomOperation: vi.fn<NotesStore["lookupImageAtomOperation"]>(
      async (_vaultPath, _sessionId, historyEpoch) => ({
        kind: "missing",
        historyEpoch
      })
    ),
    ackImageAtomOperation: vi.fn<NotesStore["ackImageAtomOperation"]>(
      async () => undefined
    ),
    clearHistory: vi.fn().mockResolvedValue({
      ...historyState(),
      historyReset: true
    }),
    historyStatus: vi
      .fn()
      .mockImplementation((_vaultRoot, sessionId) => syntheticHistoryStatus(sessionId)),
    pruneHistoryEntries: vi.fn().mockResolvedValue(historyState()),
    prepareNavigation: vi
      .fn()
      .mockImplementation((_vaultRoot, input) =>
        syntheticHistoryStatus(input.sessionId)
      ),
    closeHistorySession: vi.fn().mockResolvedValue(undefined),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi
      .fn()
      .mockResolvedValue({ attachmentCleanupFailed: false }),
    importAttachmentPaths: vi.fn().mockResolvedValue(workspace([])),
    importAttachmentBytes: vi.fn().mockResolvedValue(workspace([])),
    importImageNodePaths: vi.fn().mockResolvedValue(workspace([])),
    importImageNodeBytes: vi.fn().mockResolvedValue(workspace([])),
    ...overrides
  };
  return {
    ...store,
    createNode: withEpochAwareMutation(store.createNode),
    updateNode: withEpochAwareMutation(store.updateNode),
    splitNode: withEpochAwareMutation(store.splitNode),
    moveNode: withEpochAwareMutation(store.moveNode),
    applyBatch: withEpochAwareMutation(store.applyBatch),
    importSubtree: withEpochAwareMutation(store.importSubtree),
    importMarkdown: withEpochAwareMutation(store.importMarkdown),
    toggleComplete: withEpochAwareMutation(store.toggleComplete),
    toggleCollapsed: withEpochAwareMutation(store.toggleCollapsed),
    toggleStar: withEpochAwareMutation(store.toggleStar),
    duplicateNode: withEpochAwareMutation(store.duplicateNode),
    removeEmptyNode: withEpochAwareMutation(store.removeEmptyNode),
    softDeleteNode: withEpochAwareMutation(store.softDeleteNode),
    restoreNode: withEpochAwareMutation(store.restoreNode),
    archiveNode: withEpochAwareMutation(store.archiveNode),
    unarchiveNode: withEpochAwareMutation(store.unarchiveNode),
    undo: withEpochAwareReplay("undo", store.undo),
    redo: withEpochAwareReplay("redo", store.redo),
    importAttachment: store.importAttachment
      ? withEpochAwareMutation(store.importAttachment)
      : undefined,
    importAttachmentPaths: withEpochAwareMutation(store.importAttachmentPaths),
    importAttachmentBytes: withEpochAwareMutation(store.importAttachmentBytes),
    importImageNodePaths: store.importImageNodePaths
      ? withEpochAwareMutation(store.importImageNodePaths)
      : undefined,
    importImageNodeBytes: store.importImageNodeBytes
      ? withEpochAwareMutation(store.importImageNodeBytes)
      : undefined,
    resizeAttachment: store.resizeAttachment
      ? withEpochAwareMutation(store.resizeAttachment)
      : undefined,
    removeAttachment: store.removeAttachment
      ? withEpochAwareMutation(store.removeAttachment)
      : undefined,
    restoreAttachment: store.restoreAttachment
      ? withEpochAwareMutation(store.restoreAttachment)
      : undefined,
    expandAll: store.expandAll
      ? withEpochAwareMutation(store.expandAll)
      : undefined,
    collapseAll: store.collapseAll
      ? withEpochAwareMutation(store.collapseAll)
      : undefined,
    sortSubtreeAscending: store.sortSubtreeAscending
      ? withEpochAwareMutation(store.sortSubtreeAscending)
      : undefined,
    sortSubtreeDescending: store.sortSubtreeDescending
      ? withEpochAwareMutation(store.sortSubtreeDescending)
      : undefined
  };
}

function historyContext(commandKind: string) {
  return expect.objectContaining({
    sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    historyEpoch: "epoch-a",
    entryId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    commandKind
  });
}

describe("useNotesWorkspace", () => {
  it("opens a writable presentation session with a complete ref-backed location", async () => {
    const store = repository();
    const realOpenSession =
      notesWorkspaceCoordinatorRegistry.openSession.bind(
        notesWorkspaceCoordinatorRegistry
      );
    let openedOptions: Parameters<
      typeof notesWorkspaceCoordinatorRegistry.openSession
    >[0] | null = null;
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        openedOptions = options;
        return realOpenSession(options);
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/presentation-options", repository: store })
    );

    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      expect(openedOptions).toEqual(
        expect.objectContaining({
          presentation: "writable",
          captureHistoryLocation: expect.any(Function),
          applyHistoryLocation: expect.any(Function)
        })
      );
      const captured = openedOptions!.captureHistoryLocation!();
      expect(captured).toMatchObject({
        scope: { kind: "active" },
        libraryView: "all",
        activeTagFilters: [],
        expansion: { nodeIds: [] },
        tagFilterOrigin: null
      });
      expect("locallyExpandedNodeIds" in captured).toBe(false);
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  beforeEach(() => {
    createNoteIdMock.mockReset();
    notesHistorySpies.sessionsById.clear();
    notesHistorySpies.historyStatesBySessionId.clear();
    notesHistorySpies.discard.mockClear();
    notesHistorySpies.rememberAfter.mockClear();
    notesHistorySpies.acceptMutationResult.mockClear();
    notesHistorySpies.acceptReplayResult.mockClear();
  });

  it.each(["draft", "attachment", "scope", "vault ABA"])(
    "invalidates opaque image-paste authority across %s changes",
    async (change) => {
      const imageNodeId = "99100000-0000-4000-8000-000000000001";
      const attachmentId = "99100000-0000-4000-8000-000000000002";
      const imageNode = node({
        id: imageNodeId,
        nodeKind: "image",
        title: "beforeafter",
        note: "support",
        imageOffsetUtf16: 6
      });
      const imageAttachment = attachment({
        id: attachmentId,
        nodeId: imageNodeId
      });
      const initial: NotesWorkspace = {
        nodes: [imageNode],
        attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
      };
      const resized: NotesWorkspace = {
        nodes: [imageNode],
        attachmentsByNodeId: {
          [imageNodeId]: [
            { ...imageAttachment, displayWidth: 480, updatedAt: "2026-07-13T00:00:00Z" }
          ]
        }
      };
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        resizeAttachment: vi.fn(async (_vaultRoot, _input, context) =>
          mutationResult(resized, context)
        )
      });
      const rendered = renderHook(
        ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
        { initialProps: { vaultRoot: "/authority-a" } }
      );
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      const selectionAuthority = activateImagePasteAuthority(
        rendered.result.current,
        imageNodeId
      );

      const authority =
        rendered.result.current.captureImageAtomPasteAuthority?.(
          imageNodeId,
          selectionAuthority
        );
      expect(authority).not.toBeNull();
      expect(
        rendered.result.current.isImageAtomPasteAuthorityCurrent?.(authority!)
      ).toBe(true);

      if (change === "draft") {
        act(() => {
          rendered.result.current.actions.updateNodeDraft(
            imageNodeId,
            { title: "changed", note: "support", imageOffsetUtf16: 6 },
            "title"
          );
          rendered.result.current.actions.updateNodeDraft(
            imageNodeId,
            { title: "beforeafter", note: "support", imageOffsetUtf16: 6 },
            "title"
          );
        });
      } else if (change === "attachment") {
        await act(async () => {
          await rendered.result.current.actions.resizeImage!(attachmentId, 480);
        });
      } else if (change === "scope") {
        await act(async () => {
          await rendered.result.current.actions.selectLibraryView("starred");
          await rendered.result.current.actions.selectLibraryView("all");
        });
      } else {
        rendered.rerender({ vaultRoot: "/authority-b" });
        await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
        rendered.rerender({ vaultRoot: "/authority-a" });
        await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      }

      expect(
        rendered.result.current.isImageAtomPasteAuthorityCurrent?.(authority!)
      ).toBe(false);
      rendered.unmount();
    }
  );

  it("persists a pending image draft before capturing paste authority and committing", async () => {
    const imageNodeId = "99105000-0000-4000-8000-000000000001";
    const attachmentId = "99105000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce("99105000-0000-4000-8000-000000000003")
      .mockReturnValueOnce("99105000-0000-4000-8000-000000000004");
    const imageAttachment = attachment({ id: attachmentId, nodeId: imageNodeId });
    const initialNode = node({
      id: imageNodeId,
      nodeKind: "image",
      title: "beforeafter",
      note: "support",
      imageOffsetUtf16: 6
    });
    const persistedNode = {
      ...initialNode,
      title: "typedafter",
      imageOffsetUtf16: 5,
      updatedAt: "2026-07-13T00:00:00Z"
    };
    const initial: NotesWorkspace = {
      nodes: [initialNode],
      attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
    };
    const persisted: NotesWorkspace = {
      nodes: [persistedNode],
      attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
    };
    const order: string[] = [];
    const updateNode = vi.fn<NotesStore["updateNode"]>(
      async (_vaultRoot, _input, context) => {
        order.push("draft");
        return mutationResult(persisted, context);
      }
    );
    const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>(
      async (_vaultRoot, _input, context) => {
        order.push("paste");
        return imageAtomMutationResult(
          persisted,
          context,
          imageNodeId,
          "paste"
        );
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      applyImageAtomPaste
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/pending-image-paste", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.setImageImportMaxDisplayWidth(480);
    const selectionAuthority = activateImagePasteAuthority(
      rendered.result.current,
      imageNodeId
    );

    act(() => {
      rendered.result.current.actions.updateNodeDraft(
        imageNodeId,
        { title: "typedafter", note: "support", imageOffsetUtf16: 5 },
        "title"
      );
    });
    await waitFor(() =>
      expect(rendered.result.current.draftsByNodeId[imageNodeId]).toBeDefined()
    );
    expect(
      rendered.result.current.captureImageAtomPasteAuthority?.(
        imageNodeId,
        selectionAuthority
      )
    ).toBeNull();
    await act(async () => {
      await expect(
        rendered.result.current.actions.flushNodeDraft(imageNodeId)
      ).resolves.toBe(true);
    });
    await waitFor(() =>
      expect(rendered.result.current.draftsByNodeId[imageNodeId]).toBeUndefined()
    );
    const authority =
      rendered.result.current.captureImageAtomPasteAuthority?.(
        imageNodeId,
        selectionAuthority
      );
    expect(authority).not.toBeNull();

    await act(async () => {
      await expect(
        rendered.result.current.applyImageAtomPasteWithAuthority!(
          authority!,
          imageNodeId,
          { anchorUtf16: 5, focusUtf16: 6 },
          {
            version: 1,
            fragment: [
              {
                kind: "image",
                source: {
                  originalName: "pending.png",
                  mimeType: "image/png",
                  blob: new Blob([new Uint8Array([1])], { type: "image/png" })
                }
              }
            ]
          }
        )
      ).resolves.toBe("committed");
    });
    expect(order).toEqual(["draft", "paste"]);
    expect(updateNode).toHaveBeenCalledOnce();
    expect(applyImageAtomPaste).toHaveBeenCalledOnce();
  });

  it("refuses to seal a pre-flush image-editor lease after registration A-to-B-to-A ABA", async () => {
    const imageNodeId = "99107500-0000-4000-8000-000000000001";
    const attachmentId = "99107500-0000-4000-8000-000000000002";
    const imageAttachment = attachment({ id: attachmentId, nodeId: imageNodeId });
    const initialNode = node({
      id: imageNodeId,
      nodeKind: "image",
      title: "beforeafter",
      note: "support",
      imageOffsetUtf16: 6
    });
    const persistedNode = {
      ...initialNode,
      title: "typedafter",
      imageOffsetUtf16: 5,
      updatedAt: "2026-07-13T00:00:00Z"
    };
    const initial: NotesWorkspace = {
      nodes: [initialNode],
      attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
    };
    const persisted: NotesWorkspace = {
      nodes: [persistedNode],
      attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
    };
    const updateGate = deferred<NotesMutationResult>();
    let updateContext: NotesHistoryContext | null = null;
    const updateNode = vi.fn<NotesStore["updateNode"]>(
      async (_vaultRoot, _input, context) => {
        updateContext = context;
        return updateGate.promise;
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/pending-image-paste-aba", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    const selectionA = {} as ImageAtomEditorSelectionAuthority;
    const editorA = {
      nodeId: imageNodeId,
      flush: vi.fn().mockResolvedValue("flushed" as const),
      flushAndGetSelection: vi.fn().mockResolvedValue({
        anchorUtf16: 5,
        focusUtf16: 6
      }),
      flushAndGetSelectionSnapshot: vi.fn().mockResolvedValue({
        selection: { anchorUtf16: 5, focusUtf16: 6 },
        authority: selectionA
      }),
      isSelectionAuthorityCurrent: (candidate: ImageAtomEditorSelectionAuthority) =>
        candidate === selectionA,
      claimPaste: vi.fn().mockReturnValue(false)
    };
    const unregisterA =
      rendered.result.current.registerActiveImageAtomEditor?.(editorA)!;
    act(() => {
      rendered.result.current.actions.updateNodeDraft(
        imageNodeId,
        { title: "typedafter", note: "support", imageOffsetUtf16: 5 },
        "title"
      );
    });
    await waitFor(() =>
      expect(rendered.result.current.draftsByNodeId[imageNodeId]).toBeDefined()
    );
    const preFlushLease =
      rendered.result.current.captureActiveImageAtomEditorAuthority?.(
        imageNodeId,
        selectionA
      );
    expect(preFlushLease).not.toBeNull();

    let flush!: Promise<boolean>;
    act(() => {
      flush = rendered.result.current.actions.flushNodeDraft(imageNodeId);
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());

    unregisterA();
    const selectionB = {} as ImageAtomEditorSelectionAuthority;
    const unregisterB = rendered.result.current.registerActiveImageAtomEditor?.({
      ...editorA,
      flushAndGetSelectionSnapshot: vi.fn().mockResolvedValue({
        selection: { anchorUtf16: 5, focusUtf16: 6 },
        authority: selectionB
      }),
      isSelectionAuthorityCurrent: (candidate) => candidate === selectionB
    })!;
    unregisterB();
    rendered.result.current.registerActiveImageAtomEditor?.(editorA);

    updateGate.resolve(mutationResult(persisted, updateContext!));
    await act(async () => {
      await expect(flush).resolves.toBe(true);
    });
    await waitFor(() =>
      expect(rendered.result.current.draftsByNodeId[imageNodeId]).toBeUndefined()
    );
    expect(
      rendered.result.current.captureImageAtomPasteAuthority?.(
        imageNodeId,
        preFlushLease!
      )
    ).toBeNull();
  });

  it("rechecks deferred image-paste authority when an earlier queued target mutation settles", async () => {
    const imageNodeId = "99110000-0000-4000-8000-000000000001";
    const attachmentId = "99110000-0000-4000-8000-000000000002";
    const pastedNodeId = "99110000-0000-4000-8000-000000000003";
    const pastedAttachmentId = "99110000-0000-4000-8000-000000000004";
    createNoteIdMock
      .mockReturnValueOnce(pastedNodeId)
      .mockReturnValueOnce(pastedAttachmentId);
    const imageAttachment = attachment({ id: attachmentId, nodeId: imageNodeId });
    const initial: NotesWorkspace = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          note: "support",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
    };
    const changed: NotesWorkspace = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "changed",
          note: "support",
          imageOffsetUtf16: 3,
          updatedAt: "2026-07-13T00:00:00Z"
        })
      ],
      attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
    };
    const editGate = deferred<ImageAtomMutationResult>();
    let editContext: NotesHistoryContext | null = null;
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) => {
        editContext = context;
        return editGate.promise;
      }
    );
    const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit,
      applyImageAtomPaste
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/authority-queue", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.setImageImportMaxDisplayWidth(480);
    const selectionAuthority = activateImagePasteAuthority(
      rendered.result.current,
      imageNodeId
    );
    const authority =
      rendered.result.current.captureImageAtomPasteAuthority?.(
        imageNodeId,
        selectionAuthority
      );
    expect(authority).not.toBeNull();

    const edit = rendered.result.current.actions.applyImageAtomEdit(
      imageNodeId,
      { anchorUtf16: 0, focusUtf16: 0 },
      { kind: "remove", replacementText: "x" }
    );
    await waitFor(() => expect(applyImageAtomEdit).toHaveBeenCalledOnce());
    const paste = rendered.result.current.applyImageAtomPasteWithAuthority!(
      authority!,
      imageNodeId,
      { anchorUtf16: 6, focusUtf16: 7 },
      {
        version: 1,
        fragment: [
          {
            kind: "image",
            source: {
              originalName: "queued.png",
              mimeType: "image/png",
              blob: new Blob([new Uint8Array([1])], { type: "image/png" })
            }
          }
        ]
      }
    );
    editGate.resolve(
      await imageAtomMutationResult(changed, editContext!, imageNodeId)
    );

    await act(async () => {
      await expect(edit).resolves.toBe("committed");
      await expect(paste).resolves.toBe("skipped");
    });
    expect(applyImageAtomPaste).not.toHaveBeenCalled();
    expect(rendered.result.current.state.nodesById[imageNodeId]?.title).toBe(
      "changed"
    );
  });

  it("commits one current authorized image cut through the existing edit history path", async () => {
    const imageNodeId = "99112000-0000-4000-8000-000000000001";
    const attachmentId = "99112000-0000-4000-8000-000000000002";
    const initial: NotesWorkspace = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "",
          note: "support",
          imageOffsetUtf16: 0
        })
      ],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    };
    const settled = workspace([
      node({
        id: imageNodeId,
        nodeKind: "text",
        title: "",
        note: "support",
        imageOffsetUtf16: 0
      })
    ]);
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>(
      async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(settled, context, imageNodeId)
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/current-cut-authority", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    const selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
    rendered.result.current.registerActiveImageAtomEditor?.({
      nodeId: imageNodeId,
      flush: vi.fn().mockResolvedValue("flushed"),
      flushAndGetSelection: vi.fn().mockResolvedValue({
        anchorUtf16: 0,
        focusUtf16: 1
      }),
      flushAndGetSelectionSnapshot: vi.fn().mockResolvedValue({
        selection: { anchorUtf16: 0, focusUtf16: 1 },
        authority: selectionAuthority
      }),
      isSelectionAuthorityCurrent: (candidate) =>
        candidate === selectionAuthority,
      claimPaste: vi.fn().mockReturnValue(false)
    });
    const editorAuthority =
      rendered.result.current.captureActiveImageAtomEditorAuthority?.(
        imageNodeId,
        selectionAuthority
      );
    const cutAuthority =
      rendered.result.current.captureImageAtomCutAuthority?.(
        imageNodeId,
        editorAuthority!
      );

    await act(async () => {
      await expect(
        rendered.result.current.applyImageAtomCutWithAuthority!(
          cutAuthority!,
          imageNodeId,
          { anchorUtf16: 0, focusUtf16: 1 }
        )
      ).resolves.toBe("committed");
    });
    expect(applyImageAtomEdit).toHaveBeenCalledOnce();
    expect(applyImageAtomEdit).toHaveBeenCalledWith(
      "/current-cut-authority",
      expect.objectContaining({
        selection: { anchorUtf16: 0, focusUtf16: 1 },
        edit: { kind: "remove", replacementText: "" }
      }),
      expect.anything()
    );
    expect(rendered.result.current.canUndo).toBe(true);
  });

  it.each(["draft", "node", "attachment", "selection"] as const)(
    "skips a queued image cut when its frozen %s authority changes",
    async (change) => {
      const imageNodeId = "99112500-0000-4000-8000-000000000001";
      const attachmentId = "99112500-0000-4000-8000-000000000002";
      const blockerNodeId = "99112500-0000-4000-8000-000000000003";
      const imageNode = node({
        id: imageNodeId,
        nodeKind: "image",
        title: "beforeafter",
        note: "support",
        imageOffsetUtf16: 6
      });
      const blockerNode = node({ id: blockerNodeId, title: "blocker" });
      const imageAttachment = attachment({ id: attachmentId, nodeId: imageNodeId });
      const initial: NotesWorkspace = {
        nodes: [imageNode, blockerNode],
        attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
      };
      const changed: NotesWorkspace = {
        nodes: [
          change === "node"
            ? {
                ...imageNode,
                title: "new-current-content",
                note: "new note",
                imageOffsetUtf16: 4,
                updatedAt: "2026-07-13T00:00:00Z"
              }
            : imageNode,
          { ...blockerNode, title: "changed" }
        ],
        attachmentsByNodeId: {
          [imageNodeId]: [
            change === "attachment"
              ? {
                  ...imageAttachment,
                  displayWidth: 480,
                  updatedAt: "2026-07-13T00:00:00Z"
                }
              : imageAttachment
          ]
        }
      };
      const blockerGate = deferred<NotesMutationResult>();
      let blockerContext: NotesHistoryContext | null = null;
      const updateNode = vi.fn<NotesStore["updateNode"]>(
        async (_vaultRoot, _input, context) => {
          blockerContext = context;
          return blockerGate.promise;
        }
      );
      const resizeAttachment = vi.fn<NonNullable<NotesStore["resizeAttachment"]>>(
        async (_vaultRoot, _input, context) => {
          blockerContext = context;
          return blockerGate.promise;
        }
      );
      const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>();
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
        resizeAttachment,
        applyImageAtomEdit
      });
      const rendered = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/cut-authority-queue", repository: store })
      );
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

      let selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
      const activeEditor = {
        nodeId: imageNodeId,
        flush: vi.fn().mockResolvedValue("flushed" as const),
        flushAndGetSelection: vi.fn().mockResolvedValue({
          anchorUtf16: 3,
          focusUtf16: 10
        }),
        flushAndGetSelectionSnapshot: vi.fn(async () => ({
          selection: { anchorUtf16: 3, focusUtf16: 10 },
          authority: selectionAuthority
        })),
        isSelectionAuthorityCurrent: (candidate: ImageAtomEditorSelectionAuthority) =>
          candidate === selectionAuthority,
        claimPaste: vi.fn().mockReturnValue(false)
      };
      rendered.result.current.registerActiveImageAtomEditor?.(activeEditor);
      const editorAuthority =
        rendered.result.current.captureActiveImageAtomEditorAuthority?.(
          imageNodeId,
          selectionAuthority
        );
      const cutAuthority =
        rendered.result.current.captureImageAtomCutAuthority?.(
          imageNodeId,
          editorAuthority!
        ) as NotesImageAtomCutAuthority | null | undefined;
      expect(cutAuthority).not.toBeNull();

      const blocker = change === "attachment"
        ? rendered.result.current.actions.resizeImage!(attachmentId, 480)
        : rendered.result.current.actions.updateNode(blockerNodeId, {
            title: "changed",
            note: ""
          });
      await waitFor(() =>
        expect(change === "attachment" ? resizeAttachment : updateNode)
          .toHaveBeenCalledOnce()
      );
      const cut = rendered.result.current.applyImageAtomCutWithAuthority!(
        cutAuthority!,
        imageNodeId,
        { anchorUtf16: 3, focusUtf16: 10 }
      );
      if (change === "draft") {
        act(() => {
          rendered.result.current.actions.updateNodeDraft(
            imageNodeId,
            {
              title: "new-current-content",
              note: "new note",
              imageOffsetUtf16: 4
            },
            "title"
          );
        });
      } else if (change === "selection") {
        selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
      }
      blockerGate.resolve(mutationResult(changed, blockerContext!));

      await act(async () => {
        await expect(blocker).resolves.toBe(
          change === "attachment" ? undefined : "committed"
        );
        await expect(cut).resolves.toBe("skipped");
      });
      expect(applyImageAtomEdit).not.toHaveBeenCalled();
    }
  );

  it("revalidates cut selection ownership after async pre-authority work", async () => {
    const imageNodeId = "99113000-0000-4000-8000-000000000001";
    const attachmentId = "99113000-0000-4000-8000-000000000002";
    const imageNode = node({
      id: imageNodeId,
      nodeKind: "image",
      title: "beforeafter",
      note: "support",
      imageOffsetUtf16: 6
    });
    const initial: NotesWorkspace = {
      nodes: [imageNode],
      attachmentsByNodeId: {
        [imageNodeId]: [attachment({ id: attachmentId, nodeId: imageNodeId })]
      }
    };
    const applyImageAtomEdit = vi.fn<NotesStore["applyImageAtomEdit"]>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      applyImageAtomEdit
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/cut-pre-authority", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    let selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
    const activeEditor = {
      nodeId: imageNodeId,
      flush: vi.fn().mockResolvedValue("flushed" as const),
      flushAndGetSelection: vi.fn().mockResolvedValue({
        anchorUtf16: 3,
        focusUtf16: 10
      }),
      flushAndGetSelectionSnapshot: vi.fn(async () => ({
        selection: { anchorUtf16: 3, focusUtf16: 10 },
        authority: selectionAuthority
      })),
      isSelectionAuthorityCurrent: (candidate: ImageAtomEditorSelectionAuthority) =>
        candidate === selectionAuthority,
      claimPaste: vi.fn().mockReturnValue(false)
    };
    rendered.result.current.registerActiveImageAtomEditor?.(activeEditor);
    const editorAuthority =
      rendered.result.current.captureActiveImageAtomEditorAuthority?.(
        imageNodeId,
        selectionAuthority
      );
    const cutAuthority =
      rendered.result.current.captureImageAtomCutAuthority?.(
        imageNodeId,
        editorAuthority!
      );
    expect(cutAuthority).not.toBeNull();

    const digestEntered = deferred<void>();
    const digestGate = deferred<void>();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (...args) => {
        digestEntered.resolve();
        await digestGate.promise;
        return originalDigest(...args);
      }
    );
    try {
      await act(async () => {
        const cut = rendered.result.current.applyImageAtomCutWithAuthority!(
          cutAuthority!,
          imageNodeId,
          { anchorUtf16: 3, focusUtf16: 10 }
        );
        await digestEntered.promise;
        selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
        digestGate.resolve();
        await expect(cut).resolves.toBe("skipped");
      });
      expect(applyImageAtomEdit).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it.each(["registration", "selection ABA"])(
    "rejects image paste at its queue turn after editor %s changes",
    async (change) => {
      const imageNodeId = "99115000-0000-4000-8000-000000000001";
      const attachmentId = "99115000-0000-4000-8000-000000000002";
      const blockerNodeId = "99115000-0000-4000-8000-000000000003";
      createNoteIdMock
        .mockReturnValueOnce("99115000-0000-4000-8000-000000000004")
        .mockReturnValueOnce("99115000-0000-4000-8000-000000000005");
      const imageAttachment = attachment({ id: attachmentId, nodeId: imageNodeId });
      const imageNode = node({
        id: imageNodeId,
        nodeKind: "image",
        title: "beforeafter",
        note: "support",
        imageOffsetUtf16: 6
      });
      const blockerNode = node({ id: blockerNodeId, title: "blocker" });
      const initial: NotesWorkspace = {
        nodes: [imageNode, blockerNode],
        attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
      };
      const changed: NotesWorkspace = {
        nodes: [imageNode, { ...blockerNode, title: "changed" }],
        attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
      };
      const blockerGate = deferred<NotesMutationResult>();
      let blockerContext: NotesHistoryContext | null = null;
      const updateNode = vi.fn<NotesStore["updateNode"]>(
        async (_vaultRoot, _input, context) => {
          blockerContext = context;
          return blockerGate.promise;
        }
      );
      const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>();
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
        applyImageAtomPaste
      });
      const rendered = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/authority-editor-queue", repository: store })
      );
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      rendered.result.current.actions.setImageImportMaxDisplayWidth(480);
      let selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
      const activeEditor = {
        nodeId: imageNodeId,
        flush: vi.fn().mockResolvedValue("flushed" as const),
        flushAndGetSelection: vi.fn().mockResolvedValue({
          anchorUtf16: 6,
          focusUtf16: 7
        }),
        flushAndGetSelectionSnapshot: vi.fn(async () => ({
          selection: { anchorUtf16: 6, focusUtf16: 7 },
          authority: selectionAuthority
        })),
        isSelectionAuthorityCurrent: (candidate: ImageAtomEditorSelectionAuthority) =>
          candidate === selectionAuthority,
        claimPaste: vi.fn().mockReturnValue(false)
      };
      const unregister =
        rendered.result.current.registerActiveImageAtomEditor?.(activeEditor)!;
      const editorAuthority =
        rendered.result.current.captureActiveImageAtomEditorAuthority?.(
          imageNodeId,
          selectionAuthority
        );
      expect(editorAuthority).not.toBeNull();
      const authority =
        rendered.result.current.captureImageAtomPasteAuthority?.(
          imageNodeId,
          editorAuthority!
        );
      expect(authority).not.toBeNull();

      const blocker = rendered.result.current.actions.updateNode(blockerNodeId, {
        title: "changed",
        note: ""
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      const paste = rendered.result.current.applyImageAtomPasteWithAuthority!(
        authority!,
        imageNodeId,
        { anchorUtf16: 6, focusUtf16: 7 },
        {
          version: 1,
          fragment: [
            {
              kind: "image",
              source: {
                originalName: "queued.png",
                mimeType: "image/png",
                blob: new Blob([new Uint8Array([1])], { type: "image/png" })
              }
            }
          ]
        }
      );
      if (change === "registration") {
        unregister();
        rendered.result.current.registerActiveImageAtomEditor?.(activeEditor);
      } else {
        selectionAuthority = {} as ImageAtomEditorSelectionAuthority;
      }
      blockerGate.resolve(mutationResult(changed, blockerContext!));

      await act(async () => {
        await expect(blocker).resolves.toBe("committed");
        await expect(paste).resolves.toBe("skipped");
      });
      expect(applyImageAtomPaste).not.toHaveBeenCalled();
    }
  );

  it("keeps overlapping image-paste admissions bound to their own authority", async () => {
    const imageNodeId = "99120000-0000-4000-8000-000000000001";
    const attachmentId = "99120000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce("99120000-0000-4000-8000-000000000003")
      .mockReturnValueOnce("99120000-0000-4000-8000-000000000004")
      .mockReturnValueOnce("99120000-0000-4000-8000-000000000005")
      .mockReturnValueOnce("99120000-0000-4000-8000-000000000006");
    const imageAttachment = attachment({ id: attachmentId, nodeId: imageNodeId });
    const initial: NotesWorkspace = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "beforeafter",
          note: "support",
          imageOffsetUtf16: 6
        })
      ],
      attachmentsByNodeId: { [imageNodeId]: [imageAttachment] }
    };
    const resizedAttachment = {
      ...imageAttachment,
      displayWidth: 480,
      updatedAt: "2026-07-13T00:00:00Z"
    };
    const resized: NotesWorkspace = {
      nodes: initial.nodes,
      attachmentsByNodeId: { [imageNodeId]: [resizedAttachment] }
    };
    const pasted: NotesWorkspace = {
      nodes: [
        node({
          id: imageNodeId,
          nodeKind: "image",
          title: "first-paste",
          note: "support",
          imageOffsetUtf16: 5,
          updatedAt: "2026-07-14T00:00:00Z"
        })
      ],
      attachmentsByNodeId: { [imageNodeId]: [resizedAttachment] }
    };
    const applyImageAtomPaste = vi.fn<NotesStore["applyImageAtomPaste"]>(
      async (_vaultRoot, _input, context) =>
        imageAtomMutationResult(pasted, context, imageNodeId, "paste")
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      resizeAttachment: vi.fn(async (_vaultRoot, _input, context) =>
        mutationResult(resized, context)
      ),
      applyImageAtomPaste
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/authority-overlap", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    rendered.result.current.actions.setImageImportMaxDisplayWidth(480);
    const selectionAuthority = activateImagePasteAuthority(
      rendered.result.current,
      imageNodeId
    );
    const fragment = {
      version: 1 as const,
      fragment: [
        {
          kind: "image" as const,
          source: {
            originalName: "overlap.png",
            mimeType: "image/png" as const,
            blob: new Blob([new Uint8Array([1])], { type: "image/png" })
          }
        }
      ]
    };
    const firstAuthority =
      rendered.result.current.captureImageAtomPasteAuthority?.(
        imageNodeId,
        selectionAuthority
      );
    await act(async () => {
      await rendered.result.current.actions.resizeImage!(attachmentId, 480);
    });
    const secondAuthority =
      rendered.result.current.captureImageAtomPasteAuthority?.(
        imageNodeId,
        selectionAuthority
      );
    expect(secondAuthority).not.toBe(firstAuthority);
    await act(async () => {
      await expect(
        rendered.result.current.applyImageAtomPasteWithAuthority!(
          firstAuthority!,
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          fragment
        )
      ).resolves.toBe("skipped");
    });
    expect(applyImageAtomPaste).not.toHaveBeenCalled();

    await act(async () => {
      await expect(
        rendered.result.current.applyImageAtomPasteWithAuthority!(
          secondAuthority!,
          imageNodeId,
          { anchorUtf16: 6, focusUtf16: 7 },
          fragment
        )
      ).resolves.toBe("committed");
    });
    expect(applyImageAtomPaste).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    resetImageImportRecoveryForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("imports picker paths in order with all IDs allocated in one repository call", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const firstNodeId = "10000000-0000-4000-8000-000000000001";
    const firstAttachmentId = "10000000-0000-4000-8000-000000000002";
    const secondNodeId = "10000000-0000-4000-8000-000000000003";
    const secondAttachmentId = "10000000-0000-4000-8000-000000000004";
    createNoteIdMock
      .mockReturnValueOnce(firstNodeId)
      .mockReturnValueOnce(firstAttachmentId)
      .mockReturnValueOnce(secondNodeId)
      .mockReturnValueOnce(secondAttachmentId);
    const firstImage = node({
      id: firstNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "one.png"
    });
    const secondImage = node({
      id: secondNodeId,
      nodeKind: "image",
      sortKey: 3072,
      title: "two.webp"
    });
    const importedAttachments = {
      [firstNodeId]: [
        attachment({
          id: firstAttachmentId,
          nodeId: firstNodeId,
          originalName: "one.png"
        })
      ],
      [secondNodeId]: [
        attachment({
          id: secondAttachmentId,
          nodeId: secondNodeId,
          originalName: "two.webp",
          contentHash: "b".repeat(64),
          relativePath: `notes-assets/${"b".repeat(64)}.webp`,
          mimeType: "image/webp"
        })
      ]
    };
    const openImageFiles = vi
      .fn()
      .mockResolvedValue(["/incoming/one.png", "/incoming/two.webp"]);
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        expect(createNoteIdMock).toHaveBeenCalledTimes(4);
        return {
          workspace: {
            nodes: [root, firstImage, secondImage],
            attachmentsByNodeId: importedAttachments
          },
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [firstNodeId, secondNodeId]
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () => result.current.actions.uploadImage!(root.id));

    expect(openImageFiles).toHaveBeenCalledOnce();
    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: firstNodeId,
            attachmentId: firstAttachmentId,
            sourcePath: "/incoming/one.png"
          },
          {
            nodeId: secondNodeId,
            attachmentId: secondAttachmentId,
            sourcePath: "/incoming/two.webp"
          }
        ],
        initialMaxDisplayWidth: 480
      },
      historyContext("attachment-import")
    );
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(result.current.state.attachmentsByNodeId[firstNodeId]).toEqual(
      importedAttachments[firstNodeId]
    );
    expect(result.current.state.selectedId).toBe(firstNodeId);
    expect(result.current.state.pendingFocusId).toBe(firstNodeId);
  });

  it("undoes and redoes a two-image-node import as one ordered history entry", async () => {
    const root = node({ id: "root" });
    const firstNodeId = "11000000-0000-4000-8000-000000000001";
    const firstAttachmentId = "11000000-0000-4000-8000-000000000002";
    const secondNodeId = "11000000-0000-4000-8000-000000000003";
    const secondAttachmentId = "11000000-0000-4000-8000-000000000004";
    createNoteIdMock
      .mockReturnValueOnce(firstNodeId)
      .mockReturnValueOnce(firstAttachmentId)
      .mockReturnValueOnce(secondNodeId)
      .mockReturnValueOnce(secondAttachmentId);
    const firstImage = node({
      id: firstNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "one.png"
    });
    const secondImage = node({
      id: secondNodeId,
      nodeKind: "image",
      sortKey: 3072,
      title: "two.webp"
    });
    const firstImageAttachment = attachment({
      id: firstAttachmentId,
      nodeId: firstNodeId,
      originalName: "one.png"
    });
    const secondImageAttachment = attachment({
      id: secondAttachmentId,
      nodeId: secondNodeId,
      originalName: "two.webp",
      contentHash: "b".repeat(64),
      relativePath: `notes-assets/${"b".repeat(64)}.webp`,
      mimeType: "image/webp"
    });
    const initialWorkspace: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: {}
    };
    const importedWorkspace: NotesWorkspace = {
      nodes: [root, firstImage, secondImage],
      attachmentsByNodeId: {
        [firstNodeId]: [firstImageAttachment],
        [secondNodeId]: [secondImageAttachment]
      }
    };
    let importedEntryId: string | null = null;
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        importedEntryId = context?.entryId ?? null;
        return {
          workspace: importedWorkspace,
          historyEntryId: importedEntryId,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [firstNodeId, secondNodeId]
        };
      }
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initialWorkspace,
      replayedEntryId: importedEntryId,
      ...historyState(),
      kind: "applied" as const,
      canUndo: false,
      canRedo: true
    }));
    const redo = vi.fn().mockImplementation(async () => ({
      workspace: importedWorkspace,
      replayedEntryId: importedEntryId,
      ...historyState(),
      kind: "applied" as const,
      canUndo: true,
      canRedo: false
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initialWorkspace),
      importImageNodePaths,
      undo,
      redo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/one.png",
        "/incoming/two.webp"
      ])
    );

    const importContext = importImageNodePaths.mock.calls[0]?.[2];
    expect(importImageNodePaths).toHaveBeenCalledOnce();
    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: firstNodeId,
            attachmentId: firstAttachmentId,
            sourcePath: "/incoming/one.png"
          },
          {
            nodeId: secondNodeId,
            attachmentId: secondAttachmentId,
            sourcePath: "/incoming/two.webp"
          }
        ],
        initialMaxDisplayWidth: 480
      },
      importContext
    );
    expect(importContext).toEqual(historyContext("attachment-import"));
    expect(importedEntryId).toBe(importContext?.entryId);
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledOnce();
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
      importContext?.entryId,
      expect.objectContaining({
        selectedId: firstNodeId,
        focus: { nodeId: firstNodeId, field: "title" }
      }),
      expect.objectContaining({ nextUndoEntryId: importContext?.entryId })
    );
    expect(result.current.state.rootIds).toEqual([
      root.id,
      firstNodeId,
      secondNodeId
    ]);
    expect(result.current.state).toMatchObject({
      selectedId: firstNodeId,
      editingNoteId: firstNodeId,
      pendingFocusId: firstNodeId,
      pendingFocusField: "title"
    });

    await act(async () => result.current.actions.undo!());

    expect(undo).toHaveBeenCalledOnce();
    expect(undo).toHaveBeenCalledWith(
      "/vault", {
      sessionId:
      importContext?.sessionId,
      historyEpoch: "epoch-a",
      expectedEntryId: importContext?.entryId,
      scope:
      { kind: "active" } }
    );
    expect(result.current.state.rootIds).toEqual([root.id]);
    expect(result.current.state.nodesById[firstNodeId]).toBeUndefined();
    expect(result.current.state.nodesById[secondNodeId]).toBeUndefined();
    expect(result.current.state).toMatchObject({
      selectedId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null
    });

    await act(async () => result.current.actions.redo!());

    expect(redo).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledWith(
      "/vault", {
      sessionId:
      importContext?.sessionId,
      historyEpoch: "epoch-a",
      expectedEntryId: importContext?.entryId,
      scope:
      { kind: "active" } }
    );
    expect(result.current.state.rootIds).toEqual([
      root.id,
      firstNodeId,
      secondNodeId
    ]);
    expect(result.current.state.attachmentsByNodeId[firstNodeId]).toEqual([
      firstImageAttachment
    ]);
    expect(result.current.state.attachmentsByNodeId[secondNodeId]).toEqual([
      secondImageAttachment
    ]);
    expect(result.current.state).toMatchObject({
      selectedId: firstNodeId,
      editingNoteId: firstNodeId,
      pendingFocusId: firstNodeId,
      pendingFocusField: "title"
    });
  });

  it("preserves direct drop path order and delegates unsupported paths to the repository", async () => {
    const ids = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0], ids[2]]
      })
    );
    const store = repository({ importImageNodePaths });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!("root", [
        "/incoming/vector.svg",
        "/incoming/no-extension"
      ])
    );

    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: "root",
        items: [
          {
            nodeId: ids[0],
            attachmentId: ids[1],
            sourcePath: "/incoming/vector.svg"
          },
          {
            nodeId: ids[2],
            attachmentId: ids[3],
            sourcePath: "/incoming/no-extension"
          }
        ],
        initialMaxDisplayWidth: 360
      },
      historyContext("attachment-import")
    );
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("uses the zoomed page header target as a first-child image-node anchor", async () => {
    const root = node({ id: "root" });
    createNoteIdMock
      .mockReturnValueOnce("21000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("21000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: workspace([root]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: ["21000000-0000-4000-8000-000000000001"]
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.zoomTo(root.id));
    await waitFor(() => expect(result.current.state.zoomRootId).toBe(root.id));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/header.png"
      ])
    );

    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({
        parentId: root.id,
        afterId: null,
        items: [
          expect.objectContaining({
            nodeId: "21000000-0000-4000-8000-000000000001",
            attachmentId: "21000000-0000-4000-8000-000000000002",
            sourcePath: "/incoming/header.png"
          })
        ]
      }),
      historyContext("attachment-import")
    );
  });

  it("rejects a stale image target before allocating IDs or calling either import API", async () => {
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!("missing", [
        "/incoming/missing.png"
      ])
    );

    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(store.importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("does not retarget a picker import when the target moves while the picker is open", async () => {
    const parentA = node({ id: "parent-a", sortKey: 1 });
    const parentB = node({ id: "parent-b", sortKey: 2 });
    const target = node({ id: "target", parentId: parentA.id, sortKey: 1 });
    const movedTarget = { ...target, parentId: parentB.id };
    const picker = deferred<readonly string[] | null>();
    const importImageNodePaths = vi.fn().mockResolvedValue(
      workspace([parentA, parentB, movedTarget])
    );
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([parentA, parentB, target])),
      moveNode: vi
        .fn()
        .mockResolvedValue(workspace([parentA, parentB, movedTarget])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(vi.fn().mockReturnValue(picker.promise))
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    const upload = result.current.actions.uploadImage!(target.id);
    await waitFor(() =>
      expect(
        result.current.actionsSlice?.actions.uploadImage
      ).toBeTypeOf("function")
    );
    await act(async () => {
      await result.current.actions.moveNode({
        id: target.id,
        parentId: parentB.id,
        afterId: null
      });
    });
    await waitFor(() =>
      expect(result.current.state.nodesById[target.id]?.parentId).toBe(
        parentB.id
      )
    );

    await act(async () => {
      picker.resolve(["/incoming/race.png"]);
      await upload;
    });

    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(createNoteIdMock).not.toHaveBeenCalled();
  });

  it("discards provisional history when a queued image-node attempt finds a stale anchor", async () => {
    const parentA = node({ id: "parent-a", sortKey: 1 });
    const parentB = node({ id: "parent-b", sortKey: 2 });
    const target = node({ id: "target", parentId: parentA.id, sortKey: 1 });
    const movedTarget = { ...target, parentId: parentB.id };
    const move = deferred<NotesMutationResult>();
    createNoteIdMock
      .mockReturnValueOnce("22000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("22000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn().mockResolvedValue(
      workspace([parentA, parentB, movedTarget])
    );
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([parentA, parentB, target])),
      moveNode: vi.fn().mockReturnValue(move.promise),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    const moveCompletion = result.current.actions.moveNode({
      id: target.id,
      parentId: parentB.id,
      afterId: null
    });
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    const dropCompletion = result.current.actions.importDroppedImagePaths!(
      target.id,
      ["/incoming/stale.png"]
    );

    move.resolve({
      workspace: workspace([parentA, parentB, movedTarget]),
      historyEntryId: vi.mocked(store.moveNode).mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await act(async () => {
      await moveCompletion;
      await dropCompletion;
    });

    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(createNoteIdMock).toHaveBeenCalledTimes(2);
    expect(notesHistorySpies.discard).toHaveBeenCalledTimes(1);
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledTimes(1);
  });

  it("cleans an initial image attempt when the draft barrier skips before import work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("23000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("23000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn();
    const updateNode = vi.fn().mockRejectedValue(new Error("save failed"));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root", title: "Root" })])),
      updateNode,
      importImageNodePaths
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    act(() => {
      rendered.result.current.actions.setImageImportMaxDisplayWidth(360);
      rendered.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved root",
        note: ""
      , imageOffsetUtf16: 0});
    });
    await act(async () =>
      rendered.result.current.actions.importDroppedImagePaths!("root", [
        "/incoming/skipped.png"
      ])
    );

    expect(updateNode).toHaveBeenCalledOnce();
    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
    expect(
      rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();
    const discardedEntryIds = notesHistorySpies.discard.mock.calls.map(
      ([entryId]) => entryId
    );
    expect(discardedEntryIds).toHaveLength(2);
    expect(new Set(discardedEntryIds).size).toBe(2);

    rendered.unmount();
    await act(async () => Promise.resolve());
    for (const entryId of discardedEntryIds) {
      expect(
        notesHistorySpies.discard.mock.calls.filter(
          ([discardedEntryId]) => discardedEntryId === entryId
        )
      ).toHaveLength(1);
    }
  });

  it("keeps an unknown retry when the draft barrier skips before native retry work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("24000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("24000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));
    const updateNode = vi.fn().mockRejectedValue(new Error("save failed"));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "root", title: "Root" })])),
      updateNode,
      importImageNodePaths
    });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));

    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(360)
    );
    await act(async () =>
      rendered.result.current.actions.importDroppedImagePaths!("root", [
        "/incoming/retry.png"
      ])
    );
    const retryAttemptId =
      rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root;
    const importHistoryEntryId = importImageNodePaths.mock.calls[0]?.[2]?.entryId;
    expect(retryAttemptId).toBeDefined();
    expect(importHistoryEntryId).toBeDefined();
    expect(notesHistorySpies.discard).not.toHaveBeenCalledWith(
      importHistoryEntryId
    );

    act(() =>
      rendered.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved before retry",
        note: ""
      , imageOffsetUtf16: 0})
    );
    await act(async () =>
      rendered.result.current.actions.retryImageUpload!(
        "root",
        retryAttemptId
      )
    );

    expect(updateNode).toHaveBeenCalledOnce();
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBe("Image upload failed: disk full");
    expect(
      rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBe(retryAttemptId);
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === importHistoryEntryId
      )
    ).toHaveLength(0);

    rendered.unmount();
    await act(async () => Promise.resolve());
    expect(
      notesHistorySpies.discard.mock.calls.filter(
        ([entryId]) => entryId === importHistoryEntryId
      )
    ).toHaveLength(0);
  });

  it("cleans an image attempt when the coordinator rejects before running work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("25000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("25000000-0000-4000-8000-000000000002");
    const importImageNodePaths = vi.fn();
    const store = repository({ importImageNodePaths });
    const realOpenSession =
      notesWorkspaceCoordinatorRegistry.openSession.bind(
        notesWorkspaceCoordinatorRegistry
      );
    const openSession = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        return {
          ...session,
          enqueueStructural: vi
            .fn()
            .mockRejectedValue(new Error("coordinator aborted"))
        };
      });
    const rendered = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    try {
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      act(() =>
        rendered.result.current.actions.setImageImportMaxDisplayWidth(360)
      );

      await act(async () =>
        rendered.result.current.actions.importDroppedImagePaths!("root", [
          "/incoming/aborted.png"
        ])
      );

      expect(importImageNodePaths).not.toHaveBeenCalled();
      expect(
        rendered.result.current.attachmentUploadErrorsByNodeId?.root
      ).toBeUndefined();
      expect(
        rendered.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
      ).toBeUndefined();
      expect(notesHistorySpies.discard).toHaveBeenCalledTimes(1);
    } finally {
      rendered.unmount();
      openSession.mockRestore();
    }
  });

  it.each([
    ["unsupported-only", ["/incoming/vector.svg"]],
    ["mixed", ["/incoming/photo.png", "/incoming/vector.svg"]]
  ] as const)(
    "keeps an atomic %s native path failure to one repository call and one UI error",
    async (_name, paths) => {
      const root = node({
        id: "root",
        nodeKind: "image",
        title: "target.png",
        isCollapsed: true
      });
      createNoteIdMock.mockImplementation(
        () => `drop-${createNoteIdMock.mock.calls.length}`
      );
      const importImageNodePaths = vi
        .fn()
        .mockRejectedValue(new Error("vector.svg is unsupported"));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
        importImageNodePaths
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/vault", repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
      const input = document.createElement("textarea");
      input.value = "abcdef";
      document.body.append(input);
      input.focus();
      input.setSelectionRange(2, 5);

      await act(async () =>
        result.current.actions.importDroppedImagePaths!(root.id, paths)
      );

      expect(importImageNodePaths).toHaveBeenCalledTimes(1);
      expect(store.importAttachmentPaths).not.toHaveBeenCalled();
      expect(result.current.attachmentUploadErrorsByNodeId).toEqual({
        [root.id]: "Image upload failed: vector.svg is unsupported"
      });
      expect(result.current.state.attachmentsByNodeId[root.id] ?? []).toEqual([]);
      expect(result.current.state.nodesById[root.id].isCollapsed).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(5);
      input.remove();
    }
  );

  it("imports clipboard blobs in order through one byte batch call", async () => {
    const ids = [
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000003",
      "30000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const firstBlob = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
    const secondBlob = new Blob([new Uint8Array([3])], { type: "image/webp" });
    const items: readonly PendingImageNodeByteItem[] = [
      { originalName: "one.png", mimeType: "image/png", blob: firstBlob },
      { originalName: "two.webp", mimeType: "image/webp", blob: secondBlob }
    ];
    const importImageNodeBytes = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0], ids[2]]
      })
    );
    const store = repository({ importImageNodeBytes });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(420));
    await act(async () =>
      result.current.actions.importClipboardImages!("root", items)
    );

    expect(importImageNodeBytes).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: "root",
        items: [
          { nodeId: ids[0], attachmentId: ids[1], ...items[0] },
          { nodeId: ids[2], attachmentId: ids[3], ...items[1] }
        ],
        initialMaxDisplayWidth: 420
      },
      historyContext("attachment-import")
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(1);
    expect(store.importAttachmentBytes).not.toHaveBeenCalled();
  });

  it.each([
    [
      "item count",
      () =>
        pendingImageBatch(
          "count",
          Array.from(
            { length: MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS + 1 },
            () => 1
          )
        )
    ],
    [
      "per-file bytes",
      () => pendingImageBatch("file", [MAX_NOTE_ATTACHMENT_BYTES + 1])
    ],
    [
      "aggregate bytes",
      () =>
        pendingImageBatch(
          "aggregate",
          Array.from(
            { length: 4 },
            () => MAX_NOTE_ATTACHMENT_BATCH_BYTES / 4 + 1
          )
        )
    ]
  ] as const)(
    "rejects a clipboard batch with invalid %s before allocating IDs or retaining a retry",
    async (_case, createItems) => {
      createNoteIdMock.mockImplementation(
        () => `invalid-${createNoteIdMock.mock.calls.length}`
      );
      const importImageNodeBytes = vi
        .fn()
        .mockRejectedValue(new Error("invalid batch reached repository"));
      const store = repository({ importImageNodeBytes });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/vault", repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

      await act(async () =>
        result.current.actions.importClipboardImages!("root", createItems())
      );

      expect(createNoteIdMock).not.toHaveBeenCalled();
      expect(importImageNodeBytes).not.toHaveBeenCalled();
      expect(store.importAttachmentBytes).not.toHaveBeenCalled();
      expect(
        result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
      ).toBeUndefined();
    }
  );

  it("rejects cap pressure without evicting unknown clipboard outcomes", async () => {
    const pathTarget = node({ id: "path-target" });
    const oldestByteTarget = node({
      id: "oldest-byte-target",
      sortKey: 2048
    });
    const retainedByteTarget = node({
      id: "retained-byte-target",
      sortKey: 3072
    });
    const newestByteTarget = node({
      id: "newest-byte-target",
      sortKey: 4096
    });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `52000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const importImageNodePaths = vi
      .fn()
      .mockRejectedValue(new Error("path failure"));
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValue(new Error("byte failure"));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(
        workspace([
          pathTarget,
          oldestByteTarget,
          retainedByteTarget,
          newestByteTarget
        ])
      ),
      importImageNodePaths,
      importImageNodeBytes
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

    await act(async () =>
      result.current.actions.importDroppedImagePaths!(pathTarget.id, [
        "/incoming/path.png"
      ])
    );
    const pathAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[pathTarget.id];
    await act(async () =>
      result.current.actions.importClipboardImages!(
        oldestByteTarget.id,
        pendingImageBatch("oldest", [
          MAX_NOTE_ATTACHMENT_BYTES,
          MAX_NOTE_ATTACHMENT_BYTES
        ])
      )
    );
    const oldestByteAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        oldestByteTarget.id
      ];
    await act(async () =>
      result.current.actions.importClipboardImages!(
        retainedByteTarget.id,
        pendingImageBatch("retained", [MAX_NOTE_ATTACHMENT_BYTES])
      )
    );
    const retainedByteAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        retainedByteTarget.id
      ];
    await act(async () =>
      result.current.actions.importClipboardImages!(
        newestByteTarget.id,
        pendingImageBatch("newest", [MAX_NOTE_ATTACHMENT_BYTES])
      )
    );

    expect(pathAttemptId).toBeDefined();
    expect(oldestByteAttemptId).toBeDefined();
    expect(retainedByteAttemptId).toBeDefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[pathTarget.id]
    ).toBe(pathAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        oldestByteTarget.id
      ]
    ).toBe(oldestByteAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        retainedByteTarget.id
      ]
    ).toBe(retainedByteAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        newestByteTarget.id
      ]
    ).toBeUndefined();

    await act(async () =>
      result.current.actions.retryImageUpload!(
        oldestByteTarget.id,
        oldestByteAttemptId
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(3);
  });

  it("does not retain Blob retries when byte import is unavailable across hooks", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `52500000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const store = repository({ importImageNodeBytes: undefined });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/unsupported", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/unsupported", repository: store })
    );
    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
    });
    act(() => {
      first.result.current.actions.setImageImportMaxDisplayWidth(320);
      second.result.current.actions.setImageImportMaxDisplayWidth(320);
    });
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }

    await act(async () =>
      first.result.current.actions.importClipboardImages!(
        "root",
        pendingImageBatch("unsupported-first", fullBatchSizes)
      )
    );
    await act(async () =>
      second.result.current.actions.importClipboardImages!(
        "root",
        pendingImageBatch("unsupported-second", fullBatchSizes)
      )
    );

    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(first.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Image upload failed: Image node byte import is unavailable."
    });
    expect(second.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Image upload failed: Image node byte import is unavailable."
    });
    expect(
      first.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();
    expect(
      second.result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();

    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ): Promise<NotesMutationResult> => ({
        workspace: workspace([
          node({ id: "root" }),
          ...input.items.map((item, index) =>
            node({
              id: item.nodeId,
              nodeKind: "image",
              sortKey: 2048 + index * 1024
            })
          )
        ]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: input.items.map((item) => item.nodeId)
      })
    );
    Object.assign(store, { importImageNodeBytes });

    await act(async () =>
      second.result.current.actions.importClipboardImages!(
        "root",
        pendingImageBatch("supported-afterward", fullBatchSizes)
      )
    );

    expect(importImageNodeBytes).toHaveBeenCalledOnce();
  });

  it("keeps pending clipboard bytes and rejects a new cross-node attempt at the global byte budget", async () => {
    const failedTarget = node({ id: "failed-target" });
    const pendingTarget = node({ id: "pending-target" });
    const rejectedTarget = node({ id: "rejected-target", sortKey: 3072 });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `53000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const pendingImport = deferred<NotesMutationResult>();
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error("retained failure"))
      .mockReturnValueOnce(pendingImport.promise)
      .mockRejectedValue(new Error("new attempt was retained"));
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(
          workspace([failedTarget, pendingTarget, rejectedTarget])
        ),
      importImageNodeBytes
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

    await act(async () =>
      result.current.actions.importClipboardImages!(
        failedTarget.id,
        pendingImageBatch("failed", [
          MAX_NOTE_ATTACHMENT_BATCH_BYTES -
            MAX_NOTE_ATTACHMENT_BYTES * 3
        ])
      )
    );
    const failedAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[failedTarget.id];
    expect(failedAttemptId).toBeDefined();

    let pendingCompletion!: Promise<void>;
    let rejectedCompletion!: Promise<void>;
    act(() => {
      pendingCompletion = result.current.actions.importClipboardImages!(
        pendingTarget.id,
        pendingImageBatch(
          "pending",
          Array.from(
            { length: 3 },
            () => MAX_NOTE_ATTACHMENT_BYTES
          )
        )
      );
    });
    await waitFor(() =>
      expect(importImageNodeBytes).toHaveBeenCalledTimes(2)
    );
    const allocatedForPending = createNoteIdMock.mock.calls.length;
    act(() => {
      rejectedCompletion = result.current.actions.importClipboardImages!(
        rejectedTarget.id,
        pendingImageBatch("rejected", [
          MAX_NOTE_ATTACHMENT_BATCH_BYTES -
            MAX_NOTE_ATTACHMENT_BYTES * 3 +
            1
        ])
      );
    });

    expect(createNoteIdMock).toHaveBeenCalledTimes(allocatedForPending);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[failedTarget.id]
    ).toBe(failedAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        rejectedTarget.id
      ]
    ).toBeUndefined();

    pendingImport.reject(new Error("pending failure"));
    await act(async () =>
      Promise.all([pendingCompletion, rejectedCompletion])
    );

    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[failedTarget.id]
    ).toBe(failedAttemptId);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        pendingTarget.id
      ]
    ).toBeDefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
        rejectedTarget.id
      ]
    ).toBeUndefined();
  });

  it("counts a started clipboard batch across repeated vault switches until it settles", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `54000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    let retainImports = true;
    const pendingImports: ReturnType<typeof deferred<NotesMutationResult>>[] = [];
    const importImageNodeBytes = vi.fn(
      (
        _vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => {
        if (retainImports) {
          const pendingImport = deferred<NotesMutationResult>();
          pendingImports.push(pendingImport);
          return pendingImport.promise;
        }
        return Promise.resolve({
          workspace: workspace([node({ id: "root" })]),
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        });
      }
    );
    const store = repository({ importImageNodeBytes });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const fullBatch = (prefix: string) =>
      pendingImageBatch(prefix, fullBatchSizes);
    const completions: Promise<void>[] = [];

    act(() => {
      completions.push(
        rendered.result.current.actions.importClipboardImages!(
          "root",
          fullBatch("vault-a")
        )
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());

    for (const vaultRoot of ["/vault-b", "/vault-c"]) {
      rendered.rerender({ vaultRoot });
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      act(() => {
        completions.push(
          rendered.result.current.actions.importClipboardImages!(
            "root",
            fullBatch(vaultRoot)
          )
        );
      });
    }

    const callsBeforeSettlement = importImageNodeBytes.mock.calls.length;
    const idsBeforeSettlement = createNoteIdMock.mock.calls.length;
    expect(rendered.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Clipboard image retry data exceeds the 64 MiB memory limit."
    });

    retainImports = false;
    for (const [index, pendingImport] of pendingImports.entries()) {
      const context = importImageNodeBytes.mock.calls[index]?.[2];
      pendingImport.resolve({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      });
    }
    await act(async () => Promise.all(completions));

    expect(callsBeforeSettlement).toBe(1);
    expect(idsBeforeSettlement).toBe(fullBatchSizes.length * 2);
    expect(rendered.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Clipboard image retry data exceeds the 64 MiB memory limit."
    });

    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-c-after-settlement")
      )
    );

    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(importImageNodeBytes.mock.calls[1]?.[0]).toBe("/vault-c");
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
  });

  it("keeps an unstarted clipboard batch accounted until its old-vault structural intent finalizes", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `54500000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const draftSave = deferred<NotesWorkspace>();
    const importImageNodeBytes = vi.fn(
      async (
        vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [vaultRoot === "/vault-b" ? "imported-b" : "imported-a"]
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      updateNode: vi.fn().mockReturnValue(draftSave.promise),
      importImageNodeBytes
    });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    act(() => {
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320);
      rendered.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved in A",
        note: ""
      , imageOffsetUtf16: 0});
    });
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const fullBatch = (prefix: string) =>
      pendingImageBatch(prefix, fullBatchSizes);

    let vaultAImport!: Promise<void>;
    act(() => {
      vaultAImport = rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-a")
      );
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(importImageNodeBytes).not.toHaveBeenCalled();

    rendered.rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-before-finalize")
      )
    );

    expect(importImageNodeBytes).not.toHaveBeenCalled();
    expect(rendered.result.current.attachmentUploadErrorsByNodeId).toEqual({
      root: "Clipboard image retry data exceeds the 64 MiB memory limit."
    });
    expect(createNoteIdMock).toHaveBeenCalledTimes(fullBatchSizes.length * 2);

    await act(async () => {
      draftSave.resolve(workspace([node({ id: "root", title: "Saved in A" })]));
      await vaultAImport;
    });
    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-after-finalize")
      )
    );

    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(importImageNodeBytes.mock.calls[0]?.[0]).toBe("/vault-b");
    expect(
      rendered.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
  });

  it("keeps an unstarted clipboard batch accounted across hook unmount and fresh mount", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `54700000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const draftSave = deferred<NotesWorkspace>();
    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      updateNode: vi.fn().mockReturnValue(draftSave.promise),
      importImageNodeBytes
    });
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const fullBatch = (prefix: string) =>
      pendingImageBatch(prefix, fullBatchSizes);
    const vaultA = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    await waitFor(() => expect(vaultA.result.current.status).toBe("ready"));
    act(() => {
      vaultA.result.current.actions.setImageImportMaxDisplayWidth(320);
      vaultA.result.current.actions.updateNodeDraft("root", {
        title: "Unsaved in A",
        note: ""
      , imageOffsetUtf16: 0});
    });

    let vaultAImport!: Promise<void>;
    act(() => {
      vaultAImport = vaultA.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-a")
      );
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(importImageNodeBytes).not.toHaveBeenCalled();

    vaultA.unmount();
    await act(async () => Promise.resolve());
    const vaultB = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-b", repository: store })
    );
    await waitFor(() => expect(vaultB.result.current.status).toBe("ready"));
    act(() =>
      vaultB.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    await act(async () =>
      vaultB.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-before-finalize")
      )
    );
    const callsBeforeFinalization = importImageNodeBytes.mock.calls.length;
    const idsBeforeFinalization = createNoteIdMock.mock.calls.length;
    const errorBeforeFinalization =
      vaultB.result.current.attachmentUploadErrorsByNodeId?.root;

    await act(async () => {
      draftSave.resolve(workspace([node({ id: "root", title: "Saved in A" })]));
      await vaultAImport;
    });

    expect(callsBeforeFinalization).toBe(0);
    expect(idsBeforeFinalization).toBe(fullBatchSizes.length * 2);
    expect(errorBeforeFinalization).toBe(
      "Clipboard image retry data exceeds the 64 MiB memory limit."
    );

    await act(async () =>
      vaultB.result.current.actions.importClipboardImages!(
        "root",
        fullBatch("vault-b-after-finalize")
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(importImageNodeBytes.mock.calls[0]?.[0]).toBe("/vault-b");
    expect(
      vaultB.result.current.attachmentUploadErrorsByNodeId?.root
    ).toBeUndefined();
  });

  it("counts queued clipboard batches across vault switches until their closures release", async () => {
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `55000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const firstImport = deferred<NotesMutationResult>();
    const importImageNodeBytes = vi.fn(
      (
        _vaultRoot: string,
        _input: unknown,
        context?: { entryId?: string } | null
      ) => {
        if (importImageNodeBytes.mock.calls.length === 1) {
          return firstImport.promise;
        }
        return Promise.resolve({
          workspace: workspace([node({ id: "root" })]),
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false
        });
      }
    );
    const store = repository({ importImageNodeBytes });
    const rendered = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
    act(() =>
      rendered.result.current.actions.setImageImportMaxDisplayWidth(320)
    );
    const halfBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES / 2;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      halfBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const halfBatch = (prefix: string) =>
      pendingImageBatch(prefix, halfBatchSizes);
    const completions: Promise<void>[] = [];

    act(() => {
      completions.push(
        rendered.result.current.actions.importClipboardImages!(
          "root",
          halfBatch("vault-a-running")
        ),
        rendered.result.current.actions.importClipboardImages!(
          "root",
          halfBatch("vault-a-queued")
        )
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());
    expect(createNoteIdMock).toHaveBeenCalledTimes(halfBatchSizes.length * 4);

    for (const vaultRoot of ["/vault-b", "/vault-c"]) {
      rendered.rerender({ vaultRoot });
      await waitFor(() => expect(rendered.result.current.status).toBe("ready"));
      act(() => {
        completions.push(
          rendered.result.current.actions.importClipboardImages!(
            "root",
            halfBatch(vaultRoot)
          )
        );
      });
    }

    const idsWhilePending = createNoteIdMock.mock.calls.length;
    const repositoryCallsWhilePending = importImageNodeBytes.mock.calls.length;
    const errorWhilePending =
      rendered.result.current.attachmentUploadErrorsByNodeId?.root;

    const firstContext = importImageNodeBytes.mock.calls[0]?.[2];
    firstImport.resolve({
      workspace: workspace([node({ id: "root" })]),
      historyEntryId: firstContext?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await act(async () => {
      await Promise.allSettled([firstImport.promise]);
      await Promise.all(completions);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () =>
      rendered.result.current.actions.importClipboardImages!(
        "root",
        halfBatch("vault-c-after-release")
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(importImageNodeBytes.mock.calls[1]?.[0]).toBe("/vault-c");
    expect(createNoteIdMock).toHaveBeenCalledTimes(halfBatchSizes.length * 6);
    expect(idsWhilePending).toBe(halfBatchSizes.length * 4);
    expect(repositoryCallsWhilePending).toBe(1);
    expect(errorWhilePending).toBe(
      "Clipboard image retry data exceeds the 64 MiB memory limit."
    );
  });

  it("retries a lost committed response with the same IDs, context, order, and sources", async () => {
    const root = node({ id: "87384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const ids = [
      "40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002",
      "40000000-0000-4000-8000-000000000003",
      "40000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const importedNodes = [
      root,
      node({ id: ids[0], nodeKind: "image", sortKey: 2048 }),
      node({ id: ids[2], nodeKind: "image", sortKey: 3072 })
    ];
    const imported = [ids[1], ids[3]].map((id, index) =>
      attachment({
        id,
        nodeId: importedNodes[index + 1]!.id,
        sortKey: 1024,
        contentHash: String.fromCharCode(97 + index).repeat(64),
        relativePath: `notes-assets/${String.fromCharCode(97 + index).repeat(64)}.png`
      })
    );
    const importImageNodePaths = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: importedNodes,
          attachmentsByNodeId: {
            [ids[0]]: [imported[0]!],
            [ids[2]]: [imported[1]!]
          }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0], ids[2]]
      }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () =>
      result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/one.png",
        "/incoming/two.webp"
      ])
    );
    const retryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(2);
    expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual(
      importImageNodePaths.mock.calls[0]?.[1]
    );
    expect(importImageNodePaths.mock.calls[1]?.[2]).toBe(
      importImageNodePaths.mock.calls[0]?.[2]
    );
    expect(result.current.state.attachmentsByNodeId[ids[0]]).toEqual([
      imported[0]
    ]);
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
    ).toBeUndefined();
  });

  it("holds a same-anchor byte batch behind an unknown commit until retry reconciles its tail", async () => {
    const root = node({ id: "unknown-root" });
    const capacityTarget = node({
      id: "capacity-target",
      sortKey: 4096
    });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `74100000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const lostResponse = deferred<NotesMutationResult>();
    let firstCalls = 0;
    let committedFirstIds: string[] = [];
    let committedSecondIds: string[] = [];
    let backendWorkspace: NotesWorkspace = workspace([root, capacityTarget]);
    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ) => {
        const importedIds = input.items.map((item) => item.nodeId);
        const originalName = input.items[0]?.originalName;
        const result = (importedRootIds: string[]): NotesMutationResult => ({
          workspace: backendWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds
        });

        if (originalName === "unknown-a-0.png") {
          firstCalls += 1;
          committedFirstIds = importedIds;
          backendWorkspace = {
            nodes: [
              root,
              ...importedIds.map((id, index) =>
                node({
                  id,
                  nodeKind: "image",
                  sortKey: 2048 + index * 1024
                })
              ),
              capacityTarget
            ]
          };
          if (firstCalls === 1) {
            return lostResponse.promise;
          }
          return result(importedIds);
        }

        if (originalName === "unknown-b-0.png") {
          committedSecondIds = importedIds;
          backendWorkspace = {
            nodes: [
              root,
              ...committedFirstIds.map((id, index) =>
                node({
                  id,
                  nodeKind: "image",
                  sortKey: 2048 + index * 1024
                })
              ),
              ...importedIds.map((id, index) =>
                node({
                  id,
                  nodeKind: "image",
                  sortKey: 3072 + index * 1024
                })
              ),
              capacityTarget
            ]
          };
          return result(importedIds);
        }

        backendWorkspace = {
          nodes: [
            root,
            ...committedFirstIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 2048 + index * 1024
              })
            ),
            ...committedSecondIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 3072 + index * 1024
              })
            ),
            capacityTarget,
            ...importedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 5120 + index * 1024
              })
            )
          ]
        };
        return result(importedIds);
      }
    );
    const store = repository({
      loadWorkspace: vi.fn(async () => backendWorkspace),
      importImageNodeBytes
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/unknown-outcome", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("unknown-a", [1])
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());
    act(() => {
      secondCompletion = result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("unknown-b", [1])
      );
    });
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    let secondSettled = false;
    void secondCompletion.then(() => {
      secondSettled = true;
    });
    lostResponse.reject(new Error("response lost after commit"));
    await act(async () => firstCompletion);
    await act(async () => Promise.resolve());

    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(secondSettled).toBe(false);
    const retryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }
    const allocatedBeforeCapacityCheck = createNoteIdMock.mock.calls.length;
    await act(async () =>
      result.current.actions.importClipboardImages!(
        capacityTarget.id,
        pendingImageBatch("capacity", fullBatchSizes)
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(createNoteIdMock).toHaveBeenCalledTimes(
      allocatedBeforeCapacityCheck
    );
    expect(
      result.current.attachmentUploadErrorsByNodeId?.[capacityTarget.id]
    ).toBe("Clipboard image retry data exceeds the 64 MiB memory limit.");

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    await act(async () => secondCompletion);

    expect(importImageNodeBytes).toHaveBeenCalledTimes(3);
    expect(importImageNodeBytes.mock.calls[1]?.[1]).toEqual(
      importImageNodeBytes.mock.calls[0]?.[1]
    );
    expect(importImageNodeBytes.mock.calls[1]?.[2]).toBe(
      importImageNodeBytes.mock.calls[0]?.[2]
    );
    expect(importImageNodeBytes.mock.calls[2]?.[1].afterId).toBe(
      committedFirstIds.at(-1)
    );
    expect(result.current.state.rootIds).toEqual([
      root.id,
      ...committedFirstIds,
      ...committedSecondIds,
      capacityTarget.id
    ]);

    await act(async () =>
      result.current.actions.importClipboardImages!(
        capacityTarget.id,
        pendingImageBatch("capacity", fullBatchSizes)
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(4);
    expect(
      result.current.attachmentUploadErrorsByNodeId?.[capacityTarget.id]
    ).toBeUndefined();
  });

  it("keeps a canceled same-anchor turn behind an unknown predecessor across remount", async () => {
    const root = node({ id: "canceled-turn-root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `74150000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    let backendWorkspace: NotesWorkspace = workspace([root]);
    let unknownCalls = 0;
    let unknownIds: string[] = [];
    const importImageNodeBytes = vi.fn(
      async (
        _vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ): Promise<NotesMutationResult> => {
        const originalName = input.items[0]?.originalName;
        const importedIds = input.items.map((item) => item.nodeId);
        if (originalName === "canceled-b-0.png") {
          throw new Error("a canceled batch must never reach the repository");
        }
        if (originalName === "unknown-a-0.png") {
          unknownCalls += 1;
          unknownIds = importedIds;
          backendWorkspace = workspace([
            root,
            ...unknownIds.map((id, index) =>
              node({ id, nodeKind: "image", sortKey: 2048 + index * 1024 })
            )
          ]);
          if (unknownCalls === 1) {
            throw new Error("response lost after commit");
          }
        } else {
          backendWorkspace = workspace([
            root,
            ...unknownIds.map((id, index) =>
              node({ id, nodeKind: "image", sortKey: 2048 + index * 1024 })
            ),
            ...importedIds.map((id, index) =>
              node({ id, nodeKind: "image", sortKey: 4096 + index * 1024 })
            )
          ]);
        }
        return {
          workspace: backendWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: importedIds
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn(async () => backendWorkspace),
      importImageNodeBytes
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/canceled-turn", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    act(() => owner.result.current.actions.setImageImportMaxDisplayWidth(320));

    await act(async () =>
      owner.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("unknown-a", [1])
      )
    );
    const retryAttemptId =
      owner.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    let canceledCompletion!: Promise<void>;
    act(() => {
      canceledCompletion = owner.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("canceled-b", [1])
      );
    });
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    owner.unmount();
    await act(async () => Promise.resolve());

    const fresh = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/canceled-turn", repository: store })
    );
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    act(() => fresh.result.current.actions.setImageImportMaxDisplayWidth(320));
    await waitFor(() =>
      expect(
        fresh.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
      ).toBe(retryAttemptId)
    );

    let freshCompletion!: Promise<void>;
    act(() => {
      freshCompletion = fresh.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("fresh-c", [1])
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    await act(async () =>
      fresh.result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    await act(async () => Promise.all([canceledCompletion, freshCompletion]));

    expect(
      importImageNodeBytes.mock.calls.map(([_, input]) => input.items[0]?.originalName)
    ).toEqual(["unknown-a-0.png", "unknown-a-0.png", "fresh-c-0.png"]);
    expect(importImageNodeBytes.mock.calls[2]?.[1].afterId).toBe(unknownIds.at(-1));
  });

  it("reconciles an unknown commit after vault switch and remount before releasing its anchor turn", async () => {
    const root = node({ id: "teardown-root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `74200000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const rejectedImport = deferred<NotesMutationResult>();
    let backendWorkspace: NotesWorkspace = workspace([root]);
    let firstImportedIds: string[] = [];
    let secondImportedIds: string[] = [];
    let firstCalls = 0;
    const importImageNodeBytes = vi.fn(
      (
        vaultRoot: string,
        input: ImportImageNodeBytesInput,
        context?: NotesHistoryContext | null
      ) => {
        const importedIds = input.items.map((item) => item.nodeId);
        if (vaultRoot !== "/teardown-race") {
          throw new Error(`unexpected import for ${vaultRoot}`);
        }
        if (input.items[0]?.originalName === "teardown-a-0.png") {
          firstCalls += 1;
          firstImportedIds = importedIds;
          backendWorkspace = workspace([
            root,
            ...firstImportedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 2048 + index * 1024
              })
            )
          ]);
          if (firstCalls === 1) {
            return rejectedImport.promise;
          }
        } else {
          secondImportedIds = importedIds;
          backendWorkspace = workspace([
            root,
            ...firstImportedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 2048 + index * 1024
              })
            ),
            ...secondImportedIds.map((id, index) =>
              node({
                id,
                nodeKind: "image",
                sortKey: 4096 + index * 1024
              })
            )
          ]);
        }
        return Promise.resolve({
          workspace: backendWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: importedIds
        });
      }
    );
    const store = repository({
      loadWorkspace: vi.fn(async (vaultRoot: string) =>
        vaultRoot === "/teardown-race"
          ? backendWorkspace
          : workspace([root])
      ),
      importImageNodeBytes
    });
    const owner = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/teardown-race" } }
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    act(() => owner.result.current.actions.setImageImportMaxDisplayWidth(320));

    let firstCompletion!: Promise<void>;
    act(() => {
      firstCompletion = owner.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("teardown-a", [1, 1])
      );
    });
    await waitFor(() => expect(importImageNodeBytes).toHaveBeenCalledOnce());
    const originalInput = importImageNodeBytes.mock.calls[0]?.[1];
    const originalContext = importImageNodeBytes.mock.calls[0]?.[2];

    owner.rerender({ vaultRoot: "/other-vault" });
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    rejectedImport.reject(new Error("response lost during teardown"));
    await act(async () => firstCompletion);
    owner.unmount();
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    const fresh = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/teardown-race", repository: store })
    );
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    act(() => fresh.result.current.actions.setImageImportMaxDisplayWidth(320));
    await waitFor(() =>
      expect(
        fresh.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id]
      ).toBeDefined()
    );
    const retryAttemptId =
      fresh.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    const fullBatchSizes: number[] = [];
    for (
      let remaining = MAX_NOTE_ATTACHMENT_BATCH_BYTES;
      remaining > 0;
      remaining -= MAX_NOTE_ATTACHMENT_BYTES
    ) {
      fullBatchSizes.push(Math.min(remaining, MAX_NOTE_ATTACHMENT_BYTES));
    }

    const allocatedBeforeCapacityCheck = createNoteIdMock.mock.calls.length;
    await act(async () =>
      fresh.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("teardown-capacity", fullBatchSizes)
      )
    );
    expect(importImageNodeBytes).toHaveBeenCalledOnce();
    expect(createNoteIdMock).toHaveBeenCalledTimes(
      allocatedBeforeCapacityCheck
    );
    expect(
      fresh.result.current.attachmentUploadErrorsByNodeId?.[root.id]
    ).toBe("Clipboard image retry data exceeds the 64 MiB memory limit.");

    let secondCompletion!: Promise<void>;
    act(() => {
      secondCompletion = fresh.result.current.actions.importClipboardImages!(
        root.id,
        pendingImageBatch("teardown-b", [1])
      );
    });
    await act(async () => Promise.resolve());
    expect(importImageNodeBytes).toHaveBeenCalledOnce();

    await act(async () =>
      fresh.result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    await act(async () => secondCompletion);

    expect(importImageNodeBytes).toHaveBeenCalledTimes(3);
    expect(importImageNodeBytes.mock.calls[1]?.[1]).toEqual(originalInput);
    expect(importImageNodeBytes.mock.calls[1]?.[2]).toBe(originalContext);
    expect(importImageNodeBytes.mock.calls[2]?.[1].afterId).toBe(
      firstImportedIds.at(-1)
    );
    expect(fresh.result.current.state.rootIds).toEqual([
      root.id,
      ...firstImportedIds,
      ...secondImportedIds
    ]);
  });

  it("retains failed clipboard blobs for retry and releases the retry target after success", async () => {
    const nodeId = "50000000-0000-4000-8000-000000000001";
    const attachmentId = "50000000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(nodeId)
      .mockReturnValueOnce(attachmentId);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const importImageNodeBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary byte failure"))
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: workspace([node({ id: "root" })]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [nodeId]
      }));
    const store = repository({ importImageNodeBytes });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(320));
    await act(async () =>
      result.current.actions.importClipboardImages!("root", [
        { originalName: "clip.png", mimeType: "image/png", blob }
      ])
    );
    const retryAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.root;
    expect(retryAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!("root", retryAttemptId)
    );

    expect(importImageNodeBytes.mock.calls[0]?.[1].items).toEqual([
      expect.objectContaining({ nodeId, attachmentId, blob })
    ]);
    expect(importImageNodeBytes.mock.calls[1]?.[1]).toEqual(
      importImageNodeBytes.mock.calls[0]?.[1]
    );
    expect(importImageNodeBytes.mock.calls[1]?.[1].items[0].blob).toBe(blob);
    expect(importImageNodeBytes.mock.calls[1]?.[2]).toBe(
      importImageNodeBytes.mock.calls[0]?.[2]
    );
    expect(result.current.attachmentUploadRetryAttemptIdsByNodeId?.root).toBeUndefined();
    await act(async () =>
      result.current.actions.retryImageUpload!("root", retryAttemptId)
    );
    expect(importImageNodeBytes).toHaveBeenCalledTimes(2);
    expect(store.importAttachmentBytes).not.toHaveBeenCalled();
  });

  it("cancels quietly and rejects an invalid measured width before allocating IDs", async () => {
    const openImageFiles = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(["/incoming/one.png"]);
    const importImageNodePaths = vi.fn();
    const store = repository({ importImageNodePaths });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.uploadImage!("root"));
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBeUndefined();
    expect(createNoteIdMock).not.toHaveBeenCalled();

    await act(async () => result.current.actions.uploadImage!("root"));
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBe(
      "Image area is not ready."
    );
    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
  });

  it("does not open the image picker when the vault root is blank", async () => {
    const openImageFiles = vi.fn().mockResolvedValue(["/incoming/one.png"]);
    const importImageNodePaths = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "   ",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(360));
    await act(async () => result.current.actions.uploadImage!("root"));

    expect(openImageFiles).not.toHaveBeenCalled();
    expect(createNoteIdMock).not.toHaveBeenCalled();
    expect(importImageNodePaths).not.toHaveBeenCalled();
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBeUndefined();
  });

  it("drops a repository result that resolves after the workspace generation changes", async () => {
    const oldRoot = node({ id: "old-root" });
    const newRoot = node({ id: "new-root" });
    const oldImport = deferred<NotesMutationResult>();
    createNoteIdMock.mockReturnValue(
      "60000000-0000-4000-8000-000000000001"
    );
    const importImageNodePaths = vi.fn().mockReturnValue(oldImport.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (vaultRoot) =>
        workspace([vaultRoot === "/old" ? oldRoot : newRoot])
      ),
      importImageNodePaths
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() => expect(result.current.state.nodesById[oldRoot.id]).toBeDefined());

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const pending = result.current.actions.importDroppedImagePaths!(oldRoot.id, [
      "/incoming/old.png"
    ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    rerender({ vaultRoot: "/new" });
    await waitFor(() => expect(result.current.state.nodesById[newRoot.id]).toBeDefined());

    oldImport.resolve({
      workspace: {
        nodes: [
          oldRoot,
          node({
            id: "60000000-0000-4000-8000-000000000001",
            nodeKind: "image"
          })
        ],
        attachmentsByNodeId: {
          "60000000-0000-4000-8000-000000000001": [
            attachment({
              id: "stale",
              nodeId: "60000000-0000-4000-8000-000000000001"
            })
          ]
        }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: ["60000000-0000-4000-8000-000000000001"]
    });
    await act(async () => pending);

    expect(result.current.state.nodesById[newRoot.id]).toBeDefined();
    expect(result.current.state.nodesById[oldRoot.id]).toBeUndefined();
    expect(result.current.state.attachmentsByNodeId[oldRoot.id]).toBeUndefined();
  });

  it.each(["picker", "drop", "clipboard"] as const)(
    "preserves focus, caret, selection, selectedId, and collapse after a %s failure",
    async (source) => {
      const root = node({ id: "root", isCollapsed: true });
      createNoteIdMock.mockReturnValue(
        "70000000-0000-4000-8000-000000000001"
      );
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
        importImageNodePaths: vi.fn().mockRejectedValue(new Error("path failed")),
        importImageNodeBytes: vi.fn().mockRejectedValue(new Error("bytes failed"))
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: "/vault",
          repository: store,
          attachmentUi: mockAttachmentUi(
            source === "picker"
              ? vi.fn().mockRejectedValue(new Error("picker failed"))
              : vi.fn().mockResolvedValue(null)
          )
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
      const input = document.createElement("textarea");
      input.value = "abcdef";
      document.body.append(input);
      input.focus();
      input.setSelectionRange(2, 5);
      const selectedId = result.current.state.selectedId;
      const collapsed = result.current.state.nodesById[root.id].isCollapsed;

      await act(async () => {
        if (source === "picker") {
          await result.current.actions.uploadImage!(root.id);
        } else if (source === "drop") {
          await result.current.actions.importDroppedImagePaths!(root.id, [
            "/incoming/one.png"
          ]);
        } else {
          await result.current.actions.importClipboardImages!(root.id, [
            {
              originalName: "clip.png",
              mimeType: "image/png",
              blob: new Blob(["image"], { type: "image/png" })
            }
          ]);
        }
      });

      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(5);
      expect(result.current.state.selectedId).toBe(selectedId);
      expect(result.current.state.nodesById[root.id].isCollapsed).toBe(collapsed);
      input.remove();
    }
  );

  it("imports a selected image atomically through the injected UI boundary", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const imageNodeId = "8f257d31-d255-4fc8-89dc-4e3b30f24a6e";
    const attachmentId = "8f257d31-d255-4fc8-89dc-4e3b30f24a6f";
    const imported = attachment({
      id: attachmentId,
      nodeId: imageNodeId
    });
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const attachmentUi = {
      openImageFiles: vi.fn().mockResolvedValue(["/incoming/diagram.png"]),
      saveImageFile: vi.fn().mockResolvedValue(null),
      subscribeToImageDrop: vi.fn().mockResolvedValue(vi.fn())
    };
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importImageNodePaths: vi.fn().mockImplementation(
        async (_vaultRoot, _input, context) => ({
          workspace: {
            nodes: [
              root,
              node({
                id: imageNodeId,
                nodeKind: "image",
                sortKey: 2048,
                title: "diagram.png"
              })
            ],
            attachmentsByNodeId: { [imageNodeId]: [imported] }
          },
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [imageNodeId]
        })
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.uploadImage).toBeTypeOf("function");
    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () => result.current.actions.uploadImage!(root.id));

    expect(attachmentUi.openImageFiles).toHaveBeenCalledOnce();
    expect(store.importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      {
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: imageNodeId,
            attachmentId,
            sourcePath: "/incoming/diagram.png"
          }
        ],
        initialMaxDisplayWidth: 480
      },
      historyContext("attachment-import")
    );
    expect(store.importAttachmentPaths).not.toHaveBeenCalled();
    expect(result.current.state.attachmentsByNodeId[imageNodeId]).toEqual([
      imported
    ]);
    expect(result.current.state.selectedId).toBe(imageNodeId);
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
  });

  it("keeps the measured 480px import width stable while the picker is open", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const picker = deferred<string | null>();
    const imageNodeId = "1c17ba74-a617-45e7-9e21-74068b63befe";
    const attachmentId = "1c17ba74-a617-45e7-9e21-74068b63beff";
    const imported = attachment({
      id: attachmentId,
      nodeId: imageNodeId,
      intrinsicWidth: 1200,
      displayWidth: 480
    });
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const importImageNodePaths = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root, node({ id: imageNodeId, nodeKind: "image" })],
          attachmentsByNodeId: { [imageNodeId]: [imported] }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [imageNodeId]
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(
          vi.fn().mockReturnValue(
            picker.promise.then((path) => (path === null ? null : [path]))
          )
        )
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const upload = result.current.actions.uploadImage!(root.id);
    act(() => result.current.actions.setImageImportMaxDisplayWidth(700));
    await act(async () => picker.resolve("/incoming/wide.png"));
    await act(async () => upload);

    expect(importImageNodePaths).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({ initialMaxDisplayWidth: 480 }),
      historyContext("attachment-import")
    );
  });

  it("serializes same-node batches before retrying the failed next path", async () => {
    const root = node({ id: "root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    const openImageFiles = vi
      .fn()
      .mockResolvedValueOnce(["/incoming/first.png"])
      .mockResolvedValueOnce(["/incoming/second.png"])
      .mockResolvedValue(null);
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: workspace([root]),
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: []
      }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: mockAttachmentUi(openImageFiles)
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const first = result.current.actions.uploadImage!(root.id);
    const second = result.current.actions.uploadImage!(root.id);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(importImageNodePaths).toHaveBeenCalledTimes(1);
    firstImport.resolve({
      workspace: { nodes: [root], attachmentsByNodeId: {} },
      historyEntryId: null,
      ...historyState(),
      canUndo: true,
      canRedo: false
    });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
    expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ sourcePath: "/incoming/second.png" })
        ]
      })
    );
    secondImport.reject(new Error("second failed"));
    await act(async () => Promise.all([first, second]));

    const visibleAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(visibleAttemptId).toBeDefined();
    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, visibleAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(3);
    expect(importImageNodePaths.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ sourcePath: "/incoming/second.png" })
        ]
      })
    );
    expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(
      importImageNodePaths.mock.calls[1]?.[2]
    );
  });

  it("rebases queued same-marker image batches after the prior imported tail and retries that exact request", async () => {
    const root = node({ id: "root" });
    const ids = [
      "71000000-0000-4000-8000-000000000001",
      "71000000-0000-4000-8000-000000000002",
      "71000000-0000-4000-8000-000000000003",
      "71000000-0000-4000-8000-000000000004"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3]);
    const firstImage = node({
      id: ids[0],
      nodeKind: "image",
      sortKey: 2048,
      title: "first.png"
    });
    const secondImage = node({
      id: ids[2],
      nodeKind: "image",
      sortKey: 3072,
      title: "second.png"
    });
    const firstAttachment = attachment({
      id: ids[1],
      nodeId: ids[0],
      originalName: "first.png"
    });
    const secondAttachment = attachment({
      id: ids[3],
      nodeId: ids[2],
      originalName: "second.png",
      contentHash: "b".repeat(64),
      relativePath: `notes-assets/${"b".repeat(64)}.png`
    });
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementation(async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[0]]: [firstAttachment],
            [ids[2]]: [secondAttachment]
          }
        },
        historyEntryId: context?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[2]]
      }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const first = result.current.actions.importDroppedImagePaths!(root.id, [
      "/incoming/first.png"
    ]);
    const second = result.current.actions.importDroppedImagePaths!(root.id, [
      "/incoming/second.png"
    ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(1));

    firstImport.resolve({
      workspace: {
        nodes: [root, firstImage],
        attachmentsByNodeId: { [ids[0]]: [firstAttachment] }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [ids[0]]
    });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));

    expect(importImageNodePaths.mock.calls[0]?.[1]).toEqual({
      parentId: null,
      afterId: root.id,
      items: [
        {
          nodeId: ids[0],
          attachmentId: ids[1],
          sourcePath: "/incoming/first.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });
    expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual({
      parentId: null,
      afterId: ids[0],
      items: [
        {
          nodeId: ids[2],
          attachmentId: ids[3],
          sourcePath: "/incoming/second.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });

    secondImport.reject(new Error("second failed after rebase"));
    await act(async () => Promise.all([first, second]));
    const failedAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(failedAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, failedAttemptId)
    );

    expect(importImageNodePaths).toHaveBeenCalledTimes(3);
    expect(importImageNodePaths.mock.calls[2]?.[1]).toEqual(
      importImageNodePaths.mock.calls[1]?.[1]
    );
    expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(
      importImageNodePaths.mock.calls[1]?.[2]
    );
  });

  it("retains a running owner's insertion reservation until queued sibling imports settle", async () => {
    const root = node({ id: "root" });
    const ids = [
      "71100000-0000-4000-8000-000000000001",
      "71100000-0000-4000-8000-000000000002",
      "71100000-0000-4000-8000-000000000003",
      "71100000-0000-4000-8000-000000000004",
      "71100000-0000-4000-8000-000000000005",
      "71100000-0000-4000-8000-000000000006"
    ];
    for (const id of ids) {
      createNoteIdMock.mockReturnValueOnce(id);
    }
    const firstImage = node({
      id: ids[0]!,
      nodeKind: "image",
      sortKey: 2048,
      title: "first.png"
    });
    const secondImage = node({
      id: ids[2]!,
      nodeKind: "image",
      sortKey: 3072,
      title: "second.png"
    });
    const thirdImage = node({
      id: ids[4]!,
      nodeKind: "image",
      sortKey: 1536,
      title: "third.png"
    });
    const firstAttachment = attachment({
      id: ids[1]!,
      nodeId: ids[0]!,
      originalName: "first.png"
    });
    const secondAttachment = attachment({
      id: ids[3]!,
      nodeId: ids[2]!,
      originalName: "second.png"
    });
    const thirdAttachment = attachment({
      id: ids[5]!,
      nodeId: ids[4]!,
      originalName: "third.png"
    });
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    let activeWorkspace: NotesWorkspace = workspace([root]);
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[0]!]: [firstAttachment],
            [ids[2]!]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[2]!]
        };
      })
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, thirdImage, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[4]!]: [thirdAttachment],
            [ids[0]!]: [firstAttachment],
            [ids[2]!]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[4]!]
        };
      });
    const store = repository({
      loadWorkspace: vi.fn(async () => activeWorkspace),
      importImageNodePaths
    });
    const openedSessions: ReturnType<
      typeof notesWorkspaceCoordinatorRegistry.openSession
    >[] = [];
    const realOpenSession =
      notesWorkspaceCoordinatorRegistry.openSession.bind(
        notesWorkspaceCoordinatorRegistry
      );
    const openSessionSpy = vi
      .spyOn(notesWorkspaceCoordinatorRegistry, "openSession")
      .mockImplementation((options) => {
        const session = realOpenSession(options);
        openedSessions.push(session);
        return session;
      });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reservation-owner", repository: store })
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reservation-owner", repository: store })
    );
    openSessionSpy.mockRestore();
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });

    act(() => {
      owner.result.current.actions.setImageImportMaxDisplayWidth(480);
      sibling.result.current.actions.setImageImportMaxDisplayWidth(480);
    });
    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = owner.result.current.actions.importDroppedImagePaths!(
        root.id,
        ["/incoming/first.png"]
      );
      secondCompletion = sibling.result.current.actions.importDroppedImagePaths!(
        root.id,
        ["/incoming/second.png"]
      );
    });
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());

    let ownerCallerSettled = false;
    void firstCompletion.then(() => {
      ownerCallerSettled = true;
    });
    act(() => openedSessions[1]!.close());
    await act(async () => Promise.resolve());
    expect(ownerCallerSettled).toBe(false);

    activeWorkspace = {
      nodes: [root, firstImage],
      attachmentsByNodeId: { [ids[0]!]: [firstAttachment] }
    };
    await act(async () => {
      firstImport.resolve({
        workspace: activeWorkspace,
        historyEntryId:
          importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0]!]
      });
      await firstCompletion;
    });
    expect(ownerCallerSettled).toBe(true);
    owner.unmount();
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
    const firstSecondInput = importImageNodePaths.mock.calls[1]?.[1];
    const secondHistory = importImageNodePaths.mock.calls[1]?.[2];

    secondImport.reject(new Error("second import failed"));
    await act(async () => secondCompletion);
    const retryAttemptId =
      sibling.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(retryAttemptId).toBeDefined();

    await act(async () =>
      sibling.result.current.actions.retryImageUpload!(root.id, retryAttemptId)
    );
    const retriedSecondInput = importImageNodePaths.mock.calls[2]?.[1];
    expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(secondHistory);
    expect(retriedSecondInput).toEqual(firstSecondInput);
    expect(createNoteIdMock).toHaveBeenCalledTimes(4);

    await act(async () =>
      sibling.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/third.png"
      ])
    );

    expect(firstSecondInput).toEqual({
      parentId: null,
      afterId: ids[0],
      items: [
        {
          nodeId: ids[2],
          attachmentId: ids[3],
          sourcePath: "/incoming/second.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });
    expect(importImageNodePaths.mock.calls[3]?.[1]).toEqual({
      parentId: null,
      afterId: root.id,
      items: [
        {
          nodeId: ids[4],
          attachmentId: ids[5],
          sourcePath: "/incoming/third.png"
        }
      ],
      initialMaxDisplayWidth: 480
    });
    expect(createNoteIdMock).toHaveBeenCalledTimes(6);
    expect(sibling.result.current.state.rootIds).toEqual([
      root.id,
      ids[4],
      ids[0],
      ids[2]
    ]);

    sibling.unmount();
    await act(async () => Promise.resolve());
    expect(
      notesWorkspaceCoordinatorRegistry.hasCoordinator(
        store,
        "/reservation-owner"
      )
    ).toBe(false);
  });

  it.each(["success", "failure"] as const)(
    "retains A's committed tail when B reserves during A's pending projection %s",
    async (projectionOutcome) => {
      const root = node({ id: "root", isStarred: true });
      const outside = node({ id: "outside", sortKey: 4096 });
      const ids = [
        "71200000-0000-4000-8000-000000000001",
        "71200000-0000-4000-8000-000000000002",
        "71200000-0000-4000-8000-000000000003",
        "71200000-0000-4000-8000-000000000004",
        "71200000-0000-4000-8000-000000000005",
        "71200000-0000-4000-8000-000000000006"
      ];
      for (const id of ids) {
        createNoteIdMock.mockReturnValueOnce(id);
      }
      const firstImage = node({
        id: ids[0]!,
        nodeKind: "image",
        sortKey: 2048,
        title: "first.png"
      });
      const secondImage = node({
        id: ids[2]!,
        nodeKind: "image",
        sortKey: 3072,
        title: "second.png"
      });
      const thirdImage = node({
        id: ids[4]!,
        nodeKind: "image",
        sortKey: 1536,
        title: "third.png"
      });
      const firstAttachment = attachment({
        id: ids[1]!,
        nodeId: ids[0]!,
        originalName: "first.png"
      });
      const secondAttachment = attachment({
        id: ids[3]!,
        nodeId: ids[2]!,
        originalName: "second.png"
      });
      const thirdAttachment = attachment({
        id: ids[5]!,
        nodeId: ids[4]!,
        originalName: "third.png"
      });
      const firstNative = deferred<NotesMutationResult>();
      const secondNative = deferred<NotesMutationResult>();
      const firstProjection = deferred<NotesWorkspace>();
      const projectionRequested = vi.fn();
      let deferNextStarredProjection = false;
      let activeWorkspace: NotesWorkspace = workspace([root, outside]);
      let filteredWorkspace: NotesWorkspace = workspace([root]);
      const loadWorkspace = vi.fn((_vaultRoot, scope) => {
        if (scope.kind === "starred" && deferNextStarredProjection) {
          deferNextStarredProjection = false;
          projectionRequested();
          return firstProjection.promise;
        }
        return Promise.resolve(
          scope.kind === "starred" ? filteredWorkspace : activeWorkspace
        );
      });
      const importImageNodePaths = vi
        .fn()
        .mockReturnValueOnce(firstNative.promise)
        .mockReturnValueOnce(secondNative.promise)
        .mockImplementationOnce(async (_vaultRoot, _input, context) => {
          activeWorkspace = {
            nodes: [root, firstImage, secondImage, outside],
            attachmentsByNodeId: {
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          filteredWorkspace = {
            nodes: [root, firstImage, secondImage],
            attachmentsByNodeId: {
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          return {
            workspace: activeWorkspace,
            historyEntryId: context?.entryId ?? null,
            ...historyState(),
            canUndo: true,
            canRedo: false,
            importedRootIds: [ids[2]!]
          };
        })
        .mockImplementationOnce(async (_vaultRoot, _input, context) => {
          activeWorkspace = {
            nodes: [root, thirdImage, firstImage, secondImage, outside],
            attachmentsByNodeId: {
              [ids[4]!]: [thirdAttachment],
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          filteredWorkspace = {
            nodes: [root, thirdImage, firstImage, secondImage],
            attachmentsByNodeId: {
              [ids[4]!]: [thirdAttachment],
              [ids[0]!]: [firstAttachment],
              [ids[2]!]: [secondAttachment]
            }
          };
          return {
            workspace: activeWorkspace,
            historyEntryId: context?.entryId ?? null,
            ...historyState(),
            canUndo: true,
            canRedo: false,
            importedRootIds: [ids[4]!]
          };
        });
      const store = repository({ loadWorkspace, importImageNodePaths });
      const secondPane = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/projection-reservation", repository: store })
      );
      const firstPane = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/projection-reservation", repository: store })
      );
      await waitFor(() => {
        expect(firstPane.result.current.status).toBe("ready");
        expect(secondPane.result.current.status).toBe("ready");
      });
      await act(async () => {
        await firstPane.result.current.actions.selectLibraryView("starred");
        await secondPane.result.current.actions.selectLibraryView("starred");
      });
      act(() => {
        firstPane.result.current.actions.setImageImportMaxDisplayWidth(480);
        secondPane.result.current.actions.setImageImportMaxDisplayWidth(480);
      });

      let firstCompletion!: Promise<void>;
      act(() => {
        firstCompletion =
          firstPane.result.current.actions.importDroppedImagePaths!(root.id, [
            "/incoming/first.png"
          ]);
      });
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());

      activeWorkspace = {
        nodes: [root, firstImage, outside],
        attachmentsByNodeId: { [ids[0]!]: [firstAttachment] }
      };
      filteredWorkspace = {
        nodes: [root, firstImage],
        attachmentsByNodeId: { [ids[0]!]: [firstAttachment] }
      };
      deferNextStarredProjection = true;
      firstNative.resolve({
        workspace: activeWorkspace,
        historyEntryId:
          importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [ids[0]!]
      });
      await waitFor(() => expect(projectionRequested).toHaveBeenCalledOnce());

      let secondCompletion!: Promise<void>;
      act(() => {
        secondCompletion =
          firstPane.result.current.actions.importDroppedImagePaths!(root.id, [
            "/incoming/second.png"
          ]);
      });
      await act(async () => Promise.resolve());
      expect(importImageNodePaths).toHaveBeenCalledTimes(1);

      if (projectionOutcome === "success") {
        firstProjection.resolve(filteredWorkspace);
      } else {
        firstProjection.reject(new Error("starred projection failed"));
      }
      await act(async () => firstCompletion);
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
      const secondInput = importImageNodePaths.mock.calls[1]?.[1];
      const secondHistory = importImageNodePaths.mock.calls[1]?.[2];

      secondNative.reject(new Error("second native import failed"));
      await act(async () => secondCompletion);
      const retryAttemptId =
        firstPane.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
          root.id
        ];
      expect(retryAttemptId).toBeDefined();

      await act(async () =>
        firstPane.result.current.actions.retryImageUpload!(
          root.id,
          retryAttemptId
        )
      );
      expect(importImageNodePaths.mock.calls[2]?.[1]).toEqual(secondInput);
      expect(importImageNodePaths.mock.calls[2]?.[2]).toBe(secondHistory);
      expect(createNoteIdMock).toHaveBeenCalledTimes(4);

      await act(async () =>
        firstPane.result.current.actions.importDroppedImagePaths!(root.id, [
          "/incoming/third.png"
        ])
      );

      expect(secondInput).toEqual({
        parentId: null,
        afterId: ids[0],
        items: [
          {
            nodeId: ids[2],
            attachmentId: ids[3],
            sourcePath: "/incoming/second.png"
          }
        ],
        initialMaxDisplayWidth: 480
      });
      expect(importImageNodePaths.mock.calls[3]?.[1]).toEqual({
        parentId: null,
        afterId: root.id,
        items: [
          {
            nodeId: ids[4],
            attachmentId: ids[5],
            sourcePath: "/incoming/third.png"
          }
        ],
        initialMaxDisplayWidth: 480
      });
      expect(createNoteIdMock).toHaveBeenCalledTimes(6);
      expect(firstPane.result.current.state.rootIds).toEqual([
        root.id,
        ids[4],
        ids[0],
        ids[2]
      ]);

      firstPane.unmount();
      secondPane.unmount();
      await act(async () => Promise.resolve());
      expect(
        notesWorkspaceCoordinatorRegistry.hasCoordinator(
          store,
          "/projection-reservation"
        )
      ).toBe(false);
    }
  );

  it("shares same-marker import order across panes when a filtered projection omits the prior tail", async () => {
    const root = node({ id: "root", isStarred: true });
    const ids = [
      "73000000-0000-4000-8000-000000000001",
      "73000000-0000-4000-8000-000000000002",
      "73000000-0000-4000-8000-000000000003",
      "73000000-0000-4000-8000-000000000004",
      "73000000-0000-4000-8000-000000000005",
      "73000000-0000-4000-8000-000000000006"
    ];
    createNoteIdMock
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1])
      .mockReturnValueOnce(ids[2])
      .mockReturnValueOnce(ids[3])
      .mockReturnValueOnce(ids[4])
      .mockReturnValueOnce(ids[5]);
    const firstImage = node({
      id: ids[0],
      nodeKind: "image",
      sortKey: 2048,
      title: "first.png"
    });
    const secondImage = node({
      id: ids[2],
      nodeKind: "image",
      sortKey: 3072,
      title: "second.png"
    });
    const laterImage = node({
      id: ids[4],
      nodeKind: "image",
      sortKey: 1536,
      title: "later.png"
    });
    const firstAttachment = attachment({
      id: ids[1],
      nodeId: ids[0],
      originalName: "first.png"
    });
    const secondAttachment = attachment({
      id: ids[3],
      nodeId: ids[2],
      originalName: "second.png",
      contentHash: "b".repeat(64),
      relativePath: `notes-assets/${"b".repeat(64)}.png`
    });
    const laterAttachment = attachment({
      id: ids[5],
      nodeId: ids[4],
      originalName: "later.png",
      contentHash: "c".repeat(64),
      relativePath: `notes-assets/${"c".repeat(64)}.png`
    });
    const firstImport = deferred<NotesMutationResult>();
    let activeWorkspace: NotesWorkspace = workspace([root]);
    const importImageNodePaths = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[0]]: [firstAttachment],
            [ids[2]]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[2]]
        };
      })
      .mockImplementationOnce(async (_vaultRoot, _input, context) => {
        activeWorkspace = {
          nodes: [root, laterImage, firstImage, secondImage],
          attachmentsByNodeId: {
            [ids[4]]: [laterAttachment],
            [ids[0]]: [firstAttachment],
            [ids[2]]: [secondAttachment]
          }
        };
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [ids[4]]
        };
      });
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "starred" ? workspace([root]) : activeWorkspace
      ),
      importImageNodePaths
    });
    const filteredPane = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(filteredPane.result.current.status).toBe("ready"));
    await act(async () =>
      filteredPane.result.current.actions.selectLibraryView("starred")
    );
    const activePane = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(activePane.result.current.status).toBe("ready"));
    expect(activePane.result.current.libraryView).toBe("starred");
    await act(async () =>
      activePane.result.current.actions.selectLibraryView("all")
    );

    act(() => {
      activePane.result.current.actions.setImageImportMaxDisplayWidth(480);
      filteredPane.result.current.actions.setImageImportMaxDisplayWidth(480);
    });
    const first = activePane.result.current.actions.importDroppedImagePaths!(
      root.id,
      ["/incoming/first.png"]
    );
    const second = activePane.result.current.actions.importDroppedImagePaths!(
      root.id,
      ["/incoming/second.png"]
    );
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(1));

    activeWorkspace = {
      nodes: [root, firstImage],
      attachmentsByNodeId: { [ids[0]]: [firstAttachment] }
    };
    firstImport.resolve({
      workspace: activeWorkspace,
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [ids[0]]
    });
    await act(async () => Promise.all([first, second]));

    expect(filteredPane.result.current.state.nodesById[ids[0]]).toBeUndefined();
    expect(importImageNodePaths.mock.calls[1]?.[1]).toMatchObject({
      parentId: null,
      afterId: ids[0],
      items: [
        expect.objectContaining({
          nodeId: ids[2],
          sourcePath: "/incoming/second.png"
        })
      ]
    });

    await waitFor(() =>
      expect(activePane.result.current.state.nodesById[ids[2]]).toBeDefined()
    );
    await act(async () =>
      activePane.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/later.png"
      ])
    );
    expect(importImageNodePaths.mock.calls[2]?.[1]).toMatchObject({
      parentId: null,
      afterId: root.id,
      items: [
        expect.objectContaining({
          nodeId: ids[4],
          sourcePath: "/incoming/later.png"
        })
      ]
    });

    activePane.unmount();
    filteredPane.unmount();
  });

  it("broadcasts committed image import authority when the originating pane unmounts before the response settles", async () => {
    const root = node({ id: "root" });
    const imageNodeId = "72000000-0000-4000-8000-000000000001";
    const attachmentId = "72000000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const importedImage = node({
      id: imageNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "committed.png"
    });
    const importedAttachment = attachment({
      id: attachmentId,
      nodeId: imageNodeId,
      originalName: "committed.png"
    });
    const importResponse = deferred<NotesMutationResult>();
    const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([root])),
      importImageNodePaths
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));

    act(() =>
      owner.result.current.actions.setImageImportMaxDisplayWidth(480)
    );
    const completion =
      owner.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/committed.png"
      ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    owner.unmount();

    importResponse.resolve({
      workspace: {
        nodes: [root, importedImage],
        attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [imageNodeId]
    });
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById[imageNodeId]).toMatchObject({
        id: imageNodeId,
        nodeKind: "image"
      })
    );
    expect(sibling.result.current.state.attachmentsByNodeId[imageNodeId]).toEqual(
      [importedAttachment]
    );
    expect(sibling.result.current.canUndo).toBe(true);
    const committedEntryId = importImageNodePaths.mock.calls[0]?.[2]?.entryId;
    expect(notesHistorySpies.discard).not.toHaveBeenCalledWith(committedEntryId);
    expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
      committedEntryId,
      expect.anything(),
      expect.anything()
    );
    sibling.unmount();
  });

  it.each(["starred", "tags"] as const)(
    "projects an ownerless image import through its captured %s scope",
    async (scopeKind) => {
      const root = node({
        id: "root",
        title: scopeKind === "tags" ? "#Work root" : "Root",
        isStarred: scopeKind === "starred"
      });
      const outside = node({ id: "outside", sortKey: 2048 });
      const imageNodeId = "72100000-0000-4000-8000-000000000001";
      const attachmentId = "72100000-0000-4000-8000-000000000002";
      createNoteIdMock
        .mockReturnValueOnce(imageNodeId)
        .mockReturnValueOnce(attachmentId);
      const importResponse = deferred<NotesMutationResult>();
      const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
      const activeWorkspace = workspace([root, outside]);
      let scopedWorkspace = workspace([root]);
      const expectedScope =
        scopeKind === "tags"
          ? {
              kind: "tags" as const,
              tags: [{ prefix: "#" as const, normalizedTag: "work" }]
            }
          : { kind: "starred" as const };
      const isExpectedScope = (scope: unknown): boolean =>
        typeof scope === "object" &&
        scope !== null &&
        "kind" in scope &&
        (scope as { kind?: unknown }).kind === scopeKind;
      const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
        isExpectedScope(scope) ? scopedWorkspace : activeWorkspace
      );
      const store = repository({
        loadWorkspace,
        importImageNodePaths,
        listTagsWithCounts: vi.fn().mockResolvedValue([
          {
            prefix: "#",
            normalizedTag: "work",
            displayTag: "Work",
            count: 1
          }
        ])
      });
      const owner = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/ownerless-import", repository: store })
      );
      await waitFor(() => expect(owner.result.current.status).toBe("ready"));
      if (scopeKind === "tags") {
        await act(async () =>
          owner.result.current.actions.toggleTagFilter({
            prefix: "#",
            normalizedTag: "work"
          })
        );
      } else {
        await act(async () =>
          owner.result.current.actions.selectLibraryView("starred")
        );
      }
      expect(
        loadWorkspace.mock.calls.filter(([, scope]) => isExpectedScope(scope))
      ).toHaveLength(1);

      act(() =>
        owner.result.current.actions.setImageImportMaxDisplayWidth(480)
      );
      const completion =
        owner.result.current.actions.importDroppedImagePaths!(root.id, [
          "/incoming/captured.png"
        ]);
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
      owner.unmount();
      scopedWorkspace = workspace([
        root,
        node({
          id: "projected-filtered-image",
          nodeKind: "image",
          sortKey: 2048,
          title: "captured.png",
          isStarred: scopeKind === "starred"
        })
      ]);
      importResponse.resolve({
        workspace: {
          nodes: [
            root,
            outside,
            node({
              id: imageNodeId,
              nodeKind: "image",
              sortKey: 3072,
              title: "captured.png"
            })
          ]
        },
        historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
        ...historyState(),
        canUndo: true,
        canRedo: false,
        importedRootIds: [imageNodeId]
      });
      await act(async () => completion);

      const scopedCalls = loadWorkspace.mock.calls.filter(([, scope]) =>
        isExpectedScope(scope)
      );
      expect(scopedCalls).toHaveLength(2);
      expect(scopedCalls[1]?.[1]).toEqual(expectedScope);
      expect(notesHistorySpies.discard).not.toHaveBeenCalledWith(
        importImageNodePaths.mock.calls[0]?.[2]?.entryId
      );
      expect(notesHistorySpies.acceptMutationResult).toHaveBeenCalledWith(
        importImageNodePaths.mock.calls[0]?.[2]?.entryId,
        expect.anything(),
        expect.anything()
      );
    }
  );

  it("keeps a dirty-barrier image projection in its captured tag scope across a vault reset", async () => {
    const root = node({ id: "root", title: "#Work root" });
    const outside = node({ id: "outside", sortKey: 2048 });
    const imageNodeId = "72400000-0000-4000-8000-000000000001";
    const attachmentId = "72400000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const rawImage = node({
      id: imageNodeId,
      nodeKind: "image",
      sortKey: 3072,
      title: "raw-active.png"
    });
    const projectedImage = node({
      id: imageNodeId,
      nodeKind: "image",
      sortKey: 2048,
      title: "#Work projected.png"
    });
    const importedAttachment = attachment({
      id: attachmentId,
      nodeId: imageNodeId,
      originalName: "projected.png"
    });
    const activeWorkspace = workspace([root, outside]);
    const staleFilteredWorkspace = workspace([root]);
    const projectedFilteredWorkspace: NotesWorkspace = {
      nodes: [root, projectedImage],
      attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
    };
    const draftWrite = deferred<NotesWorkspace>();
    const importResponse = deferred<NotesMutationResult>();
    let nextTagProjection: NotesWorkspace | null = null;
    const loadWorkspace = vi.fn(async (loadedVaultRoot, scope) => {
      if (loadedVaultRoot === "/scope-new") {
        return workspace([node({ id: "new-root" })]);
      }
      if (scope.kind === "tags") {
        if (nextTagProjection) {
          const projection = nextTagProjection;
          nextTagProjection = null;
          return projection;
        }
        return staleFilteredWorkspace;
      }
      return activeWorkspace;
    });
    const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
    const store = repository({
      loadWorkspace,
      updateNode: vi.fn().mockReturnValue(draftWrite.promise),
      importImageNodePaths,
      listTagsWithCounts: vi.fn().mockResolvedValue([
        {
          prefix: "#",
          normalizedTag: "work",
          displayTag: "Work",
          count: 1
        }
      ])
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/scope-old", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () =>
      sibling.result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    const owner = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/scope-old" } }
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    expect(owner.result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);

    act(() => {
      owner.result.current.actions.setImageImportMaxDisplayWidth(480);
      owner.result.current.actions.updateNodeDraft(root.id, {
        title: "#Work edited",
        note: ""
      , imageOffsetUtf16: 0});
    });
    let importCompletion!: Promise<void>;
    act(() => {
      importCompletion =
        owner.result.current.actions.importDroppedImagePaths!(root.id, [
          "/incoming/projected.png"
        ]);
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(importImageNodePaths).not.toHaveBeenCalled();

    draftWrite.resolve(activeWorkspace);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    const exposedFilters = owner.result.current.activeTagFilters as Array<{
      prefix: "#" | "@";
      normalizedTag: string;
    }>;
    exposedFilters[0]!.normalizedTag = "changed-by-alias";
    owner.rerender({ vaultRoot: "/scope-new" });
    await waitFor(() =>
      expect(owner.result.current.state.nodesById["new-root"]).toBeDefined()
    );

    const oldTagLoadsBeforeProjection = loadWorkspace.mock.calls.filter(
      ([loadedVaultRoot, scope]) =>
        loadedVaultRoot === "/scope-old" && scope.kind === "tags"
    ).length;
    nextTagProjection = projectedFilteredWorkspace;
    importResponse.resolve({
      workspace: {
        nodes: [root, outside, rawImage],
        attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [imageNodeId]
    });
    await act(async () => importCompletion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById[imageNodeId]?.title).toBe(
        projectedImage.title
      )
    );
    expect(
      loadWorkspace.mock.calls.filter(
        ([loadedVaultRoot, scope]) =>
          loadedVaultRoot === "/scope-old" && scope.kind === "tags"
      )
    ).toHaveLength(oldTagLoadsBeforeProjection + 1);
    expect(sibling.result.current.state.nodesById.outside).toBeUndefined();

    owner.unmount();
    sibling.unmount();
  });

  it.each(["starred", "tags"] as const)(
    "refreshes a failed Active image retry to the current %s scope before owner unmount",
    async (scopeKind) => {
      const target = node({
        id: "root",
        title: scopeKind === "tags" ? "#Work target" : "Target",
        isStarred: scopeKind === "starred"
      });
      const outside = node({ id: "outside", sortKey: 2048 });
      const imageNodeId = "72300000-0000-4000-8000-000000000001";
      const attachmentId = "72300000-0000-4000-8000-000000000002";
      createNoteIdMock
        .mockReturnValueOnce(imageNodeId)
        .mockReturnValueOnce(attachmentId);
      const importedAttachment = attachment({
        id: attachmentId,
        nodeId: imageNodeId,
        originalName: "retried.png"
      });
      const rawImportedImage = node({
        id: imageNodeId,
        nodeKind: "image",
        sortKey: 3072,
        title: "raw-active.png"
      });
      const filteredImportedImage = node({
        id: imageNodeId,
        nodeKind: "image",
        sortKey: 3072,
        title: scopeKind === "tags" ? "#Work retried.png" : "retried.png",
        isStarred: scopeKind === "starred"
      });
      const activeWorkspace = workspace([target, outside]);
      let scopedWorkspace: NotesWorkspace = workspace([target]);
      const retryResponse = deferred<NotesMutationResult>();
      const importImageNodePaths = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary import failure"))
        .mockReturnValueOnce(retryResponse.promise);
      const expectedScope =
        scopeKind === "tags"
          ? {
              kind: "tags" as const,
              tags: [{ prefix: "#" as const, normalizedTag: "work" }]
            }
          : { kind: "starred" as const };
      const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
        scope.kind === scopeKind ? scopedWorkspace : activeWorkspace
      );
      const store = repository({
        loadWorkspace,
        importImageNodePaths,
        listTagsWithCounts: vi.fn().mockResolvedValue([
          {
            prefix: "#",
            normalizedTag: "work",
            displayTag: "Work",
            count: 1
          }
        ])
      });
      const vaultRoot = `/retry-current-${scopeKind}`;
      const sibling = renderHook(() =>
        useNotesWorkspace({ vaultRoot, repository: store })
      );
      const owner = renderHook(() =>
        useNotesWorkspace({ vaultRoot, repository: store })
      );
      await waitFor(() => {
        expect(owner.result.current.status).toBe("ready");
        expect(sibling.result.current.status).toBe("ready");
      });

      act(() =>
        owner.result.current.actions.setImageImportMaxDisplayWidth(480)
      );
      await act(async () =>
        owner.result.current.actions.importDroppedImagePaths!(target.id, [
          "/incoming/retried.png"
        ])
      );
      const retryAttemptId =
        owner.result.current.attachmentUploadRetryAttemptIdsByNodeId?.[
          target.id
        ];
      expect(retryAttemptId).toBeDefined();

      if (scopeKind === "tags") {
        await act(async () => {
          await owner.result.current.actions.toggleTagFilter({
            prefix: "#",
            normalizedTag: "work"
          });
        });
      } else {
        await act(async () => {
          await owner.result.current.actions.selectLibraryView("starred");
        });
      }
      expect(owner.result.current.state.nodesById[target.id]).toBeDefined();
      expect(sibling.result.current.state.nodesById[target.id]).toBeDefined();
      loadWorkspace.mockClear();
      scopedWorkspace = {
        nodes: [target, filteredImportedImage],
        attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
      };

      let retryCompletion!: Promise<void>;
      act(() => {
        retryCompletion = owner.result.current.actions.retryImageUpload!(
          target.id,
          retryAttemptId
        );
      });
      await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledTimes(2));
      expect(importImageNodePaths.mock.calls[1]?.[1]).toEqual(
        importImageNodePaths.mock.calls[0]?.[1]
      );
      expect(importImageNodePaths.mock.calls[1]?.[2]).toBe(
        importImageNodePaths.mock.calls[0]?.[2]
      );
      expect(createNoteIdMock).toHaveBeenCalledTimes(2);
      owner.unmount();
      await act(async () => {
        retryResponse.resolve({
          workspace: {
            nodes: [target, outside, rawImportedImage],
            attachmentsByNodeId: { [imageNodeId]: [importedAttachment] }
          },
          historyEntryId:
            importImageNodePaths.mock.calls[1]?.[2]?.entryId ?? null,
          ...historyState(),
          canUndo: true,
          canRedo: false,
          importedRootIds: [imageNodeId]
        });
        await retryCompletion;
      });

      expect(loadWorkspace).toHaveBeenCalledOnce();
      expect(loadWorkspace).toHaveBeenCalledWith(vaultRoot, expectedScope);
      await waitFor(() =>
        expect(sibling.result.current.state.rootIds).toEqual([
          target.id,
          imageNodeId
        ])
      );
      expect(sibling.result.current.state.nodesById.outside).toBeUndefined();
      expect(sibling.result.current.state.nodesById[imageNodeId]?.title).toBe(
        filteredImportedImage.title
      );
      sibling.unmount();
    }
  );

  it("invalidates and reloads a filtered sibling when an ownerless image import projection fails", async () => {
    const root = node({ id: "root", isStarred: true });
    const outside = node({ id: "outside", sortKey: 2048 });
    const imageNodeId = "72200000-0000-4000-8000-000000000001";
    const attachmentId = "72200000-0000-4000-8000-000000000002";
    createNoteIdMock
      .mockReturnValueOnce(imageNodeId)
      .mockReturnValueOnce(attachmentId);
    const importResponse = deferred<NotesMutationResult>();
    const importImageNodePaths = vi.fn().mockReturnValue(importResponse.promise);
    const activeWorkspace = workspace([root, outside]);
    const initialStarred = workspace([root]);
    const safeReload = workspace([node({ id: "safe-starred", isStarred: true })]);
    let starredLoads = 0;
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) => {
      if (scope?.kind !== "starred") {
        return activeWorkspace;
      }
      starredLoads += 1;
      if (starredLoads === 3) {
        throw new Error("projection failed");
      }
      return starredLoads >= 4 ? safeReload : initialStarred;
    });
    const store = repository({
      loadWorkspace,
      importImageNodePaths
    });
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/ownerless-projection-failure", repository: store })
    );
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));
    await act(async () =>
      sibling.result.current.actions.selectLibraryView("starred")
    );
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/ownerless-projection-failure", repository: store })
    );
    await waitFor(() => expect(owner.result.current.status).toBe("ready"));
    await act(async () => owner.result.current.actions.selectLibraryView("starred"));

    act(() =>
      owner.result.current.actions.setImageImportMaxDisplayWidth(480)
    );
    const completion =
      owner.result.current.actions.importDroppedImagePaths!(root.id, [
        "/incoming/failing-projection.png"
      ]);
    await waitFor(() => expect(importImageNodePaths).toHaveBeenCalledOnce());
    owner.unmount();
    importResponse.resolve({
      workspace: {
        nodes: [
          root,
          outside,
          node({
            id: imageNodeId,
            nodeKind: "image",
            sortKey: 3072,
            title: "failing-projection.png"
          })
        ]
      },
      historyEntryId: importImageNodePaths.mock.calls[0]?.[2]?.entryId ?? null,
      ...historyState(),
      canUndo: true,
      canRedo: false,
      importedRootIds: [imageNodeId]
    });
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.rootIds).toEqual(["safe-starred"])
    );
    expect(starredLoads).toBe(4);
    expect(sibling.result.current.state.nodesById.outside).toBeUndefined();
    expect(sibling.result.current.state.nodesById[imageNodeId]).toBeUndefined();
    sibling.unmount();
  });
});
