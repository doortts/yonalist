import { act, render, renderHook, waitFor } from "@testing-library/react";
import {
  StrictMode,
  Suspense,
  useEffect,
  useLayoutEffect,
  type PropsWithChildren
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NoteAttachment,
  NoteNode,
  NotesMutationResult,
  NotesStore,
  NotesWorkspace
} from "../../domain/notes";
import {
  useNotesWorkspace,
  type NotesWorkspaceActions,
  type UseNotesWorkspaceResult
} from "./useNotesWorkspace";

const createNoteIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../domain/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/notes")>()),
  createNoteId: createNoteIdMock
}));

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
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
    ...overrides
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
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

function strictMode({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

function suspenseMode({ children }: PropsWithChildren) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function repository(overrides: Partial<NotesStore> = {}): NotesStore {
  const empty = vi.fn().mockResolvedValue(workspace([]));
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
    createNode: empty,
    updateNode: empty,
    splitNode: empty,
    moveNode: empty,
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
      workspace: workspace([]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: false
    }),
    redo: vi.fn().mockResolvedValue({
      workspace: workspace([]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: false
    }),
    emptyTrash: empty,
    search: vi.fn().mockResolvedValue([]),
    listTags: vi.fn().mockResolvedValue([]),
    listTagsWithCounts: vi.fn().mockResolvedValue([]),
    deleteDatabase: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function historyContext(commandKind: string) {
  return expect.objectContaining({
    sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    entryId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    commandKind
  });
}

interface StartupCommandProps {
  actions: NotesWorkspaceActions;
  identity: string;
  onCompletion(completion: Promise<void>): void;
}

function LayoutStartupCommand({
  actions,
  identity,
  onCompletion
}: StartupCommandProps) {
  useLayoutEffect(() => {
    onCompletion(actions.createRoot());
  }, [actions, identity, onCompletion]);
  return null;
}

function PassiveStartupCommand({
  actions,
  identity,
  onCompletion
}: StartupCommandProps) {
  useEffect(() => {
    onCompletion(actions.createRoot());
  }, [actions, identity, onCompletion]);
  return null;
}

interface StartupHarnessProps {
  effect: "layout" | "passive";
  repository: NotesStore;
  vaultRoot: string;
  onCompletion(completion: Promise<void>): void;
  onWorkspace(workspace: UseNotesWorkspaceResult): void;
}

function StartupHarness({
  effect,
  repository: store,
  vaultRoot,
  onCompletion,
  onWorkspace
}: StartupHarnessProps) {
  const current = useNotesWorkspace({ vaultRoot, repository: store });
  onWorkspace(current);
  const Command = effect === "layout" ? LayoutStartupCommand : PassiveStartupCommand;
  return (
    <Command
      actions={current.actions}
      identity={vaultRoot}
      onCompletion={onCompletion}
    />
  );
}

describe("useNotesWorkspace", () => {
  beforeEach(() => {
    createNoteIdMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("imports a selected image atomically through the injected UI boundary", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const imported = attachment({
      id: "8f257d31-d255-4fc8-89dc-4e3b30f24a6e",
      nodeId: root.id
    });
    createNoteIdMock.mockReturnValue(imported.id);
    const attachmentUi = {
      openImageFile: vi.fn().mockResolvedValue("/incoming/diagram.png"),
      pathForDroppedFile: vi.fn()
    };
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importAttachment: vi.fn().mockImplementation(
        async (_vaultRoot, _input, context) => ({
          workspace: {
            nodes: [root],
            attachmentsByNodeId: { [root.id]: [imported] }
          },
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
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

    expect(attachmentUi.openImageFile).toHaveBeenCalledOnce();
    expect(store.importAttachment).toHaveBeenCalledWith(
      "/vault",
      {
        id: imported.id,
        nodeId: root.id,
        sourcePath: "/incoming/diagram.png",
        initialMaxDisplayWidth: 480
      },
      historyContext("attachment-import")
    );
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([
      imported
    ]);
    expect(result.current.attachmentUploadErrorsByNodeId?.[root.id]).toBeUndefined();
  });

  it("keeps the measured 480px import width stable while the picker is open", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const picker = deferred<string | null>();
    const imported = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id,
      intrinsicWidth: 1200,
      displayWidth: 480
    });
    createNoteIdMock.mockReturnValue(imported.id);
    const importAttachment = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root],
          attachmentsByNodeId: { [root.id]: [imported] }
        },
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importAttachment
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: {
          openImageFile: vi.fn().mockReturnValue(picker.promise),
          pathForDroppedFile: vi.fn()
        }
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const upload = result.current.actions.uploadImage!(root.id);
    act(() => result.current.actions.setImageImportMaxDisplayWidth(700));
    await act(async () => picker.resolve("/incoming/wide.png"));
    await act(async () => upload);

    expect(importAttachment).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({ initialMaxDisplayWidth: 480 }),
      historyContext("attachment-import")
    );
  });

  it("retries the failed path when an earlier same-node upload succeeds", async () => {
    const root = node({ id: "root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    const openImageFile = vi
      .fn()
      .mockResolvedValueOnce("/incoming/first.png")
      .mockResolvedValueOnce("/incoming/second.png")
      .mockResolvedValue(null);
    const importAttachment = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementation(async (_vaultRoot, input, context) => ({
        workspace: {
          nodes: [root],
          attachmentsByNodeId: {
            root: [attachment({ id: input.id, nodeId: "root" })]
          }
        },
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      }));
    const store = repository({ importAttachment });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: { openImageFile, pathForDroppedFile: vi.fn() }
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const first = result.current.actions.uploadImage!(root.id);
    const second = result.current.actions.uploadImage!(root.id);
    await waitFor(() => expect(importAttachment).toHaveBeenCalledTimes(1));
    firstImport.resolve({
      workspace: { nodes: [root], attachmentsByNodeId: {} },
      historyEntryId: null,
      canUndo: true,
      canRedo: false
    });
    await waitFor(() => expect(importAttachment).toHaveBeenCalledTimes(2));
    secondImport.reject(new Error("second failed"));
    await act(async () => Promise.all([first, second]));

    const visibleAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(visibleAttemptId).toBeDefined();
    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, visibleAttemptId)
    );

    expect(openImageFile).toHaveBeenCalledTimes(2);
    expect(importAttachment).toHaveBeenCalledTimes(3);
    expect(importAttachment.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ sourcePath: "/incoming/second.png" })
    );
  });

  it("keeps an earlier failed same-node upload retryable after a later success", async () => {
    const root = node({ id: "root" });
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `10000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const firstImport = deferred<NotesMutationResult>();
    const secondImport = deferred<NotesMutationResult>();
    const openImageFile = vi
      .fn()
      .mockResolvedValueOnce("/incoming/first.png")
      .mockResolvedValueOnce("/incoming/second.png")
      .mockResolvedValue(null);
    const importAttachment = vi
      .fn()
      .mockReturnValueOnce(firstImport.promise)
      .mockReturnValueOnce(secondImport.promise)
      .mockImplementation(async (_vaultRoot, input, context) => ({
        workspace: {
          nodes: [root],
          attachmentsByNodeId: {
            root: [attachment({ id: input.id, nodeId: "root" })]
          }
        },
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      }));
    const store = repository({ importAttachment });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: { openImageFile, pathForDroppedFile: vi.fn() }
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const first = result.current.actions.uploadImage!(root.id);
    const second = result.current.actions.uploadImage!(root.id);
    await waitFor(() => expect(importAttachment).toHaveBeenCalledTimes(1));
    firstImport.reject(new Error("first failed"));
    await waitFor(() => expect(importAttachment).toHaveBeenCalledTimes(2));
    secondImport.resolve({
      workspace: { nodes: [root], attachmentsByNodeId: {} },
      historyEntryId: null,
      canUndo: true,
      canRedo: false
    });
    await act(async () => Promise.all([first, second]));

    const visibleAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.[root.id];
    expect(visibleAttemptId).toBeDefined();
    await act(async () =>
      result.current.actions.retryImageUpload!(root.id, visibleAttemptId)
    );

    expect(openImageFile).toHaveBeenCalledTimes(2);
    expect(importAttachment).toHaveBeenCalledTimes(3);
    expect(importAttachment.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ sourcePath: "/incoming/first.png" })
    );
  });

  it("imports one dropped local image through the same validated path", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const imported = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id
    });
    createNoteIdMock.mockReturnValue(imported.id);
    const droppedFile = new File([new Uint8Array([1])], "diagram.webp", {
      type: "image/webp"
    });
    const attachmentUi = {
      openImageFile: vi.fn(),
      pathForDroppedFile: vi.fn().mockReturnValue("/incoming/diagram.webp")
    };
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: {}
      }),
      importAttachment: vi.fn().mockImplementation(
        async (_vaultRoot, _input, context) => ({
          workspace: {
            nodes: [root],
            attachmentsByNodeId: { [root.id]: [imported] }
          },
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
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

    expect(result.current.actions.importDroppedImages).toBeTypeOf("function");
    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () =>
      result.current.actions.importDroppedImages!(root.id, [droppedFile])
    );

    expect(attachmentUi.pathForDroppedFile).toHaveBeenCalledWith(droppedFile);
    expect(store.importAttachment).toHaveBeenCalledWith(
      "/vault",
      expect.objectContaining({
        id: imported.id,
        nodeId: root.id,
        sourcePath: "/incoming/diagram.webp"
      }),
      historyContext("attachment-import")
    );
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([
      imported
    ]);
  });

  it.each([
    {
      name: "multiple files",
      files: [
        new File(["a"], "one.png", { type: "image/png" }),
        new File(["b"], "two.png", { type: "image/png" })
      ],
      message: "Drop one image at a time."
    },
    {
      name: "an unsupported file",
      files: [new File(["x"], "vector.svg", { type: "image/svg+xml" })],
      message: "Choose a PNG, JPEG, WebP, or GIF image."
    },
    {
      name: "a remote file without a local path",
      files: [new File(["x"], "remote.png", { type: "image/png" })],
      message: "Only local image files can be added."
    }
  ])("rejects $name before import", async ({ files, message }) => {
    const pathForDroppedFile = vi.fn().mockReturnValue(null);
    const openImageFile = vi.fn();
    const store = repository({ importAttachment: vi.fn() });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: {
          openImageFile,
          pathForDroppedFile
        }
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.importDroppedImages!("root", files)
    );

    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBe(message);
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();
    expect(store.importAttachment).not.toHaveBeenCalled();

    await act(async () =>
      result.current.actions.retryImageUpload!("root", "stale-attempt")
    );
    expect(openImageFile).not.toHaveBeenCalled();
  });

  it("does not expose a stale retry target for picker failures", async () => {
    const openImageFile = vi.fn().mockRejectedValue(new Error("dialog failed"));
    const store = repository({ importAttachment: vi.fn() });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: { openImageFile, pathForDroppedFile: vi.fn() }
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.uploadImage!("root"));

    expect(result.current.attachmentUploadErrorsByNodeId?.root).toContain(
      "dialog failed"
    );
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();
    expect(store.importAttachment).not.toHaveBeenCalled();
  });

  it("preserves a pending import retry identity across a newer validation error", async () => {
    const pendingImport = deferred<NotesMutationResult>();
    let idCounter = 0;
    createNoteIdMock.mockImplementation(
      () =>
        `20000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`
    );
    const openImageFile = vi.fn().mockResolvedValue("/incoming/pending.png");
    const importAttachment = vi
      .fn()
      .mockReturnValueOnce(pendingImport.promise)
      .mockResolvedValue(workspace([node({ id: "root" })]));
    const store = repository({ importAttachment });
    const { result } = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store,
        attachmentUi: {
          openImageFile,
          pathForDroppedFile: vi.fn()
        }
      })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const upload = result.current.actions.uploadImage!("root");
    await waitFor(() => expect(importAttachment).toHaveBeenCalledOnce());
    await act(async () =>
      result.current.actions.importDroppedImages!("root", [
        new File(["x"], "vector.svg", { type: "image/svg+xml" })
      ])
    );
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toContain(
      "PNG, JPEG, WebP, or GIF"
    );
    expect(
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.root
    ).toBeUndefined();

    pendingImport.reject(new Error("pending failed"));
    await act(async () => upload);
    const visibleAttemptId =
      result.current.attachmentUploadRetryAttemptIdsByNodeId?.root;
    expect(result.current.attachmentUploadErrorsByNodeId?.root).toContain(
      "pending failed"
    );
    expect(visibleAttemptId).toBeDefined();

    await act(async () =>
      result.current.actions.retryImageUpload!("root", visibleAttemptId)
    );
    expect(importAttachment.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ sourcePath: "/incoming/pending.png" })
    );
  });

  it("ignores a non-file drop without creating an error or import", async () => {
    const store = repository({ importAttachment: vi.fn() });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.importDroppedImages!("root", []));

    expect(result.current.attachmentUploadErrorsByNodeId?.root).toBeUndefined();
    expect(store.importAttachment).not.toHaveBeenCalled();
  });

  it("loads attachment bytes on demand without publishing them into workspace state", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const readAttachmentBytes = vi.fn().mockResolvedValue(bytes);
    const store = repository({ readAttachmentBytes });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.loadAttachmentBytes).toBeTypeOf("function");
    let loaded: Uint8Array | undefined;
    await act(async () => {
      loaded = await result.current.actions.loadAttachmentBytes!("attachment-id");
    });

    expect(loaded).toBe(bytes);
    expect(readAttachmentBytes).toHaveBeenCalledWith(
      "/vault",
      "attachment-id"
    );
    expect(result.current.state).not.toHaveProperty("attachmentBytes");
  });

  it("persists one attachment resize as one atomic history command", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const original = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id
    });
    const resized = { ...original, displayWidth: 480 };
    const resizeAttachment = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: {
          nodes: [root],
          attachmentsByNodeId: { [root.id]: [resized] }
        },
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue({
        nodes: [root],
        attachmentsByNodeId: { [root.id]: [original] }
      }),
      resizeAttachment
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.resizeImage).toBeTypeOf("function");
    await act(async () =>
      result.current.actions.resizeImage!(original.id, 480)
    );

    expect(resizeAttachment).toHaveBeenCalledOnce();
    expect(resizeAttachment).toHaveBeenCalledWith(
      "/vault",
      { id: original.id, displayWidth: 480 },
      historyContext("attachment-resize")
    );
    expect(result.current.state.attachmentsByNodeId[root.id][0].displayWidth).toBe(
      480
    );
  });

  it("removes an attachment atomically and restores its metadata through Undo and Redo", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const original = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id
    });
    let historyEntryId: string | null = null;
    const withoutImage: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: { [root.id]: [] }
    };
    const withImage: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: { [root.id]: [original] }
    };
    const removeAttachment = vi.fn().mockImplementation(
      async (_vaultRoot, _attachmentId, context) => {
        historyEntryId = context?.entryId ?? null;
        return {
          workspace: withoutImage,
          historyEntryId,
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(withImage),
      removeAttachment,
      undo: vi.fn().mockImplementation(async () => ({
        workspace: withImage,
        replayedEntryId: historyEntryId,
        canUndo: false,
        canRedo: true
      })),
      redo: vi.fn().mockImplementation(async () => ({
        workspace: withoutImage,
        replayedEntryId: historyEntryId,
        canUndo: true,
        canRedo: false
      }))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.actions.removeImage).toBeTypeOf("function");
    await act(async () => result.current.actions.removeImage!(original.id));
    expect(removeAttachment).toHaveBeenCalledWith(
      "/vault",
      original.id,
      historyContext("attachment-remove")
    );
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([]);

    await act(async () => result.current.actions.undo?.());
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([
      original
    ]);

    await act(async () => result.current.actions.redo?.());
    expect(result.current.state.attachmentsByNodeId[root.id]).toEqual([]);
  });

  it("synchronizes the complete attachment map to a sibling workspace hook", async () => {
    const root = node({ id: "77384bb1-f6cc-4848-a1b5-b8d3b9157306" });
    const imported = attachment({
      id: "1c17ba74-a617-45e7-9e21-74068b63befe",
      nodeId: root.id
    });
    createNoteIdMock.mockReturnValue(imported.id);
    const initial: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: {}
    };
    const updated: NotesWorkspace = {
      nodes: [root],
      attachmentsByNodeId: { [root.id]: [imported] }
    };
    const attachmentUi = {
      openImageFile: vi.fn().mockResolvedValue("/incoming/diagram.png"),
      pathForDroppedFile: vi.fn()
    };
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      importAttachment: vi.fn().mockImplementation(
        async (_vaultRoot, _input, context) => ({
          workspace: updated,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        })
      )
    });
    const first = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/shared-vault",
        repository: store,
        attachmentUi
      })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({
        vaultRoot: "/shared-vault",
        repository: store,
        attachmentUi
      })
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    await waitFor(() => expect(sibling.result.current.status).toBe("ready"));

    act(() => first.result.current.actions.setImageImportMaxDisplayWidth(480));
    await act(async () => first.result.current.actions.uploadImage!(root.id));

    await waitFor(() =>
      expect(sibling.result.current.state.attachmentsByNodeId[root.id]).toEqual([
        imported
      ])
    );
    expect(first.result.current.state.attachmentsByNodeId[root.id]).toEqual([
      imported
    ]);
  });

  it("discards a picker result that resolves after switching vaults", async () => {
    const oldSelection = deferred<string | null>();
    const openImageFile = vi
      .fn()
      .mockReturnValueOnce(oldSelection.promise)
      .mockResolvedValueOnce("/new/fresh.png");
    createNoteIdMock.mockReturnValue("1c17ba74-a617-45e7-9e21-74068b63befe");
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "root" })])),
      importAttachment: vi.fn().mockResolvedValue(workspace([node({ id: "root" })]))
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) =>
        useNotesWorkspace({
          vaultRoot,
          repository: store,
          attachmentUi: {
            openImageFile,
            pathForDroppedFile: vi.fn()
          }
        }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.actions.setImageImportMaxDisplayWidth(480));
    const staleUpload = result.current.actions.uploadImage!("root");
    rerender({ vaultRoot: "/new" });
    await waitFor(() =>
      expect(store.loadWorkspace).toHaveBeenCalledWith("/new", { kind: "active" })
    );
    await act(async () => {
      oldSelection.resolve("/old/stale.png");
      await staleUpload;
    });
    expect(store.importAttachment).not.toHaveBeenCalled();

    await act(async () => result.current.actions.retryImageUpload!("root"));

    expect(openImageFile).toHaveBeenCalledTimes(2);
    expect(store.importAttachment).toHaveBeenCalledWith(
      "/new",
      expect.objectContaining({ sourcePath: "/new/fresh.png" }),
      expect.anything()
    );
  });

  it("exposes loading on the first render before the workspace effect runs", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const renderedStatuses: string[] = [];
    const { result } = renderHook(() => {
      const workspace = useNotesWorkspace({
        vaultRoot: "/vault",
        repository: store
      });
      renderedStatuses.push(workspace.status);
      return workspace;
    });

    expect(renderedStatuses[0]).toBe("loading");

    await act(async () => initialization.resolve());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it.each(["layout", "passive"] as const)(
    "flushes a child %s-effect command through the session after loading",
    async (effect) => {
      const initialization = deferred<void>();
      createNoteIdMock.mockReturnValue("pre-session-root");
      const store = repository({
        initialize: vi.fn().mockReturnValue(initialization.promise),
        loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
        createNode: vi
          .fn()
          .mockResolvedValue(workspace([node({ id: "pre-session-root" })]))
      });
      const completions: Promise<void>[] = [];
      let latestWorkspace: UseNotesWorkspaceResult | undefined;
      render(
        <StartupHarness
          effect={effect}
          repository={store}
          vaultRoot="/vault"
          onCompletion={(completion) => completions.push(completion)}
          onWorkspace={(current) => {
            latestWorkspace = current;
          }}
        />
      );

      expect(store.createNode).not.toHaveBeenCalled();

      await act(async () => initialization.resolve());
      await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
      await act(async () => Promise.all(completions));

      expect(store.createNode).toHaveBeenCalledWith(
        "/vault",
        {
          id: "pre-session-root",
          parentId: null,
          afterId: null,
          title: "",
          note: ""
        },
        historyContext("create")
      );
      expect(
        latestWorkspace?.state.nodesById["pre-session-root"]
      ).toBeDefined();
      expect(latestWorkspace?.status).toBe("ready");
    }
  );

  it("does not duplicate a buffered child command during StrictMode replay", async () => {
    const initialization = deferred<void>();
    createNoteIdMock.mockReturnValue("strict-root");
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise),
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "strict-root" })]))
    });
    const completions: Promise<void>[] = [];

    render(
      <StrictMode>
        <StartupHarness
          effect="layout"
          repository={store}
          vaultRoot="/vault"
          onCompletion={(completion) => completions.push(completion)}
          onWorkspace={() => undefined}
        />
      </StrictMode>
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    await act(async () => initialization.resolve());
    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    await act(async () => Promise.all(completions));

    expect(completions).toHaveLength(2);
    expect(store.createNode).toHaveBeenCalledOnce();
  });

  it("routes a child layout-effect command after a vault change only to the new vault", async () => {
    const oldInitialization = deferred<void>();
    createNoteIdMock.mockReturnValue("new-vault-root");
    const store = repository({
      initialize: vi.fn((vaultRoot) =>
        vaultRoot === "/old" ? oldInitialization.promise : Promise.resolve()
      ),
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-vault-root" })]))
    });
    const completions: Promise<void>[] = [];
    const view = render(
      <StartupHarness
        effect="layout"
        repository={store}
        vaultRoot="/old"
        onCompletion={(completion) => completions.push(completion)}
        onWorkspace={() => undefined}
      />
    );

    view.rerender(
      <StartupHarness
        effect="layout"
        repository={store}
        vaultRoot="/new"
        onCompletion={(completion) => completions.push(completion)}
        onWorkspace={() => undefined}
      />
    );

    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    expect(store.createNode).toHaveBeenCalledWith(
      "/new",
      expect.objectContaining({ id: "new-vault-root" }),
      historyContext("create")
    );

    await act(async () => oldInitialization.resolve());
    await act(async () => Promise.all(completions));
    expect(store.createNode).toHaveBeenCalledOnce();
  });

  it("initializes and loads once for each vault and repository identity", async () => {
    const store = repository();
    const { rerender } = renderHook(
      ({ vaultRoot, repository: current }) => useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/vault-a", repository: store } }
    );

    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledOnce());
    expect(store.initialize).toHaveBeenCalledWith("/vault-a");
    expect(store.loadWorkspace).toHaveBeenCalledWith("/vault-a", { kind: "active" });

    rerender({ vaultRoot: "/vault-a", repository: store });
    expect(store.loadWorkspace).toHaveBeenCalledOnce();

    rerender({ vaultRoot: "/vault-b", repository: store });
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(store.initialize).toHaveBeenLastCalledWith("/vault-b");
  });

  it("deduplicates initialization and loading during StrictMode effect replay", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });

    const { result } = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    await act(async () => initialization.resolve());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("handles a synchronous initialization throw without loading or an unhandled rejection", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const store = repository({
      initialize: vi.fn(() => {
        throw new Error("initialize exploded");
      })
    });

    try {
      const { result } = renderHook(
        () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
        { wrapper: strictMode }
      );

      await waitFor(() => expect(result.current.error).toBe("initialize exploded"));
      await act(async () => Promise.resolve());

      expect(store.initialize).toHaveBeenCalledOnce();
      expect(store.loadWorkspace).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("runs a command only after initialization and loading, then retains the loaded tree on failure", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise),
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "loaded" })])),
      updateNode: vi.fn().mockRejectedValue(new Error("write failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    expect(store.initialize).toHaveBeenCalledOnce();
    expect(store.loadWorkspace).not.toHaveBeenCalled();

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.updateNode("loaded", {
        title: "new",
        note: ""
      });
    });

    expect(result.current).toMatchObject({ status: "loading", error: null });
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.loadWorkspace).not.toHaveBeenCalled();

    await act(async () => initialization.resolve());
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledOnce());
    await act(async () => {
      await completion;
    });

    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    expect(result.current.state.nodesById.loaded).toBeDefined();
    expect(result.current).toMatchObject({
      status: "error",
      error: "write failed"
    });
  });

  it("invokes initialization, loading, and commands in FIFO order", async () => {
    const initialization = deferred<void>();
    const initialLoad = deferred<NotesWorkspace>();
    const firstCommand = deferred<NotesWorkspace>();
    const secondCommand = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    const store = repository({
      initialize: vi.fn(() => {
        invocations.push("initialize");
        return initialization.promise;
      }),
      loadWorkspace: vi.fn(() => {
        invocations.push("load");
        return initialLoad.promise;
      }),
      updateNode: vi
        .fn((_vaultRoot, input) => {
          invocations.push(`update:${input.title}`);
          return input.title === "first"
            ? firstCommand.promise
            : secondCommand.promise;
        })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("initial", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("initial", {
        title: "second",
        note: ""
      });
    });

    expect(invocations).toEqual(["initialize"]);

    await act(async () => initialization.resolve());
    expect(invocations).toEqual(["initialize", "load"]);

    await act(async () =>
      initialLoad.resolve(workspace([node({ id: "initial" })]))
    );
    expect(invocations).toEqual(["initialize", "load", "update:first"]);
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () =>
      firstCommand.resolve(workspace([
        node({ id: "initial" }),
        node({ id: "first" })
      ]))
    );
    expect(invocations).toEqual([
      "initialize",
      "load",
      "update:first",
      "update:second"
    ]);
    expect(result.current.state.nodesById.first).toBeDefined();
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () => {
      secondCommand.resolve(workspace([node({ id: "second" })]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current.state.nodesById.first).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("keeps the first confirmed command workspace when the next command fails", async () => {
    const firstCommand = deferred<NotesWorkspace>();
    const secondCommand = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "initial" })])),
      updateNode: vi
        .fn()
        .mockReturnValueOnce(firstCommand.promise)
        .mockReturnValueOnce(secondCommand.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("initial", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("initial", {
        title: "second",
        note: ""
      });
    });

    await act(async () =>
      firstCommand.resolve(workspace([
        node({ id: "initial" }),
        node({ id: "first-confirmed" })
      ]))
    );
    await act(async () => {
      secondCommand.reject(new Error("second failed"));
      await Promise.all([firstCompletion, secondCompletion]);
    });

    expect(result.current.state.nodesById["first-confirmed"]).toBeDefined();
    expect(result.current.state.nodesById.initial).toBeDefined();
    expect(result.current).toMatchObject({
      status: "error",
      error: "second failed"
    });
  });

  it("blocks a compound split when its draft save fails", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("save failed")),
      splitNode: vi.fn().mockResolvedValue(workspace([]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" } }
      );
    });
    await act(async () => {
      await expect(completion).resolves.toBeUndefined();
    });

    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        title: "prefixsuffix",
        note: "saved note"
      },
      historyContext("text")
    );
    expect(store.splitNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root.title).toBe("root");
    expect(result.current).toMatchObject({
      status: "error",
      error: "save failed"
    });
  });

  it("retains an authoritative draft when the later compound split fails", async () => {
    const saved = workspace([
      node({ id: "root", title: "prefixsuffix", note: "saved note" })
    ]);
    const updateNode = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: saved,
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      })
    );
    const historyStatus = vi
      .fn()
      .mockResolvedValue({ canUndo: false, canRedo: false });
    const store = repository({
      updateNode,
      splitNode: vi.fn().mockRejectedValue(new Error("split failed")),
      historyStatus
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" } }
      )
    );

    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(historyStatus).toHaveBeenCalledOnce();
    expect(store.splitNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        newNodeId: "split-child",
        prefix: "prefix",
        suffix: "suffix"
      },
      historyContext("split")
    );
    expect(result.current.state.nodesById.root).toMatchObject({
      title: "prefixsuffix",
      note: "saved note"
    });
    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "split failed",
      canUndo: true,
      canRedo: false
    });
  });

  it("consumes successful atomic mutation status without a redundant status query", async () => {
    const initial = workspace([node({ id: "root" })]);
    const updated = workspace([node({ id: "root", title: "Updated" })]);
    const historyStatus = vi
      .fn()
      .mockResolvedValue({ canUndo: false, canRedo: false });
    const updateNode = vi.fn((_vaultRoot, _input, context) =>
      Promise.resolve({
        workspace: updated,
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      historyStatus
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/atomic-result", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(historyStatus).toHaveBeenCalledOnce();

    await act(async () =>
      result.current.actions.updateNode("root", { title: "Updated", note: "" })
    );

    expect(historyStatus).toHaveBeenCalledOnce();
    expect(result.current.state.nodesById.root.title).toBe("Updated");
    expect(result.current).toMatchObject({ canUndo: true, canRedo: false });
  });

  it.each(["split", "move", "remove"] as const)(
    "discards a %s inline snapshot when its atomic history entry is null",
    async (operation) => {
      const initial = workspace([
        node({ id: "source", title: operation === "remove" ? "" : "before" }),
        node({ id: "target", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const inlineWorkspace = workspace([
        node({ id: "source", title: operation === "remove" ? "" : "edited" }),
        node({ id: "target", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const finalWorkspace = workspace([
        ...(operation === "remove"
          ? []
          : [
              node({
                id: "source",
                title: "edited",
                parentId: operation === "move" ? "target" : null
              })
            ]),
        node({ id: "target", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 }),
        ...(operation === "split"
          ? [node({ id: "split", sortKey: 4096 })]
          : [])
      ]);
      const updateNode = vi.fn().mockResolvedValue({
        workspace: inlineWorkspace,
        historyEntryId: null,
        canUndo: false,
        canRedo: false
      });
      const structuralMutation = vi.fn((_vaultRoot, _input, context) =>
        Promise.resolve({
          workspace: finalWorkspace,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        })
      );
      const undo = vi.fn(async () => ({
        workspace: finalWorkspace,
        replayedEntryId: updateNode.mock.calls[0]?.[2]?.entryId ?? null,
        canUndo: false,
        canRedo: true
      }));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
        ...(operation === "split" ? { splitNode: structuralMutation } : {}),
        ...(operation === "move" ? { moveNode: structuralMutation } : {}),
        ...(operation === "remove"
          ? { removeEmptyNode: structuralMutation }
          : {}),
        undo
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/null-inline-${operation}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => result.current.actions.focusNode("source"));

      await act(async () => {
        if (operation === "split") {
          await result.current.actions.splitNode(
            "source",
            "split",
            "edited",
            "",
            { draft: { title: "edited", note: "" } }
          );
        } else if (operation === "move") {
          await result.current.actions.moveNode(
            { id: "source", parentId: "target", afterId: null },
            "source",
            { draft: { title: "edited", note: "" } }
          );
        } else {
          await result.current.actions.removeEmptyNode("source", "target", {
            draft: { title: "", note: "" }
          });
        }
      });

      const inlineEntryId = updateNode.mock.calls[0]?.[2]?.entryId;
      expect(inlineEntryId).toEqual(expect.any(String));
      expect(structuralMutation.mock.calls[0]?.[2]?.entryId).not.toBe(
        inlineEntryId
      );

      await act(async () => result.current.actions.focusNode("other"));
      await act(async () => result.current.actions.undo!());
      expect(result.current.state).toMatchObject({
        selectedId: "other",
        pendingFocusId: "other"
      });
    }
  );

  it("keeps the committed text snapshot when a later split step fails", async () => {
    const active = workspace([node({ id: "other" })]);
    const archived = workspace([
      node({
        id: "root",
        title: "prefixsuffix",
        archivedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    const saved = workspace([
      node({
        id: "root",
        title: "prefixsuffix",
        note: "saved note",
        archivedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    const updateNode = vi.fn().mockResolvedValue(saved);
    const loadWorkspace = vi.fn((_vaultRoot, scope) =>
      Promise.resolve(scope?.kind === "archive" ? archived : active)
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: active,
      replayedEntryId: updateNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace,
      updateNode,
      splitNode: vi.fn().mockRejectedValue(new Error("split failed")),
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/partial-split", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.actions.selectLibraryView("archive")
    );
    await act(async () => {
      await result.current.actions.zoomTo("root");
      await result.current.actions.focusNode("root");
    });

    await act(async () =>
      result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix",
        { draft: { title: "prefixsuffix", note: "saved note" } }
      )
    );
    await act(async () => result.current.actions.selectLibraryView("all"));
    await act(async () => {
      await result.current.actions.focusNode("other");
      await result.current.actions.zoomTo("other");
      await result.current.actions.undo!();
    });

    expect(result.current.libraryView).toBe("archive");
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("expands a move target before moving and publishing focus", async () => {
    const expanded = deferred<NotesWorkspace>();
    const moved = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "first", sortKey: 1, isCollapsed: true }),
      node({ id: "hidden", parentId: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleCollapsed: vi.fn().mockReturnValue(expanded.promise),
      moveNode: vi.fn().mockReturnValue(moved.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.moveNode(
        { id: "second", parentId: "first", afterId: "hidden" },
        "second",
        { expandNodeId: "first" }
      );
    });
    await waitFor(() => expect(store.toggleCollapsed).toHaveBeenCalledOnce());
    expect(store.moveNode).not.toHaveBeenCalled();
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () =>
      expanded.resolve(
        workspace([
          node({ id: "first", sortKey: 1, isCollapsed: false }),
          node({ id: "hidden", parentId: "first", sortKey: 1 }),
          node({ id: "second", sortKey: 2 })
        ])
      )
    );
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      moved.resolve(
        workspace([
          node({ id: "first", sortKey: 1, isCollapsed: false }),
          node({ id: "hidden", parentId: "first", sortKey: 1 }),
          node({ id: "second", parentId: "first", sortKey: 2 })
        ])
      );
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "second",
      editingNoteId: "second",
      pendingFocusId: "second"
    });
  });

  it("skips a queued move when its before sibling is missing", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockResolvedValue(initial)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.moveNode({
        id: "child",
        parentId: null,
        afterId: null,
        beforeId: "missing"
      })
    );

    expect(store.moveNode).not.toHaveBeenCalled();
  });

  it("does not launch loading or queued commands after unmount during initialization", async () => {
    const initialization = deferred<void>();
    const store = repository({
      initialize: vi.fn().mockReturnValue(initialization.promise)
    });
    const { result, unmount } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.updateNode("root", {
        title: "late",
        note: ""
      });
    });
    unmount();
    await act(async () => {
      initialization.resolve();
      await completion;
    });

    expect(store.loadWorkspace).not.toHaveBeenCalled();
    expect(store.updateNode).not.toHaveBeenCalled();
  });

  it("replaces state with each authoritative command response and derives creation placement", async () => {
    createNoteIdMock.mockReturnValueOnce("new-root").mockReturnValueOnce("new-child");
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([
        node({ id: "first", sortKey: 1 }),
        node({ id: "last", sortKey: 2 }),
        node({ id: "parent", sortKey: 3 }),
        node({ id: "existing-child", parentId: "parent" })
      ])),
      createNode: vi
        .fn()
        .mockResolvedValueOnce(workspace([
          node({ id: "first", sortKey: 1 }),
          node({ id: "last", sortKey: 2 }),
          node({ id: "parent", sortKey: 3 }),
          node({ id: "existing-child", parentId: "parent" }),
          node({ id: "new-root", sortKey: 4 })
        ]))
        .mockResolvedValueOnce(workspace([
          node({ id: "parent" }),
          node({ id: "new-child", parentId: "parent" })
        ]))
    });
    const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository: store }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.createRoot());
    expect(store.createNode).toHaveBeenNthCalledWith(
      1,
      "/vault",
      {
        id: "new-root",
        parentId: null,
        afterId: "parent",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      editingNoteId: "new-root",
      pendingFocusId: "new-root"
    });

    await act(async () => result.current.actions.createChild("parent"));
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-child",
        parentId: "parent",
        afterId: "existing-child",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.childIdsByParent.parent).toEqual(["new-child"]);
    expect(result.current.state).toMatchObject({
      selectedId: "new-child",
      editingNoteId: "new-child",
      pendingFocusId: "new-child"
    });
  });

  it("acknowledges matching pending focus through a command-neutral public promise", async () => {
    createNoteIdMock.mockReturnValue("created");
    const store = repository({
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "created", title: "" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.createRoot());
    expect(result.current.state.pendingFocusId).toBe("created");

    expect(result.current.actions.acknowledgeFocus).toEqual(
      expect.any(Function)
    );
    let acknowledgement!: Promise<void>;
    act(() => {
      acknowledgement = result.current.actions.acknowledgeFocus("created");
    });
    expect(acknowledgement).toBeInstanceOf(Promise);
    await act(async () => acknowledgement);

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(store.createNode).toHaveBeenCalledOnce();
    expect(store.updateNode).not.toHaveBeenCalled();
  });

  it("focuses an existing node without enqueueing a repository command", async () => {
    const store = repository();
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.focusNode("root"));

    expect(result.current.state).toMatchObject({
      selectedId: "root",
      editingNoteId: "root",
      pendingFocusId: "root"
    });
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.moveNode).not.toHaveBeenCalled();
  });

  it("publishes a move focus target only after authoritative success", async () => {
    const moved = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockReturnValue(moved.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.moveNode(
        { id: "child", parentId: null, afterId: "root" },
        "child"
      );
    });
    await waitFor(() => expect(store.moveNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      moved.resolve(initial);
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      editingNoteId: "child",
      pendingFocusId: "child"
    });
  });

  it("does not publish a move focus target when the command fails", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: vi.fn().mockRejectedValue(new Error("move failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.moveNode(
        { id: "child", parentId: null, afterId: "root" },
        "child"
      )
    );

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "move failed"
    });
  });

  it("keeps a committed collapse snapshot when the later move step fails", async () => {
    const initial = workspace([
      node({ id: "target", isCollapsed: true }),
      node({ id: "moving", sortKey: 2048 }),
      node({ id: "other", sortKey: 3072 })
    ]);
    const expanded = workspace([
      node({ id: "target", isCollapsed: false }),
      node({ id: "moving", sortKey: 2048 }),
      node({ id: "other", sortKey: 3072 })
    ]);
    const toggleCollapsed = vi.fn().mockResolvedValue(expanded);
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: toggleCollapsed.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleCollapsed,
      moveNode: vi.fn().mockRejectedValue(new Error("move failed")),
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/partial-move", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.actions.zoomTo("target");
      await result.current.actions.focusNode("moving");
    });

    await act(async () =>
      result.current.actions.moveNode(
        { id: "moving", parentId: "target", afterId: null },
        "moving",
        { expandNodeId: "target" }
      )
    );
    await act(async () => {
      await result.current.actions.focusNode("other");
      await result.current.actions.zoomTo("other");
      await result.current.actions.undo!();
    });

    expect(result.current.state).toMatchObject({
      selectedId: "moving",
      zoomRootId: "target",
      pendingFocusId: "moving",
      pendingFocusField: "title"
    });
  });

  it("publishes a remove focus target only after authoritative success", async () => {
    const removed = deferred<NotesWorkspace>();
    const initial = workspace([
      node({ id: "first" }),
      node({ id: "empty", sortKey: 2, title: "" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      removeEmptyNode: vi.fn().mockReturnValue(removed.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.removeEmptyNode("empty", "first");
    });
    await waitFor(() => expect(store.removeEmptyNode).toHaveBeenCalledOnce());
    expect(result.current.state.pendingFocusId).toBeNull();

    await act(async () => {
      removed.resolve(workspace([node({ id: "first" })]));
      await completion;
    });
    expect(result.current.state).toMatchObject({
      selectedId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("does not publish a remove focus target when the command fails", async () => {
    const initial = workspace([
      node({ id: "first" }),
      node({ id: "empty", sortKey: 2, title: "" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      removeEmptyNode: vi.fn().mockRejectedValue(new Error("remove failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.removeEmptyNode("empty", "first")
    );

    expect(result.current.state.pendingFocusId).toBeNull();
    expect(result.current).toMatchObject({
      status: "error",
      error: "remove failed"
    });
  });

  it("publishes two successful commands in invocation order", async () => {
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });

    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());
    await act(async () => {
      first.resolve(workspace([node({ id: "root" }), node({ id: "first" })]));
      await firstCompletion;
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.first).toBeDefined();
    expect(result.current.status).toBe("loading");

    await act(async () => {
      second.resolve(workspace([node({ id: "second" })]));
      await secondCompletion;
    });

    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current.state.nodesById.first).toBeUndefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("continues from a failed command to a later successful command", async () => {
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });

    await act(async () => {
      first.reject(new Error("first failed"));
      await firstCompletion;
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current).toMatchObject({
      status: "loading",
      error: "first failed"
    });

    await act(async () => {
      second.resolve(workspace([node({ id: "second" })]));
      await secondCompletion;
    });

    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("derives rapid creation placement when each queued command starts", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-root-1")
      .mockReturnValueOnce("new-root-2");
    const first = deferred<NotesWorkspace>();
    const second = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "initial", sortKey: 1 })])),
      createNode: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.createRoot();
      secondCompletion = result.current.actions.createRoot();
    });

    await waitFor(() => expect(createNoteIdMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    expect(store.createNode).toHaveBeenNthCalledWith(
      1,
      "/vault",
      {
        id: "new-root-1",
        parentId: null,
        afterId: "initial",
        title: "",
        note: ""
      },
      historyContext("create")
    );

    await act(async () =>
      first.resolve(workspace([
        node({ id: "initial", sortKey: 1 }),
        node({ id: "new-root-1", sortKey: 2 })
      ]))
    );
    expect(createNoteIdMock).toHaveBeenCalledTimes(2);
    expect(store.createNode).toHaveBeenCalledTimes(2);
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-root-2",
        parentId: null,
        afterId: "new-root-1",
        title: "",
        note: ""
      },
      historyContext("create")
    );

    await act(async () => {
      second.resolve(workspace([
        node({ id: "initial", sortKey: 1 }),
        node({ id: "new-root-1", sortKey: 2 }),
        node({ id: "new-root-2", sortKey: 3 })
      ]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
  });

  it("materializes structural before snapshots before repository awaits", async () => {
    createNoteIdMock.mockReturnValue("created");
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const activeReload = deferred<NotesWorkspace>();
    let activeLoads = 0;
    const createNode = vi.fn().mockResolvedValue(
      workspace([
        node({ id: "root" }),
        node({ id: "other", sortKey: 2048 }),
        node({ id: "created", sortKey: 3072 })
      ])
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: createNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn((_vaultRoot, scope) => {
        if (scope?.kind === "active") {
          activeLoads += 1;
          return activeLoads === 1
            ? Promise.resolve(initial)
            : activeReload.promise;
        }
        return Promise.resolve(initial);
      }),
      createNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
    });

    const creation = result.current.actions.createRoot();
    await waitFor(() => expect(activeLoads).toBe(2));
    await act(async () => {
      await result.current.actions.focusNode("other");
      await result.current.actions.zoomTo("other");
    });
    activeReload.resolve(initial);
    await act(async () => creation);
    await act(async () => result.current.actions.undo!());

    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("derives a queued child creation from a parent created by prior work", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-parent")
      .mockReturnValueOnce("new-child");
    const parentCreation = deferred<NotesWorkspace>();
    const childCreation = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi
        .fn()
        .mockReturnValueOnce(parentCreation.promise)
        .mockReturnValueOnce(childCreation.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let parentCompletion!: Promise<void>;
    let childCompletion!: Promise<void>;
    act(() => {
      parentCompletion = result.current.actions.createRoot();
      childCompletion = result.current.actions.createChild("new-parent");
    });

    await waitFor(() => expect(store.createNode).toHaveBeenCalledOnce());
    await act(async () =>
      parentCreation.resolve(workspace([node({ id: "new-parent" })]))
    );
    expect(store.createNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "new-child",
        parentId: "new-parent",
        afterId: null,
        title: "",
        note: ""
      },
      historyContext("create")
    );

    await act(async () => {
      childCreation.resolve(workspace([
        node({ id: "new-parent" }),
        node({ id: "new-child", parentId: "new-parent" })
      ]));
      await Promise.all([parentCompletion, childCompletion]);
    });
  });

  it("detects a duplicate against the confirmed workspace at queue start", async () => {
    createNoteIdMock.mockReturnValue("new-root");
    const create = deferred<NotesWorkspace>();
    const duplicate = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "source", sortKey: 1 })])),
      createNode: vi.fn().mockReturnValue(create.promise),
      duplicateNode: vi.fn().mockReturnValue(duplicate.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let createCompletion!: Promise<void>;
    let duplicateCompletion!: Promise<void>;
    act(() => {
      createCompletion = result.current.actions.createRoot();
      duplicateCompletion = result.current.actions.duplicateNode("source");
    });

    expect(store.duplicateNode).not.toHaveBeenCalled();
    await act(async () =>
      create.resolve(workspace([
        node({ id: "source", sortKey: 1 }),
        node({ id: "new-root", sortKey: 2 })
      ]))
    );
    expect(store.duplicateNode).toHaveBeenCalledWith(
      "/vault",
      "source",
      historyContext("duplicate")
    );

    await act(async () => {
      duplicate.resolve(workspace([
        node({ id: "source", sortKey: 1 }),
        node({ id: "new-root", sortKey: 2 }),
        node({ id: "duplicate", sortKey: 3 })
      ]));
      await Promise.all([createCompletion, duplicateCompletion]);
    });

    expect(result.current.state).toMatchObject({
      selectedId: "duplicate",
      editingNoteId: "duplicate",
      pendingFocusId: "duplicate"
    });
  });

  it("continues after a synchronous command throw and resolves public promises", async () => {
    const store = repository({
      updateNode: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("synchronous failure");
        })
        .mockResolvedValueOnce(workspace([node({ id: "second" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    let zoomCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
      zoomCompletion = result.current.actions.zoomTo("root");
    });

    expect(firstCompletion).toBeInstanceOf(Promise);
    expect(secondCompletion).toBeInstanceOf(Promise);
    expect(zoomCompletion).toBeInstanceOf(Promise);
    await act(async () => {
      expect(await firstCompletion).toBeUndefined();
      expect(await secondCompletion).toBeUndefined();
      expect(await zoomCompletion).toBeUndefined();
    });
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(result.current.state.nodesById.second).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("clears old placement state across an identity transition and failed load", async () => {
    createNoteIdMock.mockReturnValue("new-vault-root");
    const oldStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([node({ id: "old-root" })]))
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockRejectedValue(new Error("new vault failed")),
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-vault-root" })]))
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(result.current.state.nodesById["old-root"]).toBeDefined());

    rerender({ vaultRoot: "/new", repository: newStore });

    expect(result.current.status).toBe("loading");
    expect(result.current.state.rootIds).toEqual([]);
    expect(result.current.state.nodesById["old-root"]).toBeUndefined();
    await waitFor(() => expect(result.current.error).toBe("new vault failed"));
    expect(result.current.state.rootIds).toEqual([]);

    await act(async () => result.current.actions.createRoot());
    expect(newStore.createNode).toHaveBeenCalledWith(
      "/new",
      {
        id: "new-vault-root",
        parentId: null,
        afterId: null,
        title: "",
        note: ""
      },
      historyContext("create")
    );
  });

  it("delegates every remaining action to NotesStore and preserves confirmed nodes on errors", async () => {
    const after = workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })]);
    const updateNodeMock = vi.fn().mockResolvedValue(after);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(after),
      updateNode: updateNodeMock,
      splitNode: vi.fn().mockResolvedValue(after),
      moveNode: vi.fn().mockResolvedValue(after),
      toggleComplete: vi.fn().mockResolvedValue(after),
      toggleCollapsed: vi.fn().mockResolvedValue(after),
      duplicateNode: vi.fn().mockResolvedValue(after),
      removeEmptyNode: vi.fn().mockResolvedValue(after),
      softDeleteNode: vi.fn().mockResolvedValue(after),
      restoreNode: vi.fn().mockResolvedValue(after)
    });
    const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository: store }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => result.current.actions.updateNode("root", { title: "Title", note: "Note" }));
    await act(async () => result.current.actions.splitNode("root", "split", "pre", "post"));
    await act(async () => result.current.actions.moveNode({ id: "child", parentId: null, afterId: "root" }));
    await act(async () => result.current.actions.toggleComplete("root"));
    await act(async () => result.current.actions.toggleCollapsed("root"));
    await act(async () => result.current.actions.duplicateNode("root"));
    await act(async () => result.current.actions.removeEmptyNode("child"));
    await act(async () => result.current.actions.deleteNode("root"));
    await act(async () => result.current.actions.restoreNode("root"));

    expect(store.updateNode).toHaveBeenCalledWith("/vault", { id: "root", title: "Title", note: "Note" }, historyContext("update"));
    expect(store.splitNode).toHaveBeenCalledWith("/vault", { id: "root", newNodeId: "split", prefix: "pre", suffix: "post" }, historyContext("split"));
    expect(store.moveNode).toHaveBeenCalledWith("/vault", { id: "child", parentId: null, afterId: "root" }, historyContext("move"));
    expect(store.toggleComplete).toHaveBeenCalledWith("/vault", "root", historyContext("complete"));
    expect(store.toggleCollapsed).toHaveBeenCalledWith("/vault", "root", historyContext("collapse"));
    expect(store.duplicateNode).toHaveBeenCalledWith("/vault", "root", historyContext("duplicate"));
    expect(store.removeEmptyNode).toHaveBeenCalledWith("/vault", "child", historyContext("remove"));
    expect(store.softDeleteNode).toHaveBeenCalledWith("/vault", "root", historyContext("trash"));
    expect(store.restoreNode).toHaveBeenCalledWith("/vault", "root", historyContext("restore"));

    updateNodeMock.mockRejectedValueOnce(new Error("write failed"));
    await act(async () => result.current.actions.updateNode("root", { title: "Again", note: "" }));
    expect(result.current.error).toBe("write failed");
    expect(result.current.state.nodesById.root).toBeDefined();
  });

  it.each([
    ["expandAll", "expandAll", "expand-all"],
    ["collapseAll", "collapseAll", "collapse-all"],
    ["sortSubtreeAscending", "sortSubtreeAscending", "sort-ascending"],
    ["sortSubtreeDescending", "sortSubtreeDescending", "sort-descending"]
  ] as const)(
    "routes %s through atomic history and restores focus on Undo",
    async (actionName, repositoryMethod, commandKind) => {
      const rootId = "11111111-1111-4111-8111-111111111111";
      const rootAttachment = attachment({
        id: "22222222-2222-4222-8222-222222222222",
        nodeId: rootId
      });
      const before: NotesWorkspace = {
        nodes: [
          node({ id: rootId, title: "Root", isCollapsed: true }),
          node({ id: "child", parentId: rootId, title: "Zulu" }),
          node({ id: "other", sortKey: 2048 })
        ],
        attachmentsByNodeId: { [rootId]: [rootAttachment] }
      };
      const after: NotesWorkspace = {
        nodes: [
          node({ id: rootId, title: "Root", isCollapsed: false }),
          node({ id: "child", parentId: rootId, title: "Alpha" }),
          node({ id: "other", sortKey: 2048 })
        ],
        attachmentsByNodeId: { [rootId]: [rootAttachment] }
      };
      const atomic = vi.fn().mockImplementation(
        async (_vaultRoot, _nodeId, context) => ({
          workspace: after,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        })
      );
      const undo = vi.fn().mockImplementation(async () => ({
        workspace: before,
        replayedEntryId: atomic.mock.calls[0]?.[2]?.entryId ?? null,
        canUndo: false,
        canRedo: true
      }));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(before),
        [repositoryMethod]: atomic,
        undo
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: `/atomic-${actionName}`, repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => result.current.actions.focusNode(rootId));

      await act(async () => result.current.actions[actionName](rootId));

      expect(atomic).toHaveBeenCalledWith(
        `/atomic-${actionName}`,
        rootId,
        historyContext(commandKind)
      );
      await waitFor(() =>
        expect(result.current).toMatchObject({ canUndo: true, canRedo: false })
      );
      expect(result.current.state.attachmentsByNodeId[rootId]).toEqual([
        rootAttachment
      ]);
      await act(async () => {
        await result.current.actions.focusNode("other");
        await result.current.actions.undo!();
      });
      expect(undo).toHaveBeenCalledOnce();
      expect(result.current.state).toMatchObject({
        selectedId: rootId,
        pendingFocusId: rootId,
        pendingFocusField: "title"
      });
    }
  );

  it.each([
    ["expandAll", "expandAll"],
    ["collapseAll", "collapseAll"],
    ["sortSubtreeAscending", "sortSubtreeAscending"],
    ["sortSubtreeDescending", "sortSubtreeDescending"]
  ] as const)("does not create Undo for a no-op %s mutation", async (
    actionName,
    repositoryMethod
  ) => {
    const initial = workspace([node({ id: "root" })]);
    const atomic = vi.fn().mockResolvedValue({
      workspace: initial,
      historyEntryId: null,
      canUndo: false,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      [repositoryMethod]: atomic
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: `/noop-${actionName}`, repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions[actionName]("root"));

    expect(atomic).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("commits one atomic Move To and restores its focus with one Undo", async () => {
    const initial = workspace([
      node({ id: "project" }),
      node({ id: "child", parentId: "project" }),
      node({ id: "inbox", sortKey: 2048 })
    ]);
    const moved = workspace([
      node({ id: "project" }),
      node({ id: "child", parentId: "inbox" }),
      node({ id: "inbox", sortKey: 2048 })
    ]);
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => ({
        workspace: moved,
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      })
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: moveNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/move-to", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.focusNode("child"));

    await act(async () =>
      result.current.actions.moveNode(
        { id: "child", parentId: "inbox", afterId: null },
        "child"
      )
    );

    expect(moveNode).toHaveBeenCalledOnce();
    expect(moveNode).toHaveBeenCalledWith(
      "/move-to",
      { id: "child", parentId: "inbox", afterId: null },
      historyContext("move")
    );
    await act(async () => result.current.actions.undo!());
    expect(undo).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      pendingFocusId: "child",
      pendingFocusField: "title"
    });
    expect(result.current.state.nodesById.child.parentId).toBe("project");
  });

  it("prepares Move To from full active state and commits a root move with one Undo", async () => {
    const initial = workspace([
      node({ id: "project" }),
      node({ id: "child", parentId: "project" }),
      node({ id: "inbox", sortKey: 2048 })
    ]);
    const moved = workspace([
      node({ id: "project" }),
      node({ id: "inbox", sortKey: 2048 }),
      node({ id: "child", sortKey: 3072 })
    ]);
    let activeWorkspace = initial;
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        activeWorkspace = moved;
        return {
          workspace: moved,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        };
      }
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: moveNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "starred"
          ? workspace([initial.nodes[0], initial.nodes[1]])
          : activeWorkspace
      ),
      moveNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/prepared-root", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.actions.selectLibraryView("starred")
    );

    const prepared = await result.current.prepareMoveNode!("child");
    expect(prepared.nodes.map((item) => item.id)).toEqual([
      "project",
      "child",
      "inbox"
    ]);
    const outcome = await result.current.commitPreparedMove!(prepared, null);

    expect(outcome).toEqual({ ok: true });
    expect(moveNode).toHaveBeenCalledOnce();
    expect(moveNode).toHaveBeenCalledWith(
      "/prepared-root",
      { id: "child", parentId: null, afterId: "inbox" },
      historyContext("move")
    );
    await act(async () => result.current.actions.undo!());
    expect(undo).toHaveBeenCalledOnce();
  });

  it("rejects a target removed after Move To opens without closing authority", async () => {
    const source = node({ id: "source" });
    const target = node({ id: "target", sortKey: 2048 });
    let activeWorkspace = workspace([source, target]);
    const moveNode = vi.fn();
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/removed-target", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");
    activeWorkspace = workspace([source]);

    let outcome!: Awaited<
      ReturnType<NonNullable<typeof result.current.commitPreparedMove>>
    >;
    await act(async () => {
      outcome = await result.current.commitPreparedMove!(prepared, "target");
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).not.toHaveBeenCalled();
  });

  it("rejects a prepared move after its scope or vault changes", async () => {
    const active = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const oldStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(active)
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(active)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, store }) =>
        useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old-move", store: oldStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const scopePrepared = await result.current.prepareMoveNode!("source");
    await act(async () =>
      result.current.actions.selectLibraryView("recent")
    );

    expect(
      await result.current.commitPreparedMove!(scopePrepared, "target")
    ).toMatchObject({ ok: false, error: expect.stringContaining("changed") });

    const vaultPrepared = await result.current.prepareMoveNode!("source");
    rerender({ vaultRoot: "/new-move", store: newStore });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(
      await result.current.commitPreparedMove!(vaultPrepared, "target")
    ).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  });

  it("rejects a prepared move when an earlier queued move changes its source parent", async () => {
    const initial = workspace([
      node({ id: "first-parent" }),
      node({ id: "other-parent", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "source", parentId: "first-parent" })
    ]);
    const sourceMoved = workspace([
      node({ id: "first-parent" }),
      node({ id: "other-parent", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "source", parentId: "other-parent" })
    ]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        if (moveNode.mock.calls.length === 1) {
          return earlier.promise;
        }
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-source", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    let earlierCompletion!: Promise<void>;
    act(() => {
      earlierCompletion = result.current.actions.moveNode({
        id: "source",
        parentId: "other-parent",
        afterId: null
      });
    });
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );
    await act(async () => Promise.resolve());
    expect(moveNode).toHaveBeenCalledOnce();

    activeWorkspace = sourceMoved;
    const earlierContext = moveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: sourceMoved,
      historyEntryId: earlierContext?.entryId ?? null,
      canUndo: true,
      canRedo: false
    });
    let outcome!: Awaited<typeof preparedCompletion>;
    await act(async () => {
      await earlierCompletion;
      outcome = await preparedCompletion;
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).toHaveBeenCalledOnce();
  });

  it("rejects a prepared move when an earlier queued move changes its target", async () => {
    const initial = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 }),
      node({ id: "other-parent", sortKey: 3072 })
    ]);
    const targetMoved = workspace([
      node({ id: "source" }),
      node({ id: "other-parent", sortKey: 3072 }),
      node({ id: "target", parentId: "other-parent" })
    ]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        if (moveNode.mock.calls.length === 1) {
          return earlier.promise;
        }
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-target", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    let earlierCompletion!: Promise<void>;
    act(() => {
      earlierCompletion = result.current.actions.moveNode({
        id: "target",
        parentId: "other-parent",
        afterId: null
      });
    });
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );

    activeWorkspace = targetMoved;
    const earlierContext = moveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: targetMoved,
      historyEntryId: earlierContext?.entryId ?? null,
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).toHaveBeenCalledOnce();
  });

  it("rejects a prepared move when an earlier queued delete removes its target", async () => {
    const initial = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const targetRemoved = workspace([node({ id: "source" })]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const softDeleteNode = vi.fn().mockReturnValue(earlier.promise);
    const moveNode = vi.fn().mockResolvedValue({
      workspace: targetRemoved,
      historyEntryId: null,
      canUndo: true,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      softDeleteNode,
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-delete", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const earlierCompletion = result.current.actions.deleteNode("target");
    await waitFor(() => expect(softDeleteNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );

    activeWorkspace = targetRemoved;
    const earlierContext = softDeleteNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: targetRemoved,
      historyEntryId: earlierContext?.entryId ?? null,
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).not.toHaveBeenCalled();
  });

  it("rejects a prepared move when a queued scope generation settles first", async () => {
    const initial = workspace([
      node({ id: "blocker" }),
      node({ id: "source", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    let activeWorkspace = initial;
    const earlier = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockImplementation(
      async (_vaultRoot, _input, context) => {
        if (moveNode.mock.calls.length === 1) {
          return earlier.promise;
        }
        return {
          workspace: activeWorkspace,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        };
      }
    );
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-scope", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const earlierCompletion = result.current.actions.moveNode({
      id: "blocker",
      parentId: "target",
      afterId: null
    });
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    const scopeCompletion = result.current.actions.selectLibraryView("recent");
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );

    const earlierContext = moveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: initial,
      historyEntryId: earlierContext?.entryId ?? null,
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;
    await scopeCompletion;

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(moveNode).toHaveBeenCalledOnce();
  });

  it("rejects a queued prepared move when its vault generation changes", async () => {
    const initial = workspace([
      node({ id: "blocker" }),
      node({ id: "source", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const earlier = deferred<NotesMutationResult>();
    const oldMoveNode = vi.fn().mockReturnValue(earlier.promise);
    const oldStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      moveNode: oldMoveNode
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, store }) =>
        useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/queued-old", store: oldStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const earlierCompletion = result.current.actions.moveNode({
      id: "blocker",
      parentId: "target",
      afterId: null
    });
    await waitFor(() => expect(oldMoveNode).toHaveBeenCalledOnce());
    const preparedCompletion = result.current.commitPreparedMove!(
      prepared,
      "target"
    );
    rerender({ vaultRoot: "/queued-new", store: newStore });

    const earlierContext = oldMoveNode.mock.calls[0]?.[2];
    earlier.resolve({
      workspace: initial,
      historyEntryId: earlierContext?.entryId ?? null,
      canUndo: true,
      canRedo: false
    });
    const outcome = await preparedCompletion;
    await earlierCompletion;
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed")
    });
    expect(oldMoveNode).toHaveBeenCalledOnce();
  });

  it("commits one valid deferred prepared move and creates one Undo", async () => {
    const initial = workspace([
      node({ id: "source" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const moved = workspace([
      node({ id: "target", sortKey: 2048 }),
      node({ id: "source", parentId: "target" })
    ]);
    let activeWorkspace = initial;
    const pendingMove = deferred<NotesMutationResult>();
    const moveNode = vi.fn().mockReturnValue(pendingMove.promise);
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: moveNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => activeWorkspace),
      moveNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/queued-valid", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const prepared = await result.current.prepareMoveNode!("source");

    const completion = result.current.commitPreparedMove!(prepared, "target");
    await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
    activeWorkspace = moved;
    const context = moveNode.mock.calls[0]?.[2];
    pendingMove.resolve({
      workspace: moved,
      historyEntryId: context?.entryId ?? null,
      canUndo: true,
      canRedo: false
    });
    expect(await completion).toEqual({ ok: true });

    await act(async () => result.current.actions.undo!());
    expect(moveNode).toHaveBeenCalledOnce();
    expect(undo).toHaveBeenCalledOnce();
  });

  it("broadcasts atomic subtree actions to sibling hooks without replacing navigation", async () => {
    const initial = workspace([
      node({ id: "root", isCollapsed: true }),
      node({ id: "child", parentId: "root", isCollapsed: true })
    ]);
    const expanded = workspace([
      node({ id: "root", isCollapsed: false }),
      node({ id: "child", parentId: "root", isCollapsed: false })
    ]);
    const expandAll = vi.fn().mockImplementation(
      async (_vaultRoot, _nodeId, context) => ({
        workspace: expanded,
        historyEntryId: context?.entryId ?? null,
        canUndo: true,
        canRedo: false
      })
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      expandAll
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-subtree", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-subtree", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    await act(async () => sibling.result.current.actions.zoomTo("root"));

    await act(async () => owner.result.current.actions.expandAll("root"));

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById.child.isCollapsed).toBe(
        false
      )
    );
    expect(sibling.result.current.state.zoomRootId).toBe("root");
  });

  it("clears sibling search expansions for a no-op Collapse all", async () => {
    const collapsed = workspace([
      node({ id: "root", isCollapsed: true }),
      node({ id: "child", parentId: "root" })
    ]);
    const collapseAll = vi.fn().mockResolvedValue({
      workspace: collapsed,
      historyEntryId: null,
      canUndo: false,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(collapsed),
      collapseAll
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-collapse", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-collapse", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    await act(async () =>
      sibling.result.current.actions.openSearchResult("child")
    );
    expect(sibling.result.current.locallyExpandedNodeIds).toEqual(
      new Set(["root"])
    );

    await act(async () => owner.result.current.actions.collapseAll("root"));

    await waitFor(() =>
      expect(sibling.result.current.locallyExpandedNodeIds).toEqual(new Set())
    );
    expect(owner.result.current.canUndo).toBe(false);
  });

  it("retains the last scoped projection when reload fails after a mutation", async () => {
    const starred = node({ id: "starred", title: "Starred", isStarred: true });
    const outside = node({ id: "outside", title: "Outside" });
    const split = node({
      id: "split",
      parentId: null,
      sortKey: 1536,
      title: "Split"
    });
    let rejectScopedReload = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind === "starred") {
          if (rejectScopedReload) {
            throw new Error("Scoped reload failed");
          }
          return workspace([starred]);
        }
        return workspace([starred, outside]);
      }),
      splitNode: vi.fn().mockResolvedValue(workspace([starred, outside, split]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    expect(result.current.state.rootIds).toEqual(["starred"]);

    rejectScopedReload = true;
    await act(async () =>
      result.current.actions.splitNode(
        "starred",
        "split",
        "Star",
        "red"
      )
    );

    expect(result.current.error).toBe("Scoped reload failed");
    expect(result.current.libraryView).toBe("starred");
    expect(result.current.state.rootIds).toEqual(["starred"]);
    expect(result.current.state.nodesById.outside).toBeUndefined();
    expect(result.current.state.nodesById.split).toBeUndefined();
  });

  it.each(["update", "toggle", "duplicate", "restore"] as const)(
    "retains atomic %s authority when a non-active projection reload fails",
    async (operation) => {
      const deletedAt = "2026-07-12T00:00:00Z";
      const root = node({
        id: "root",
        title: "Before",
        isStarred: true,
        deletedAt: operation === "restore" ? deletedAt : null
      });
      const activeBefore = workspace([
        operation === "restore" ? node({ ...root, deletedAt: null }) : root,
        node({ id: "outside", sortKey: 2048 })
      ]);
      const scopedBefore = workspace([
        root,
        ...(operation === "duplicate"
          ? [node({ id: "outside", sortKey: 2048 })]
          : [])
      ]);
      const atomicWorkspace = workspace([
        node({
          ...root,
          title: operation === "update" ? "After" : root.title,
          isCollapsed: operation === "toggle",
          deletedAt: null
        }),
        node({ id: "outside", sortKey: 2048 }),
        ...(operation === "duplicate"
          ? [node({ id: "copy", sortKey: 3072, isStarred: true })]
          : [])
      ]);
      let rejectProjection = false;
      const loadWorkspace = vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind !== "active") {
          if (rejectProjection) {
            throw new Error("Projection reload failed");
          }
          return scopedBefore;
        }
        return activeBefore;
      });
      const atomicMutation = vi.fn((_vaultRoot, _input, context) =>
        Promise.resolve({
          workspace: atomicWorkspace,
          historyEntryId: context?.entryId ?? null,
          canUndo: true,
          canRedo: false
        })
      );
      const historyStatus = vi
        .fn()
        .mockResolvedValue({ canUndo: false, canRedo: false });
      const undo = vi.fn(async () => ({
        workspace: scopedBefore,
        replayedEntryId: atomicMutation.mock.calls[0]?.[2]?.entryId ?? null,
        canUndo: false,
        canRedo: true
      }));
      const store = repository({
        loadWorkspace,
        ...(operation === "update" ? { updateNode: atomicMutation } : {}),
        ...(operation === "toggle"
          ? { toggleComplete: atomicMutation }
          : {}),
        ...(operation === "duplicate"
          ? { duplicateNode: atomicMutation }
          : {}),
        ...(operation === "restore" ? { restoreNode: atomicMutation } : {}),
        historyStatus,
        undo
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({
          vaultRoot: `/projection-${operation}`,
          repository: store
        })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () =>
        result.current.actions.selectLibraryView(
          operation === "restore" ? "trash" : "starred"
        )
      );
      await act(async () => result.current.actions.focusNode("root"));
      const historyStatusCallsBeforeMutation = historyStatus.mock.calls.length;
      rejectProjection = true;

      await act(async () => {
        if (operation === "update") {
          await result.current.actions.updateNode("root", {
            title: "After",
            note: ""
          });
        } else if (operation === "toggle") {
          await result.current.actions.toggleComplete("root");
        } else if (operation === "duplicate") {
          await result.current.actions.duplicateNode("root");
        } else {
          await result.current.actions.restoreNode("root");
        }
      });

      expect(result.current.error).toBe("Projection reload failed");
      expect(result.current).toMatchObject({ canUndo: true, canRedo: false });
      expect(result.current.state.nodesById.outside).toBeDefined();
      expect(historyStatus).toHaveBeenCalledTimes(
        historyStatusCallsBeforeMutation
      );
      if (operation === "duplicate") {
        expect(result.current.state).toMatchObject({
          selectedId: "copy",
          editingNoteId: "copy",
          pendingFocusId: "copy",
          pendingFocusField: "title"
        });
      }

      await act(async () => result.current.actions.focusNode("outside"));
      await act(async () => result.current.actions.undo!());
      expect(result.current.state).toMatchObject({
        selectedId: "root",
        pendingFocusId: "root"
      });
    }
  );

  it("loads every active Move To node without replacing a filtered projection", async () => {
    const root = node({ id: "root", isStarred: true });
    const outside = node({ id: "outside", sortKey: 2048 });
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
      scope.kind === "starred" ? workspace([root]) : workspace([root, outside])
    );
    const store = repository({ loadWorkspace });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/move-targets", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.actions.selectLibraryView("starred")
    );
    expect(result.current.state.rootIds).toEqual(["root"]);

    const activeNodes = await result.current.loadActiveNodesForMove!();

    expect(activeNodes.map((item) => item.id)).toEqual(["root", "outside"]);
    expect(result.current.state.rootIds).toEqual(["root"]);
    expect(loadWorkspace).toHaveBeenLastCalledWith("/move-targets", {
      kind: "active"
    });
  });

  it("routes plain and validated structured search queries to their matching APIs", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const searchStructured = vi.fn().mockResolvedValue([]);
    const store = repository({ search, searchStructured });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.searchNotes("  roadmap notes  ");
    });
    expect(search).toHaveBeenCalledWith("/vault", "roadmap notes");
    expect(searchStructured).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.actions.searchNotes(
        "roadmap #Work -@Alice #Soon OR @Bob"
      );
    });
    expect(searchStructured).toHaveBeenCalledWith("/vault", {
      text: "roadmap",
      requiredTags: [
        { prefix: "#", normalizedTag: "work", displayTag: "Work" }
      ],
      excludedTags: [
        { prefix: "@", normalizedTag: "alice", displayTag: "Alice" }
      ],
      orGroups: [
        [
          { prefix: "#", normalizedTag: "soon", displayTag: "Soon" },
          { prefix: "@", normalizedTag: "bob", displayTag: "Bob" }
        ]
      ]
    });
    expect(search).toHaveBeenCalledOnce();

    const invalid = Array.from({ length: 65 }, (_, index) => `#tag${index}`)
      .join(" ");
    await expect(result.current.actions.searchNotes(invalid)).rejects.toThrow(
      "Structured Notes search has more than 64 unique tag alternatives."
    );
    expect(search).toHaveBeenCalledOnce();
    expect(searchStructured).toHaveBeenCalledOnce();
  });

  it("canonicalizes AND tag filters and restores the captured live location after the last removal", async () => {
    const active = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" }),
      node({ id: "other", sortKey: 2, title: "Other" })
    ]);
    const filtered = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" })
    ]);
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
      scope.kind === "tags" ? filtered : active
    );
    const store = repository({
      loadWorkspace,
      listTagsWithCounts: vi.fn().mockResolvedValue([
        {
          prefix: "#",
          normalizedTag: "work",
          displayTag: "Work",
          count: 2
        },
        {
          prefix: "@",
          normalizedTag: "alice",
          displayTag: "Alice",
          count: 1
        }
      ])
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.openSearchResult("child"));
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      zoomRootId: "root"
    });
    expect(result.current.locallyExpandedNodeIds).toEqual(new Set(["root"]));

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "@",
        normalizedTag: "alice"
      })
    );
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" },
      { prefix: "@", normalizedTag: "alice" }
    ]);
    expect(result.current.tagSummaries).toEqual([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 2
      },
      {
        prefix: "@",
        normalizedTag: "alice",
        displayTag: "Alice",
        count: 1
      }
    ]);
    expect(loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "tags",
      tags: [
        { prefix: "#", normalizedTag: "work" },
        { prefix: "@", normalizedTag: "alice" }
      ]
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.activeTagFilters).toEqual([
      { prefix: "@", normalizedTag: "alice" }
    ]);

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "@",
        normalizedTag: "alice"
      })
    );

    expect(result.current.activeTagFilters).toEqual([]);
    expect(result.current.libraryView).toBe("all");
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      zoomRootId: "root"
    });
    expect(result.current.locallyExpandedNodeIds).toEqual(new Set(["root"]));
    expect(loadWorkspace).toHaveBeenLastCalledWith("/vault", { kind: "active" });
  });

  it("restores an unzoomed library location instead of treating null as a missing node", async () => {
    const active = workspace([
      node({ id: "root", title: "Root" }),
      node({ id: "other", sortKey: 2, title: "Other" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? workspace([node({ id: "root" })]) : active
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.state).toMatchObject({
      selectedId: null,
      zoomRootId: null
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    expect(result.current.state).toMatchObject({
      selectedId: null,
      zoomRootId: null
    });
  });

  it("keeps an active filtered Tags view stable when its selected library control is clicked", async () => {
    const filtered = workspace([node({ id: "tagged", title: "Tagged" })]);
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? filtered : workspace([node({ id: "root" })])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    await act(async () => result.current.actions.selectLibraryView("tags"));

    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(result.current.state.nodesById.tagged).toBeDefined();
    expect(result.current.state.rootIds).toEqual(["tagged"]);
  });

  it("rolls back a failed first tag request so retrying the same filter adds it", async () => {
    const active = workspace([node({ id: "root" })]);
    const filtered = workspace([node({ id: "tagged" })]);
    const loadWorkspace = vi
      .fn()
      .mockResolvedValueOnce(active)
      .mockRejectedValueOnce(new Error("filter failed"))
      .mockResolvedValueOnce(filtered);
    const store = repository({ loadWorkspace });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.activeTagFilters).toEqual([]);
    expect(result.current.error).toBe("filter failed");

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(result.current.state.nodesById.tagged).toBeDefined();
    expect(loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "tags",
      tags: [{ prefix: "#", normalizedTag: "work" }]
    });
  });

  it("keeps a tag filter inactive when its counted summary refresh fails", async () => {
    const store = repository({
      listTagsWithCounts: vi.fn().mockRejectedValue(new Error("count failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    expect(result.current.activeTagFilters).toEqual([]);
    expect(result.current.libraryView).toBe("all");
  });

  it("refreshes tag counts and the filtered result after a local title save removes the sole tag", async () => {
    let current = node({ id: "root", title: "#Work" });
    const countedTags = () =>
      current.title.includes("#Work")
        ? [
            {
              prefix: "#" as const,
              normalizedTag: "work",
              displayTag: "Work",
              count: 1
            }
          ]
        : [];
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" && !current.title.includes("#Work")
          ? workspace([])
          : workspace([current])
      ),
      updateNode: vi.fn(async (_vaultRoot, input) => {
        current = { ...current, title: input.title, note: input.note };
        return workspace([current]);
      }),
      listTagsWithCounts: vi.fn(async () => countedTags())
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("tags"));
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.tagSummaries).toEqual(countedTags());

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "No tag",
        note: ""
      });
    });
    await act(async () => result.current.actions.flushNodeDraft("root"));

    await waitFor(() => expect(result.current.state.rootIds).toEqual([]));
    expect(result.current.tagSummaries).toEqual([]);
  });

  it("refreshes a filtered sibling's tag count and result after the editor removes the sole tag", async () => {
    let current = node({ id: "root", title: "#Work" });
    const countedTags = () =>
      current.title.includes("#Work")
        ? [
            {
              prefix: "#" as const,
              normalizedTag: "work",
              displayTag: "Work",
              count: 1
            }
          ]
        : [];
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" && !current.title.includes("#Work")
          ? workspace([])
          : workspace([current])
      ),
      updateNode: vi.fn(async (_vaultRoot, input) => {
        current = { ...current, title: input.title, note: input.note };
        return workspace([current]);
      }),
      listTagsWithCounts: vi.fn(async () => countedTags())
    });
    const viewer = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-tags", repository: store })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-tags", repository: store })
    );
    await waitFor(() => {
      expect(viewer.result.current.status).toBe("ready");
      expect(editor.result.current.status).toBe("ready");
    });
    await act(async () =>
      viewer.result.current.actions.selectLibraryView("tags")
    );
    await act(async () =>
      viewer.result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "No tag",
        note: ""
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));

    await waitFor(() => expect(viewer.result.current.state.rootIds).toEqual([]));
    expect(viewer.result.current.tagSummaries).toEqual([]);
  });

  it("coalesces tag count invalidations and ignores a stale response", async () => {
    let current = node({ id: "root", title: "#Work" });
    const staleCounts = deferred<
      Array<{
        prefix: "#";
        normalizedTag: string;
        displayTag: string;
        count: number;
      }>
    >();
    const latestCounts = deferred<[]>();
    const listTagsWithCounts = vi.fn().mockResolvedValue([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1
      }
    ]);
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" && !current.title.includes("#Work")
          ? workspace([])
          : workspace([current])
      ),
      updateNode: vi.fn(async (_vaultRoot, input) => {
        current = { ...current, title: input.title, note: input.note };
        return workspace([current]);
      }),
      listTagsWithCounts
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("tags"));
    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    listTagsWithCounts.mockReset();
    listTagsWithCounts
      .mockReturnValueOnce(staleCounts.promise)
      .mockReturnValueOnce(latestCounts.promise);

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "Still #Work",
        note: ""
      });
    });
    await act(async () => result.current.actions.flushNodeDraft("root"));
    await waitFor(() => expect(listTagsWithCounts).toHaveBeenCalledOnce());

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "No tag",
        note: ""
      });
    });
    await act(async () => result.current.actions.flushNodeDraft("root"));
    await act(async () => staleCounts.resolve([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work stale",
        count: 99
      }
    ]));

    await waitFor(() => expect(listTagsWithCounts).toHaveBeenCalledTimes(2));
    expect(result.current.tagSummaries).toEqual([
      {
        prefix: "#",
        normalizedTag: "work",
        displayTag: "Work",
        count: 1
      }
    ]);

    await act(async () => latestCounts.resolve([]));
    await waitFor(() => expect(result.current.tagSummaries).toEqual([]));
  });

  it("restores tag filters and their prior live location through Undo snapshots", async () => {
    const active = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" }),
      node({ id: "other", sortKey: 2, title: "Other" })
    ]);
    const filtered = workspace([
      node({ id: "root", title: "Root", isCollapsed: true }),
      node({ id: "child", parentId: "root", title: "Child" })
    ]);
    let replayedEntryId: string | null = null;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "tags" ? filtered : active
      ),
      toggleStar: vi.fn().mockResolvedValue(active),
      undo: vi.fn().mockImplementation(async () => ({
        workspace: active,
        replayedEntryId,
        canUndo: false,
        canRedo: true
      }))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.zoomTo("other");
      await result.current.actions.focusNode("other");
      await result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      });
      await result.current.actions.zoomTo("root");
      await result.current.actions.focusNode("child");
      await result.current.actions.toggleStar("child");
    });
    replayedEntryId = vi.mocked(store.toggleStar).mock.calls[0][2]?.entryId ?? null;

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other"
    });

    await act(async () => result.current.actions.undo?.());
    expect(result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(result.current.state).toMatchObject({
      selectedId: "child",
      zoomRootId: "root"
    });

    await act(async () =>
      result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    expect(result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other"
    });
  });

  it("gates hook actions while Notes data deletion is in progress", async () => {
    const deletion = deferred<void>();
    const store = repository({
      deleteDatabase: vi.fn().mockReturnValue(deletion.promise),
      createNode: vi.fn().mockResolvedValue(workspace([node({ id: "created" })])),
      updateNode: vi.fn().mockResolvedValue(workspace([node({ id: "updated" })]))
    });
    createNoteIdMock.mockReturnValue("created");
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let deletionCompletion!: Promise<void>;
    act(() => {
      deletionCompletion = result.current.actions.deleteAllNotesData();
    });
    await waitFor(() => expect(store.deleteDatabase).toHaveBeenCalledOnce());
    expect(result.current.deletingNotesData).toBe(true);

    await act(async () => {
      result.current.actions.updateNodeDraft("root", {
        title: "Blocked draft",
        note: ""
      });
      await Promise.all([
        result.current.actions.createRoot(),
        result.current.actions.updateNode("root", {
          title: "Blocked update",
          note: ""
        }),
        result.current.actions.selectLibraryView("recent"),
        result.current.actions.searchNotes("blocked")
      ]);
    });

    expect(store.createNode).not.toHaveBeenCalled();
    expect(store.updateNode).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(result.current.draftsByNodeId.root).toBeUndefined();

    await act(async () => {
      deletion.resolve();
      await deletionCompletion;
    });

    expect(result.current.deletingNotesData).toBe(false);
    expect(result.current.state.rootIds).toEqual([]);
    expect(store.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("releases the deletion gate and retains a draft when flushing fails", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("Draft save failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "Recoverable draft",
        note: "Keep me"
      });
    });

    await act(async () => {
      await expect(
        result.current.actions.deleteAllNotesData()
      ).rejects.toThrow("Draft save failed");
    });

    expect(store.deleteDatabase).not.toHaveBeenCalled();
    expect(result.current.deletingNotesData).toBe(false);
    expect(result.current.draftsByNodeId.root).toMatchObject({
      title: "Recoverable draft",
      note: "Keep me",
      status: "failed"
    });
    expect(result.current.state.nodesById.root).toBeDefined();
  });

  it("coalesces rapid node drafts and writes the latest patch after 300 ms", async () => {
    const store = repository({
      updateNode: vi.fn((_vaultRoot, input) =>
        Promise.resolve(
          workspace([
            node({ id: "root", title: input.title, note: input.note })
          ])
        )
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    vi.useFakeTimers();

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "first draft",
        note: ""
      });
      result.current.actions.updateNodeDraft("root", {
        title: "latest draft",
        note: "latest note"
      });
    });

    expect(result.current.draftsByNodeId.root).toMatchObject({
      title: "latest draft",
      note: "latest note"
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(store.updateNode).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "root",
        title: "latest draft",
        note: "latest note"
      },
      historyContext("text")
    );
  });

  it("keeps a pending draft and split in one coordinator command", async () => {
    const draftWrite = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    const before = workspace([
      node({ id: "source", title: "source" }),
      node({ id: "other", sortKey: 2048, title: "other" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      updateNode: vi.fn((_vaultRoot, input) => {
        invocations.push(`update:${input.id}`);
        return input.id === "source"
          ? draftWrite.promise
          : Promise.resolve(before);
      }),
      splitNode: vi.fn().mockImplementation(async () => {
        invocations.push("split");
        return before;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("source", {
        title: "source edited",
        note: ""
      });
    });
    let splitCompletion!: Promise<void>;
    let otherCompletion!: Promise<void>;
    act(() => {
      splitCompletion = result.current.actions.splitNode(
        "source",
        "new-node",
        "source",
        " edited"
      );
      otherCompletion = result.current.actions.updateNode("other", {
        title: "other edited",
        note: ""
      });
    });
    await waitFor(() => expect(invocations).toEqual(["update:source"]));

    await act(async () =>
      draftWrite.resolve(
        workspace([
          node({ id: "source", title: "source edited" }),
          node({ id: "other", sortKey: 2048, title: "other" })
        ])
      )
    );
    await act(async () => Promise.all([splitCompletion, otherCompletion]));

    expect(invocations).toEqual(["update:source", "split", "update:other"]);
  });

  it("orders a pending text burst before split with stable distinct history IDs", async () => {
    const initial = workspace([node({ id: "source", title: "source" })]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode: vi.fn().mockResolvedValue(
        workspace([node({ id: "source", title: "source edited" })])
      ),
      splitNode: vi.fn().mockResolvedValue(
        workspace([
          node({ id: "source", title: "source" }),
          node({ id: "split", sortKey: 2048, title: "edited" })
        ])
      )
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source e", note: "" },
        "title"
      );
      result.current.actions.updateNodeDraft(
        "source",
        { title: "source edited", note: "" },
        "title"
      );
    });
    await act(async () =>
      result.current.actions.splitNode("source", "split", "source", " edited")
    );

    const textContext = vi.mocked(store.updateNode).mock.calls[0]?.[2];
    const splitContext = vi.mocked(store.splitNode).mock.calls[0]?.[2];
    expect(textContext).toMatchObject({ commandKind: "text" });
    expect(splitContext).toMatchObject({ commandKind: "split" });
    expect(textContext?.sessionId).toBe(splitContext?.sessionId);
    expect(textContext?.entryId).not.toBe(splitContext?.entryId);
    expect(textContext?.entryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(textContext?.entryId).not.toBe("source");
  });

  it("orders cross-node edits after a structural cutoff behind structural work", async () => {
    const initial = workspace([
      node({ id: "draft", title: "before" }),
      node({ id: "target", sortKey: 2048, title: "target" })
    ]);
    const firstWrite = deferred<NotesWorkspace>();
    const updateNode = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(
        workspace([
          node({ id: "draft", title: "second" }),
          node({ id: "target", sortKey: 2048, title: "target" })
        ])
      );
    const splitNode = vi.fn().mockResolvedValue(initial);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      splitNode
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft(
        "draft",
        { title: "first", note: "" },
        "title"
      );
    });
    let structural!: Promise<void>;
    act(() => {
      structural = result.current.actions.splitNode(
        "target",
        "split",
        "tar",
        "get"
      );
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      result.current.actions.updateNodeDraft(
        "draft",
        { title: "second", note: "" },
        "title"
      );
    });
    await act(async () => firstWrite.resolve(initial));
    await act(async () => structural);
    await act(async () => result.current.actions.flushAllDrafts());

    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(splitNode.mock.invocationCallOrder[0]).toBeLessThan(
      updateNode.mock.invocationCallOrder[1]!
    );
    expect(updateNode.mock.calls[0]?.[2]?.entryId).not.toBe(
      updateNode.mock.calls[1]?.[2]?.entryId
    );
    expect(updateNode.mock.calls[1]?.[2]?.entryId).not.toBe(
      splitNode.mock.calls[0]?.[2]?.entryId
    );
  });

  it("orders sibling-hook drafts after a shared structural cutoff", async () => {
    const initial = workspace([
      node({ id: "draft", title: "before" }),
      node({ id: "target", sortKey: 2048 })
    ]);
    const firstWrite = deferred<NotesWorkspace>();
    const updateNode = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(initial);
    const toggleStar = vi.fn().mockResolvedValue(
      workspace([
        node({ id: "draft", title: "second" }),
        node({ id: "target", sortKey: 2048, isStarred: true })
      ])
    );
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-barrier", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared-barrier", repository: store })
    );
    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
    });

    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "first", note: "" },
        "title"
      );
    });
    let structural!: Promise<void>;
    act(() => {
      structural = second.result.current.actions.toggleStar("target");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "second", note: "" },
        "title"
      );
    });
    await act(async () => firstWrite.resolve(initial));
    await act(async () => structural);
    await act(async () => first.result.current.actions.flushAllDrafts());

    expect(updateNode).toHaveBeenCalledTimes(2);
    expect(toggleStar.mock.invocationCallOrder[0]).toBeLessThan(
      updateNode.mock.invocationCallOrder[1]!
    );
    expect(updateNode.mock.calls[0]?.[2]?.entryId).not.toBe(
      updateNode.mock.calls[1]?.[2]?.entryId
    );

    act(() => {
      first.result.current.actions.updateNodeDraft(
        "draft",
        { title: "after", note: "" },
        "title"
      );
    });
    await act(async () => first.result.current.actions.flushAllDrafts());
    expect(toggleStar.mock.invocationCallOrder[0]).toBeLessThan(
      updateNode.mock.invocationCallOrder[2]!
    );
    expect(updateNode.mock.calls[2]?.[2]?.entryId).not.toBe(
      updateNode.mock.calls[1]?.[2]?.entryId
    );
  });

  it("orders typing after the structural cutoff behind the structural command", async () => {
    const initial = workspace([
      node({ id: "draft-a" }),
      node({ id: "draft-b", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedB = deferred<NotesWorkspace>();
    const order: string[] = [];
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      return input.id === "draft-b"
        ? blockedB.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/epoch-hooks", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/epoch-hooks", repository: store })
    );
    const structuralOwner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/epoch-hooks", repository: store })
    );
    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
      expect(structuralOwner.result.current.status).toBe("ready");
    });
    act(() => {
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "first",
        note: ""
      });
      second.result.current.actions.updateNodeDraft("draft-b", {
        title: "blocked",
        note: ""
      });
    });

    const structural = structuralOwner.result.current.actions.toggleStar(
      "target"
    );
    await waitFor(() =>
      expect(order).toEqual([
        "update:draft-a:first",
        "update:draft-b:blocked"
      ])
    );
    act(() => {
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "second",
        note: ""
      });
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "third",
        note: ""
      });
      first.result.current.actions.updateNodeDraft("draft-a", {
        title: "latest",
        note: ""
      });
    });
    blockedB.resolve(initial);
    await act(async () => structural);
    await act(async () => first.result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:draft-a:first",
      "update:draft-b:blocked",
      "structural",
      "update:draft-a:latest"
    ]);
  });

  it("keeps same-hook post-cutoff fields distinct behind a queued pre-cutoff write", async () => {
    const initial = workspace([
      node({ id: "root", title: "before", note: "before note" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const preCutoffSaved = workspace([
      node({ id: "root", title: "pre-cutoff", note: "before note" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const titleSaved = workspace([
      node({ id: "root", title: "title edit", note: "before note" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const noteSaved = workspace([
      node({ id: "root", title: "title edit", note: "note edit" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 }),
      node({ id: "other", sortKey: 4096 })
    ]);
    const blockerWrite = deferred<NotesWorkspace>();
    const order: string[] = [];
    const updateNode = vi.fn((_vaultRoot, input, _context) => {
      order.push(`update:${input.id}:${input.title}:${input.note}`);
      if (input.id === "blocker") {
        return blockerWrite.promise;
      }
      return Promise.resolve(
        input.note === "note edit"
          ? noteSaved
          : input.title === "title edit"
            ? titleSaved
            : preCutoffSaved
      );
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    let undoIndex = 0;
    const undo = vi.fn(async () => {
      const rootCalls = updateNode.mock.calls.filter(
        ([, input]) => input.id === "root"
      );
      const callIndex = undoIndex++;
      return {
        workspace: callIndex === 0 ? titleSaved : preCutoffSaved,
        replayedEntryId:
          rootCalls[callIndex === 0 ? 2 : 1]?.[2]?.entryId ?? null,
        canUndo: callIndex === 0,
        canRedo: true
      };
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/cutoff-field", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let blockerFlush!: Promise<boolean>;
    act(() => {
      result.current.actions.updateNodeDraft(
        "blocker",
        { title: "blocking", note: "" },
        "title"
      );
      blockerFlush = result.current.actions.flushNodeDraft("blocker");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "pre-cutoff", note: "before note" },
        "title"
      );
    });
    let structural!: Promise<void>;
    act(() => {
      structural = result.current.actions.toggleStar("target");
    });

    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "before note" },
        "title"
      );
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "note edit" },
        "note"
      );
    });
    expect(updateNode).toHaveBeenCalledOnce();

    await act(async () => {
      blockerWrite.resolve(initial);
      await Promise.all([blockerFlush, structural]);
    });
    await act(async () => result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:blocker:blocking:",
      "update:root:pre-cutoff:before note",
      "structural",
      "update:root:title edit:before note",
      "update:root:title edit:note edit"
    ]);
    const rootCalls = updateNode.mock.calls.filter(
      ([, input]) => input.id === "root"
    );
    expect(rootCalls).toHaveLength(3);
    expect(rootCalls[1]?.[2]?.entryId).not.toBe(rootCalls[2]?.[2]?.entryId);

    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "note"
    });
    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("retires a same-hook stale-marker owner when its node disappears", async () => {
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
      "10000000-0000-4000-8000-000000000006"
    ] as const;
    let idIndex = 0;
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => ids[idIndex++] ?? ids.at(-1)!);
    try {
      const initial = workspace([
        node({ id: "root", title: "", note: "" }),
        node({ id: "blocker", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const removed = workspace([
        node({ id: "blocker", sortKey: 2048 }),
        node({ id: "other", sortKey: 3072 })
      ]);
      const blockerWrite = deferred<NotesWorkspace>();
      const updateNode = vi.fn((_vaultRoot, input) =>
        input.id === "blocker"
          ? blockerWrite.promise
          : Promise.resolve(initial)
      );
      const undo = vi.fn(async () => ({
        workspace: removed,
        replayedEntryId: ids[3],
        canUndo: false,
        canRedo: true
      }));
      const store = repository({
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        updateNode,
        removeEmptyNode: vi.fn().mockResolvedValue(removed),
        undo
      });
      const { result } = renderHook(() =>
        useNotesWorkspace({ vaultRoot: "/retire-field", repository: store })
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      let blockerFlush!: Promise<boolean>;
      act(() => {
        result.current.actions.updateNodeDraft("blocker", {
          title: "blocking",
          note: ""
        });
        blockerFlush = result.current.actions.flushNodeDraft("blocker");
      });
      await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
      act(() => {
        result.current.actions.updateNodeDraft(
          "root",
          { title: "", note: "" },
          "title"
        );
      });
      let removal!: Promise<void>;
      act(() => {
        removal = result.current.actions.removeEmptyNode("root", "other");
      });
      act(() => {
        result.current.actions.updateNodeDraft(
          "root",
          { title: "title edit", note: "" },
          "title"
        );
        result.current.actions.updateNodeDraft(
          "root",
          { title: "title edit", note: "note edit" },
          "note"
        );
      });
      expect(randomUUID.mock.results[3]?.value).toBe(ids[3]);

      await act(async () => {
        blockerWrite.resolve(initial);
        await Promise.all([blockerFlush, removal]);
      });
      await act(async () => result.current.actions.flushAllDrafts());
      await act(async () => result.current.actions.focusNode("other"));
      await act(async () => result.current.actions.undo!());

      expect(result.current.state).toMatchObject({
        selectedId: "other",
        pendingFocusId: "other"
      });
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("retries the failed pre-cutoff snapshot before post-click typing", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedWrite = deferred<NotesWorkspace>();
    const order: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      return input.id === "blocker"
        ? blockedWrite.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const blocker = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-cutoff", repository: store })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/failed-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(blocker.result.current.status).toBe("ready");
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "before click",
        note: "before note"
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "after click",
        note: "after note"
      });
    });

    blockedWrite.resolve(initial);
    await act(async () => structural);
    await act(async () => editor.result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:root:before click",
      "update:blocker:blocking",
      "update:root:before click",
      "structural",
      "update:root:after click"
    ]);
    const rootCalls = vi
      .mocked(store.updateNode)
      .mock.calls.filter(([, input]) => input.id === "root");
    expect(rootCalls[1]?.[1]).toMatchObject({
      title: "before click",
      note: "before note"
    });
    expect(rootCalls[1]?.[2]?.entryId).not.toBe(rootCalls[2]?.[2]?.entryId);
  });

  it("keeps explicit failed retry immutable during a structural cutoff", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedWrite = deferred<NotesWorkspace>();
    const order: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      return input.id === "blocker"
        ? blockedWrite.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const blocker = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/explicit-cutoff", repository: store })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/explicit-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/explicit-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(blocker.result.current.status).toBe("ready");
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "failed value",
        note: "failed note"
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "new value",
        note: "new note"
      });
    });
    const retry = editor.result.current.retryFailedDraft("root");

    blockedWrite.resolve(initial);
    await act(async () => Promise.all([retry, structural]));
    await act(async () => editor.result.current.actions.flushAllDrafts());

    expect(order).toEqual([
      "update:root:failed value",
      "update:blocker:blocking",
      "update:root:failed value",
      "structural",
      "update:root:new value"
    ]);
  });

  it("shuts down with the captured failed snapshot during a cutoff", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 }),
      node({ id: "target", sortKey: 3072 })
    ]);
    const blockedWrite = deferred<NotesWorkspace>();
    const order: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input) => {
      order.push(`update:${input.id}:${input.title}`);
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      return input.id === "blocker"
        ? blockedWrite.promise
        : Promise.resolve(initial);
    });
    const toggleStar = vi.fn().mockImplementation(async () => {
      order.push("structural");
      return initial;
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      toggleStar
    });
    const blocker = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shutdown-cutoff", repository: store })
    );
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shutdown-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shutdown-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(blocker.result.current.status).toBe("ready");
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "shutdown value",
        note: "shutdown note"
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      blocker.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
    });
    const structural = requester.result.current.actions.toggleStar("target");
    await waitFor(() =>
      expect(order.at(-1)).toBe("update:blocker:blocking")
    );
    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "post-click value",
        note: "post-click note"
      });
    });
    editor.unmount();

    blockedWrite.resolve(initial);
    await act(async () => structural);

    expect(order).toEqual([
      "update:root:shutdown value",
      "update:blocker:blocking",
      "update:root:shutdown value",
      "structural"
    ]);
  });

  it("admits one failed retry when cutoff, explicit retry, and shutdown race", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "blocker", sortKey: 2048 })
    ]);
    const blockedWrite = deferred<NotesWorkspace>();
    const successfulEntryIds: string[] = [];
    let rootAttempt = 0;
    const updateNode = vi.fn((_vaultRoot, input, history) => {
      if (input.id === "root" && rootAttempt++ === 0) {
        return Promise.reject(new Error("disk full"));
      }
      if (input.id === "blocker") {
        return blockedWrite.promise;
      }
      if (input.id === "root" && history) {
        successfulEntryIds.push(history.entryId);
      }
      return Promise.resolve(initial);
    });
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: successfulEntryIds.at(-1) ?? null,
      canUndo: successfulEntryIds.length > 1,
      canRedo: successfulEntryIds.length > 0
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const editor = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reserved-cutoff", repository: store })
    );
    const requester = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/reserved-cutoff", repository: store })
    );
    await waitFor(() => {
      expect(editor.result.current.status).toBe("ready");
      expect(requester.result.current.status).toBe("ready");
    });

    act(() => {
      editor.result.current.actions.updateNodeDraft("root", {
        title: "failed value",
        note: "failed note"
      });
    });
    await act(async () => editor.result.current.actions.flushNodeDraft("root"));
    act(() => {
      editor.result.current.actions.updateNodeDraft("blocker", {
        title: "blocking",
        note: ""
      });
    });
    const blockerFlush = editor.result.current.actions.flushNodeDraft("blocker");
    await waitFor(() =>
      expect(updateNode.mock.calls.at(-1)?.[1].id).toBe("blocker")
    );

    const replay = requester.result.current.actions.undo!();
    await Promise.resolve();
    const explicitRetry = editor.result.current.retryFailedDraft("root");
    editor.unmount();

    blockedWrite.resolve(initial);
    await act(async () =>
      Promise.all([blockerFlush, explicitRetry, replay])
    );

    const rootCalls = vi
      .mocked(store.updateNode)
      .mock.calls.filter(([, input]) => input.id === "root");
    expect(rootCalls).toHaveLength(2);
    expect(successfulEntryIds).toHaveLength(1);
    expect(new Set(successfulEntryIds).size).toBe(1);
    expect(undo).toHaveBeenCalledOnce();
    expect(requester.result.current.canUndo).toBe(false);
    expect(requester.result.current.canRedo).toBe(true);
  });

  it("flushes a visible note draft before undo and restores field-aware UI", async () => {
    const initial = workspace([
      node({ id: "root", title: "before" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const updateNode = vi.fn().mockResolvedValue(
      workspace([
        node({ id: "root", title: "before", note: "supporting" }),
        node({ id: "other", sortKey: 2048 })
      ])
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: updateNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
    });
    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "before", note: "supporting" },
        "note"
      );
    });
    let replay!: Promise<void>;
    act(() => {
      replay = result.current.actions.undo!();
    });
    await act(async () => replay);

    expect(updateNode.mock.invocationCallOrder[0]).toBeLessThan(
      undo.mock.invocationCallOrder[0]!
    );
    expect(undo).toHaveBeenCalledWith(
      "/vault",
      updateNode.mock.calls[0]?.[2]?.sessionId,
      { kind: "active" }
    );
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      zoomRootId: "root",
      pendingFocusId: "root",
      pendingFocusField: "note"
    });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it("separates a fast title-to-note transition into field-aware Undo entries", async () => {
    const initial = workspace([
      node({ id: "root", title: "before", note: "before note" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const titleSaved = workspace([
      node({ id: "root", title: "title edit", note: "before note" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const noteSaved = workspace([
      node({ id: "root", title: "title edit", note: "note edit" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const titleWrite = deferred<NotesMutationResult>();
    const noteWrite = deferred<NotesMutationResult>();
    const updateNode = vi
      .fn()
      .mockReturnValueOnce(titleWrite.promise)
      .mockReturnValueOnce(noteWrite.promise);
    let undoIndex = 0;
    const undo = vi.fn(async () => {
      const callIndex = undoIndex++;
      return {
        workspace: callIndex === 0 ? titleSaved : initial,
        replayedEntryId:
          updateNode.mock.calls[callIndex === 0 ? 1 : 0]?.[2]?.entryId ?? null,
        canUndo: callIndex === 0,
        canRedo: true
      };
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      updateNode,
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/field-transition", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "before note" },
        "title"
      );
    });
    let titleFlush!: Promise<boolean>;
    act(() => {
      titleFlush = result.current.actions.flushNodeDraft("root");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledOnce());

    act(() => {
      result.current.actions.updateNodeDraft(
        "root",
        { title: "title edit", note: "note edit" },
        "note"
      );
    });
    const titleContext = updateNode.mock.calls[0]?.[2];
    await act(async () => {
      titleWrite.resolve({
        workspace: titleSaved,
        historyEntryId: titleContext?.entryId ?? null,
        canUndo: true,
        canRedo: false
      });
      await titleFlush;
    });

    let noteFlush!: Promise<boolean>;
    act(() => {
      noteFlush = result.current.actions.flushNodeDraft("root");
    });
    await waitFor(() => expect(updateNode).toHaveBeenCalledTimes(2));
    const noteContext = updateNode.mock.calls[1]?.[2];
    await act(async () => {
      noteWrite.resolve({
        workspace: noteSaved,
        historyEntryId: noteContext?.entryId ?? null,
        canUndo: true,
        canRedo: false
      });
      await noteFlush;
    });

    expect(titleContext?.entryId).not.toBe(noteContext?.entryId);

    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "note"
    });

    await act(async () => result.current.actions.focusNode("other"));
    await act(async () => result.current.actions.undo!());
    expect(result.current.state).toMatchObject({
      selectedId: "root",
      pendingFocusId: "root",
      pendingFocusField: "title"
    });
  });

  it("applies replayed backend data and normalizes live UI without a snapshot", async () => {
    const initial = workspace([node({ id: "root" })]);
    const undo = vi.fn().mockResolvedValue({
      workspace: workspace([node({ id: "other" })]),
      replayedEntryId: "90000000-0000-4000-8000-000000000009",
      canUndo: false,
      canRedo: true
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      undo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.actions.focusNode("root");
      await result.current.actions.zoomTo("root");
      await result.current.actions.undo!();
    });

    expect(result.current.state.nodesById.other).toBeDefined();
    expect(result.current.state).toMatchObject({
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null
    });
  });

  it("lets the backend invalidate redo after a new structural mutation", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const completed = workspace([
      node({ id: "root", isStarred: false, completedAt: "2026-07-11T00:00:00Z" })
    ]);
    const toggleStar = vi.fn().mockResolvedValue(starred);
    const toggleComplete = vi.fn().mockResolvedValue(completed);
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const redo = vi.fn().mockResolvedValue({
      workspace: completed,
      replayedEntryId: null,
      canUndo: true,
      canRedo: false
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      toggleComplete,
      undo,
      redo
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.toggleStar("root"));
    await act(async () => result.current.actions.undo!());
    await act(async () => result.current.actions.toggleComplete("root"));
    await act(async () => result.current.actions.redo!());

    expect(toggleComplete.mock.calls[0]?.[2]?.entryId).not.toBe(
      toggleStar.mock.calls[0]?.[2]?.entryId
    );
    expect(redo).toHaveBeenCalledWith(
      "/vault",
      toggleStar.mock.calls[0]?.[2]?.sessionId,
      { kind: "active" }
    );
    expect(result.current.state.nodesById.root.completedAt).not.toBeNull();
  });

  it("broadcasts mutation and replay authority to sibling hooks without replacing local navigation", async () => {
    const initial = workspace([node({ id: "root" })]);
    const starred = workspace([node({ id: "root", isStarred: true })]);
    const toggleStar = vi.fn().mockResolvedValue(starred);
    const undo = vi.fn().mockResolvedValue({
      workspace: initial,
      replayedEntryId: null,
      canUndo: false,
      canRedo: true
    });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      toggleStar,
      undo
    });
    const first = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: store })
    );
    const second = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: store })
    );
    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
    });
    await act(async () => second.result.current.actions.zoomTo("root"));

    await act(async () => first.result.current.actions.toggleStar("root"));
    await waitFor(() =>
      expect(second.result.current.state.nodesById.root?.isStarred).toBe(true)
    );
    expect(second.result.current.state.zoomRootId).toBe("root");

    await act(async () => first.result.current.actions.undo!());
    await waitFor(() =>
      expect(second.result.current.state.nodesById.root?.isStarred).toBe(false)
    );
    expect(second.result.current.state.zoomRootId).toBe("root");
  });

  it("keeps owner-only split snapshots out of sibling replay after owner unmount", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const splitResult = deferred<NotesWorkspace>();
    const splitNode = vi.fn().mockReturnValue(splitResult.promise);
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: initial,
      replayedEntryId: splitNode.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      splitNode,
      undo
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/owner-replay", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/owner-replay", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    await act(async () => {
      await sibling.result.current.actions.focusNode("other");
      await sibling.result.current.actions.zoomTo("other");
    });

    const split = owner.result.current.actions.splitNode(
      "root",
      "split",
      "ro",
      "ot"
    );
    await waitFor(() => expect(splitNode).toHaveBeenCalledOnce());
    owner.unmount();
    splitResult.resolve(
      workspace([
        node({ id: "root", title: "ro" }),
        node({ id: "split", parentId: null, sortKey: 1536, title: "ot" }),
        node({ id: "other", sortKey: 2048 })
      ])
    );
    await act(async () => split);
    await waitFor(() =>
      expect(sibling.result.current.state.nodesById.split).toBeDefined()
    );
    expect(sibling.result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other",
      pendingFocusId: "other"
    });

    await act(async () => sibling.result.current.actions.undo!());
    expect(sibling.result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other",
      pendingFocusId: "other"
    });
  });

  it("broadcasts replay authority when the replay owner unmounts after commit", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const replay = deferred<{
      workspace: NotesWorkspace;
      replayedEntryId: string | null;
      canUndo: boolean;
      canRedo: boolean;
    }>();
    const undo = vi.fn().mockReturnValue(replay.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      undo
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-unmount", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/replay-unmount", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    await act(async () => {
      await sibling.result.current.actions.focusNode("other");
      await sibling.result.current.actions.zoomTo("other");
    });

    const completion = owner.result.current.actions.undo!();
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    owner.unmount();
    replay.resolve({
      workspace: workspace([
        node({ id: "after-undo" }),
        node({ id: "other", sortKey: 2048 })
      ]),
      replayedEntryId: null,
      canUndo: false,
      canRedo: true
    });
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById["after-undo"]).toBeDefined()
    );
    expect(sibling.result.current).toMatchObject({
      canUndo: false,
      canRedo: true
    });
    expect(sibling.result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other",
      pendingFocusId: "other"
    });
  });

  it("broadcasts archive authority when the lifecycle owner unmounts after commit", async () => {
    const initial = workspace([
      node({ id: "root" }),
      node({ id: "other", sortKey: 2048 })
    ]);
    const archived = deferred<NotesWorkspace>();
    const archiveNode = vi.fn().mockReturnValue(archived.promise);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      archiveNode
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-unmount", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-unmount", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    await act(async () => {
      await sibling.result.current.actions.focusNode("other");
      await sibling.result.current.actions.zoomTo("other");
    });

    const completion = owner.result.current.actions.archiveNode("root");
    await waitFor(() => expect(archiveNode).toHaveBeenCalledOnce());
    owner.unmount();
    archived.resolve(workspace([node({ id: "other" })]));
    await act(async () => completion);

    await waitFor(() =>
      expect(sibling.result.current.state.nodesById.root).toBeUndefined()
    );
    expect(sibling.result.current.state).toMatchObject({
      selectedId: "other",
      zoomRootId: "other",
      pendingFocusId: "other"
    });
  });

  it("reloads an Archive sibling when its lifecycle owner unmounts after commit", async () => {
    const active = workspace([node({ id: "active-root" })]);
    const archived = workspace([
      node({
        id: "archive-root",
        archivedAt: "2026-07-11T00:00:00Z"
      }),
      node({
        id: "archive-other",
        sortKey: 2048,
        archivedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    const afterUnarchive = workspace([
      node({ id: "active-root" }),
      node({ id: "archive-root", sortKey: 2048 })
    ]);
    const committed = deferred<NotesWorkspace>();
    const loadWorkspace = vi.fn((_vaultRoot, scope) =>
      Promise.resolve(scope?.kind === "archive" ? archived : active)
    );
    const store = repository({
      loadWorkspace,
      unarchiveNode: vi.fn().mockReturnValue(committed.promise)
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-ownerless", repository: store })
    );
    const sibling = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/archive-ownerless", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(sibling.result.current.status).toBe("ready");
    });
    await act(async () => {
      await owner.result.current.actions.selectLibraryView("archive");
      await sibling.result.current.actions.selectLibraryView("archive");
    });

    const completion = owner.result.current.actions.unarchiveNode("archive-root");
    await waitFor(() => expect(store.unarchiveNode).toHaveBeenCalledOnce());
    owner.unmount();
    committed.resolve(afterUnarchive);
    await act(async () => completion);

    await waitFor(() =>
      expect(
        loadWorkspace.mock.calls.filter(([, scope]) => scope?.kind === "archive")
      ).toHaveLength(3)
    );
    expect(sibling.result.current.state.nodesById["archive-other"]).toBeDefined();
    expect(sibling.result.current.state.nodesById["active-root"]).toBeUndefined();
  });

  it("reloads each sibling's own scope instead of installing the owner's projection", async () => {
    const active = workspace([node({ id: "active-root" })]);
    const archived = workspace([
      node({ id: "archive-root", archivedAt: "2026-07-11T00:00:00Z" })
    ]);
    const loadWorkspace = vi.fn((_vaultRoot, scope) =>
      Promise.resolve(scope?.kind === "archive" ? archived : active)
    );
    const toggleStar = vi.fn().mockResolvedValue(
      workspace([node({ id: "active-root", isStarred: true })])
    );
    const store = repository({ loadWorkspace, toggleStar });
    const all = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/scoped-siblings", repository: store })
    );
    const archive = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/scoped-siblings", repository: store })
    );
    await waitFor(() => {
      expect(all.result.current.status).toBe("ready");
      expect(archive.result.current.status).toBe("ready");
    });
    await act(async () =>
      archive.result.current.actions.selectLibraryView("archive")
    );
    expect(archive.result.current.state.nodesById["archive-root"]).toBeDefined();

    await act(async () => all.result.current.actions.toggleStar("active-root"));

    await waitFor(() =>
      expect(
        loadWorkspace.mock.calls.filter(([, scope]) => scope?.kind === "archive")
      ).toHaveLength(2)
    );
    expect(archive.result.current.state.nodesById["archive-root"]).toBeDefined();
    expect(archive.result.current.state.nodesById["active-root"]).toBeUndefined();
    expect(all.result.current.state.nodesById["active-root"]?.isStarred).toBe(
      true
    );
  });

  it("keeps canonical tag and active scopes independent across coordinated hooks", async () => {
    let starred = false;
    const activeWorkspace = () =>
      workspace([
        node({ id: "active-root", isStarred: starred }),
        node({ id: "outside", sortKey: 2 })
      ]);
    const taggedWorkspace = () =>
      workspace([node({ id: "active-root", isStarred: starred })]);
    const loadWorkspace = vi.fn(async (_vaultRoot, scope) =>
      scope.kind === "tags" ? taggedWorkspace() : activeWorkspace()
    );
    const store = repository({
      loadWorkspace,
      toggleStar: vi.fn().mockImplementation(async () => {
        starred = true;
        return activeWorkspace();
      })
    });
    const tagged = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/tag-siblings", repository: store })
    );
    const all = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/tag-siblings", repository: store })
    );
    await waitFor(() => {
      expect(tagged.result.current.status).toBe("ready");
      expect(all.result.current.status).toBe("ready");
    });

    await act(async () =>
      tagged.result.current.actions.toggleTagFilter({
        prefix: "#",
        normalizedTag: "work"
      })
    );
    await act(async () =>
      tagged.result.current.actions.toggleStar("active-root")
    );

    await waitFor(() => {
      expect(tagged.result.current.state.nodesById["active-root"]?.isStarred)
        .toBe(true);
      expect(all.result.current.state.nodesById["active-root"]?.isStarred)
        .toBe(true);
    });
    expect(tagged.result.current.activeTagFilters).toEqual([
      { prefix: "#", normalizedTag: "work" }
    ]);
    expect(tagged.result.current.state.nodesById.outside).toBeUndefined();
    expect(all.result.current.activeTagFilters).toEqual([]);
    expect(all.result.current.libraryView).toBe("all");
    expect(all.result.current.state.nodesById.outside).toBeDefined();
    expect(loadWorkspace).toHaveBeenCalledWith("/tag-siblings", {
      kind: "tags",
      tags: [{ prefix: "#", normalizedTag: "work" }]
    });
  });

  it("uses the latest backend history status when a cross-scope reload completes", async () => {
    const active = workspace([node({ id: "active-root" })]);
    const archived = workspace([
      node({
        id: "archive-root",
        archivedAt: "2026-07-11T00:00:00Z"
      })
    ]);
    let latestStatus = false;
    const historyStatus = vi.fn().mockImplementation(async () =>
      latestStatus
        ? { canUndo: true, canRedo: false }
        : { canUndo: false, canRedo: false }
    );
    const store = repository({
      loadWorkspace: vi.fn((_vaultRoot, scope) =>
        Promise.resolve(scope?.kind === "archive" ? archived : active)
      ),
      historyStatus,
      undo: vi.fn().mockResolvedValue({
        workspace: active,
        replayedEntryId: null,
        canUndo: false,
        canRedo: true
      })
    });
    const owner = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/status-scope", repository: store })
    );
    const archive = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/status-scope", repository: store })
    );
    await waitFor(() => {
      expect(owner.result.current.status).toBe("ready");
      expect(archive.result.current.status).toBe("ready");
    });
    await act(async () =>
      archive.result.current.actions.selectLibraryView("archive")
    );
    const statusCallsBeforeReplay = historyStatus.mock.calls.length;
    latestStatus = true;

    await act(async () => owner.result.current.actions.undo!());

    await waitFor(() =>
      expect(historyStatus.mock.calls.length).toBeGreaterThan(
        statusCallsBeforeReplay
      )
    );
    await waitFor(() => {
      expect(archive.result.current.canUndo).toBe(true);
      expect(archive.result.current.canRedo).toBe(false);
    });
  });

  it("resets and generation-guards activation history status across vaults", async () => {
    const firstStatus = deferred<{ canUndo: boolean; canRedo: boolean }>();
    const secondStatus = deferred<{ canUndo: boolean; canRedo: boolean }>();
    const historyStatus = vi.fn((vaultRoot: string) =>
      vaultRoot === "/first" ? firstStatus.promise : secondStatus.promise
    );
    const store = repository({ historyStatus });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/first" } }
    );
    await waitFor(() =>
      expect(historyStatus).toHaveBeenCalledWith("/first", expect.any(String))
    );

    rerender({ vaultRoot: "/second" });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    await waitFor(() =>
      expect(historyStatus).toHaveBeenCalledWith("/second", expect.any(String))
    );

    secondStatus.resolve({ canUndo: false, canRedo: true });
    await waitFor(() => expect(result.current.canRedo).toBe(true));
    firstStatus.resolve({ canUndo: true, canRedo: false });
    await Promise.resolve();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it("flushes pending drafts before creating a new root", async () => {
    createNoteIdMock.mockReturnValue("new-root");
    const invocations: string[] = [];
    const afterDraft = workspace([node({ id: "root", title: "edited" })]);
    const store = repository({
      updateNode: vi.fn().mockImplementation(async () => {
        invocations.push("update");
        return afterDraft;
      }),
      createNode: vi.fn().mockImplementation(async () => {
        invocations.push("create");
        return workspace([
          node({ id: "root", title: "edited" }),
          node({ id: "new-root", sortKey: 2048 })
        ]);
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.actions.updateNodeDraft("root", {
        title: "edited",
        note: ""
      });
    });
    await act(async () => result.current.actions.createRoot());

    expect(invocations).toEqual(["update", "create"]);
  });

  it("flushes an old-vault draft without publishing its response into the new vault", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          workspace([
            node({ id: vaultRoot === "/old" ? "old-root" : "new-root" })
          ])
        )
      ),
      updateNode: vi.fn().mockReturnValue(oldWrite.promise)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "old draft",
        note: ""
      });
    });
    rerender({ vaultRoot: "/new" });

    expect(store.updateNode).toHaveBeenCalledWith(
      "/old",
      {
        id: "old-root",
        title: "old draft",
        note: ""
      },
      historyContext("text")
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );

    await act(async () =>
      oldWrite.resolve(workspace([node({ id: "old-saved" })]))
    );
    expect(result.current.state.nodesById["new-root"]).toBeDefined();
    expect(result.current.state.nodesById["old-saved"]).toBeUndefined();
    expect(result.current.draftsByNodeId).toEqual({});
  });

  it("does not let a late old-vault draft poison the next history UI snapshot", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const newWorkspace = workspace([node({ id: "new-root" })]);
    const toggleStar = vi.fn().mockResolvedValue(
      workspace([node({ id: "new-root", isStarred: true })])
    );
    const undo = vi.fn().mockImplementation(async () => ({
      workspace: newWorkspace,
      replayedEntryId: toggleStar.mock.calls[0]?.[2]?.entryId ?? null,
      canUndo: false,
      canRedo: true
    }));
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          vaultRoot === "/old"
            ? workspace([node({ id: "old-root" })])
            : newWorkspace
        )
      ),
      updateNode: vi.fn().mockReturnValue(oldWrite.promise),
      toggleStar,
      undo
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "late old draft",
        note: ""
      });
    });
    rerender({ vaultRoot: "/new" });
    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );
    await act(async () => {
      await result.current.actions.focusNode("new-root");
      await result.current.actions.zoomTo("new-root");
    });
    await act(async () => {
      oldWrite.resolve(workspace([node({ id: "old-root", title: "late" })]));
    });

    await act(async () => result.current.actions.toggleStar("new-root"));
    await act(async () => result.current.actions.undo!());

    expect(result.current.state).toMatchObject({
      selectedId: "new-root",
      zoomRootId: "new-root",
      pendingFocusId: "new-root",
      pendingFocusField: "title"
    });
  });

  it("recovers a failed shutdown draft only when its vault becomes active again", async () => {
    const oldBefore = workspace([node({ id: "old-root", title: "Old title" })]);
    const oldSaved = workspace([
      node({ id: "old-root", title: "Recovered old draft" })
    ]);
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) =>
        Promise.resolve(
          vaultRoot === "/old"
            ? oldBefore
            : workspace([node({ id: "new-root", title: "New title" })])
        )
      ),
      updateNode: vi
        .fn()
        .mockRejectedValueOnce(new Error("old vault disk full"))
        .mockResolvedValueOnce(oldSaved)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/old" } }
    );
    await waitFor(() =>
      expect(result.current.state.nodesById["old-root"]).toBeDefined()
    );

    act(() => {
      result.current.actions.updateNodeDraft("old-root", {
        title: "Recovered old draft",
        note: ""
      });
    });
    rerender({ vaultRoot: "/new" });

    await waitFor(() =>
      expect(result.current.state.nodesById["new-root"]).toBeDefined()
    );
    expect(result.current.draftsByNodeId).toEqual({});
    expect(result.current.writeError).toBeNull();

    rerender({ vaultRoot: "/old" });
    await waitFor(() =>
      expect(result.current.draftsByNodeId["old-root"]).toMatchObject({
        title: "Recovered old draft",
        status: "failed"
      })
    );
    expect(result.current.writeError).toMatchObject({
      operation: "write",
      retryable: true,
      message: "old vault disk full"
    });

    await act(async () => result.current.retryFailedDraft("old-root"));

    expect(vi.mocked(store.updateNode).mock.calls[1]?.[2]?.entryId).not.toBe(
      vi.mocked(store.updateNode).mock.calls[0]?.[2]?.entryId
    );

    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/old",
      {
        id: "old-root",
        title: "Recovered old draft",
        note: ""
      },
      historyContext("text")
    );
    await waitFor(() =>
      expect(result.current.draftsByNodeId["old-root"]).toBeUndefined()
    );
    expect(result.current.writeError).toBeNull();
  });

  it("isolates shutdown recovery by repository object for the same vault path", async () => {
    const firstStore = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("first store failed"))
    });
    const secondStore = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-root" })]))
    });
    const firstMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: firstStore })
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    act(() => {
      firstMount.result.current.actions.updateNodeDraft("root", {
        title: "First store draft",
        note: ""
      });
    });
    firstMount.unmount();
    await waitFor(() => expect(firstStore.updateNode).toHaveBeenCalledOnce());

    const secondMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/shared", repository: secondStore })
    );
    await waitFor(() =>
      expect(secondMount.result.current.state.nodesById["second-root"]).toBeDefined()
    );

    expect(secondMount.result.current.draftsByNodeId).toEqual({});
    expect(secondMount.result.current.writeError).toBeNull();
  });

  it("flushes a dirty unmount before a same-vault remount activation", async () => {
    const unmountWrite = deferred<NotesWorkspace>();
    let loadCount = 0;
    const store = repository({
      loadWorkspace: vi.fn(() => {
        loadCount += 1;
        return Promise.resolve(
          workspace([
            node({
              id: "root",
              title: loadCount === 1 ? "before" : "saved"
            })
          ])
        );
      }),
      updateNode: vi.fn().mockReturnValue(unmountWrite.promise)
    });
    const firstMount = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    act(() => {
      firstMount.result.current.actions.updateNodeDraft("root", {
        title: "saved",
        note: ""
      });
    });
    firstMount.unmount();
    expect(store.updateNode).toHaveBeenCalledOnce();

    const secondMount = renderHook(
      () => useNotesWorkspace({ vaultRoot: "/vault", repository: store }),
      { wrapper: strictMode }
    );
    expect(store.loadWorkspace).toHaveBeenCalledOnce();

    await act(async () =>
      unmountWrite.resolve(
        workspace([node({ id: "root", title: "saved" })])
      )
    );
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(secondMount.result.current.state.nodesById.root.title).toBe(
        "saved"
      )
    );
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.draftsByNodeId).toEqual({});
    expect(secondMount.result.current.writeError).toBeNull();
  });

  it("returns true after flushing a draft that persists successfully", async () => {
    const saved = workspace([node({ id: "root", title: "saved" })]);
    const store = repository({
      updateNode: vi.fn().mockResolvedValue(saved)
    });
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "saved",
        note: ""
      });
    });

    let flushed: unknown;
    await act(async () => {
      flushed = await mounted.result.current.actions.flushNodeDraft("root");
    });

    expect(flushed).toBe(true);
    expect(mounted.result.current.draftsByNodeId).toEqual({});
  });

  it("returns false when flushing retains a failed draft", async () => {
    const store = repository({
      updateNode: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "not saved",
        note: ""
      });
    });

    let flushed: unknown;
    await act(async () => {
      flushed = await mounted.result.current.actions.flushNodeDraft("root");
    });

    expect(flushed).toBe(false);
    expect(mounted.result.current.draftsByNodeId.root).toMatchObject({
      title: "not saved",
      status: "failed"
    });
  });

  it("returns true when a second flush retries and saves a retained draft", async () => {
    const saved = workspace([node({ id: "root", title: "saved on retry" })]);
    const store = repository({
      updateNode: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce(saved)
    });
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "saved on retry",
        note: ""
      });
    });

    let firstFlush: unknown;
    let retryFlush: unknown;
    await act(async () => {
      firstFlush = await mounted.result.current.actions.flushNodeDraft("root");
      retryFlush = await mounted.result.current.actions.flushNodeDraft("root");
    });

    expect(firstFlush).toBe(false);
    expect(retryFlush).toBe(true);
    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.updateNode).mock.calls[1]?.[2]?.entryId).not.toBe(
      vi.mocked(store.updateNode).mock.calls[0]?.[2]?.entryId
    );
    expect(mounted.result.current.draftsByNodeId).toEqual({});
  });

  it("returns false when the vault session changes before a flush completes", async () => {
    const oldWrite = deferred<NotesWorkspace>();
    const oldStore = repository({
      updateNode: vi.fn().mockReturnValue(oldWrite.promise)
    });
    const newStore = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "new-root" })]))
    });
    const mounted = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "old vault draft",
        note: ""
      });
    });
    const flush = mounted.result.current.actions.flushNodeDraft("root");
    await waitFor(() => expect(oldStore.updateNode).toHaveBeenCalledOnce());

    mounted.rerender({ vaultRoot: "/new", repository: newStore });
    await act(async () => {
      oldWrite.resolve(workspace([node({ id: "root", title: "old vault draft" })]));
    });

    await expect(flush).resolves.toBe(false);
  });

  it("retries a retained failed draft before closing its unmounted session", async () => {
    const saved = workspace([node({ id: "root", title: "saved on unmount" })]);
    const store = repository({
      updateNode: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce(saved)
    });
    const mounted = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));

    act(() => {
      mounted.result.current.actions.updateNodeDraft("root", {
        title: "saved on unmount",
        note: ""
      });
    });
    await act(async () =>
      mounted.result.current.actions.flushNodeDraft("root")
    );
    expect(mounted.result.current.writeError).toMatchObject({
      operation: "write",
      retryable: true,
      message: "disk full"
    });

    mounted.unmount();

    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault",
      {
        id: "root",
        title: "saved on unmount",
        note: ""
      },
      historyContext("text")
    );
  });

  it("does not launch or publish old-identity queued work after a vault change", async () => {
    const oldLoad = deferred<NotesWorkspace>();
    const newLoad = deferred<NotesWorkspace>();
    const oldStore = repository({
      loadWorkspace: vi.fn().mockReturnValue(oldLoad.promise),
      updateNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "old-command" })]))
    });
    const newStore = repository({
      loadWorkspace: vi.fn().mockReturnValue(newLoad.promise)
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, repository: current }) =>
        useNotesWorkspace({ vaultRoot, repository: current }),
      { initialProps: { vaultRoot: "/old", repository: oldStore } }
    );
    await waitFor(() => expect(oldStore.loadWorkspace).toHaveBeenCalledOnce());

    let oldCompletion!: Promise<void>;
    act(() => {
      oldCompletion = result.current.actions.updateNode("old", {
        title: "stale",
        note: ""
      });
    });

    rerender({ vaultRoot: "/new", repository: newStore });
    expect(result.current.status).toBe("loading");
    expect(result.current.state.rootIds).toEqual([]);
    await waitFor(() => expect(newStore.loadWorkspace).toHaveBeenCalledOnce());

    await act(async () => {
      oldLoad.resolve(workspace([node({ id: "old" })]));
      await oldCompletion;
    });

    expect(oldStore.updateNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.old).toBeUndefined();
    expect(result.current.status).toBe("loading");

    await act(async () =>
      newLoad.resolve(workspace([node({ id: "new" })]))
    );
    expect(result.current.state.nodesById.new).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("does not publish in-flight work or launch later queued work after unmount", async () => {
    const load = deferred<NotesWorkspace>();
    const loadingStore = repository({ loadWorkspace: vi.fn().mockReturnValue(load.promise) });
    const loadingHook = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/loading", repository: loadingStore })
    );
    await waitFor(() => expect(loadingStore.loadWorkspace).toHaveBeenCalledOnce());
    loadingHook.unmount();

    await act(async () => load.resolve(workspace([node({ id: "late-load" })])));
    expect(loadingHook.result.current.state.nodesById["late-load"]).toBeUndefined();

    const command = deferred<NotesWorkspace>();
    const commandStore = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(command.promise)
        .mockResolvedValueOnce(workspace([node({ id: "never-launched" })]))
    });
    const commandHook = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/command", repository: commandStore })
    );
    await waitFor(() => expect(commandHook.result.current.status).toBe("ready"));
    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = commandHook.result.current.actions.updateNode("root", {
        title: "first",
        note: ""
      });
      secondCompletion = commandHook.result.current.actions.updateNode("root", {
        title: "second",
        note: ""
      });
    });
    await waitFor(() =>
      expect(commandStore.updateNode).toHaveBeenCalledOnce()
    );
    commandHook.unmount();

    await act(async () => {
      command.resolve(workspace([node({ id: "late-command" })]));
      await Promise.all([firstCompletion, secondCompletion]);
    });
    expect(commandStore.updateNode).toHaveBeenCalledOnce();
    expect(commandHook.result.current.state.nodesById["late-command"]).toBeUndefined();
  });

  it("keeps a running mutation as the barrier across unmount and remount", async () => {
    const running = deferred<NotesWorkspace>();
    const refresh = deferred<NotesWorkspace>();
    const invocations: string[] = [];
    let loadCount = 0;
    const store = repository({
      initialize: vi.fn(async () => {
        invocations.push("initialize");
      }),
      loadWorkspace: vi.fn(() => {
        loadCount += 1;
        invocations.push(`load:${loadCount}`);
        return loadCount === 1
          ? Promise.resolve(workspace([node({ id: "before-a1" })]))
          : refresh.promise;
      }),
      updateNode: vi.fn((_vaultRoot, input) => {
        invocations.push(`update:${input.title}`);
        return input.title === "A1"
          ? running.promise
          : Promise.resolve(workspace([node({ id: "after-a3" })]));
      })
    });
    const firstMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    await waitFor(() => expect(firstMount.result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let oldQueuedCompletion!: Promise<void>;
    let oldQueuedSettled = false;
    act(() => {
      firstCompletion = firstMount.result.current.actions.updateNode("before-a1", {
        title: "A1",
        note: ""
      });
      oldQueuedCompletion = firstMount.result.current.actions.updateNode("before-a1", {
        title: "old-A2",
        note: ""
      });
      void oldQueuedCompletion.then(() => {
        oldQueuedSettled = true;
      });
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    firstMount.unmount();
    await act(async () => Promise.resolve());
    expect(oldQueuedSettled).toBe(true);

    const secondMount = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault-a", repository: store })
    );
    let newCompletion!: Promise<void>;
    act(() => {
      newCompletion = secondMount.result.current.actions.updateNode("after-a1", {
        title: "A3",
        note: ""
      });
    });

    expect(store.loadWorkspace).toHaveBeenCalledOnce();
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.state.rootIds).toEqual([]);

    await act(async () => {
      running.resolve(workspace([node({ id: "a1-response" })]));
      await firstCompletion;
    });
    await waitFor(() => expect(store.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(store.updateNode).toHaveBeenCalledOnce();
    expect(secondMount.result.current.state.rootIds).toEqual(["a1-response"]);

    await act(async () =>
      refresh.resolve(workspace([node({ id: "after-a1" })]))
    );
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledTimes(2));
    await act(async () => {
      await newCompletion;
      await oldQueuedCompletion;
    });

    expect(store.updateNode).toHaveBeenNthCalledWith(
      1,
      "/vault-a",
      { id: "before-a1", title: "A1", note: "" },
      historyContext("update")
    );
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-a",
      { id: "after-a1", title: "A3", note: "" },
      historyContext("update")
    );
    expect(invocations).toEqual([
      "initialize",
      "load:1",
      "update:A1",
      "load:2",
      "update:A3"
    ]);
    expect(secondMount.result.current.state.nodesById["after-a3"]).toBeDefined();
  });

  it("serializes A -> B -> A per vault without blocking B", async () => {
    const runningA1 = deferred<NotesWorkspace>();
    const refreshedA = deferred<NotesWorkspace>();
    let aLoadCount = 0;
    const store = repository({
      loadWorkspace: vi.fn((vaultRoot) => {
        if (vaultRoot === "/vault-b") {
          return Promise.resolve(workspace([node({ id: "b-root" })]));
        }
        aLoadCount += 1;
        return aLoadCount === 1
          ? Promise.resolve(workspace([node({ id: "a-before" })]))
          : refreshedA.promise;
      }),
      updateNode: vi.fn((vaultRoot, input) => {
        if (input.title === "A1") {
          return runningA1.promise;
        }
        return Promise.resolve(
          workspace([
            node({
              id: vaultRoot === "/vault-b" ? "b-updated" : "a3-updated"
            })
          ])
        );
      })
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot }) => useNotesWorkspace({ vaultRoot, repository: store }),
      { initialProps: { vaultRoot: "/vault-a" } }
    );
    await waitFor(() => expect(result.current.state.nodesById["a-before"]).toBeDefined());

    let a1Completion!: Promise<void>;
    let oldA2Completion!: Promise<void>;
    act(() => {
      a1Completion = result.current.actions.updateNode("a-before", {
        title: "A1",
        note: ""
      });
      oldA2Completion = result.current.actions.updateNode("a-before", {
        title: "old-A2",
        note: ""
      });
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    rerender({ vaultRoot: "/vault-b" });
    await waitFor(() => expect(result.current.state.nodesById["b-root"]).toBeDefined());
    await act(async () =>
      result.current.actions.updateNode("b-root", { title: "B1", note: "" })
    );
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-b",
      { id: "b-root", title: "B1", note: "" },
      historyContext("update")
    );

    rerender({ vaultRoot: "/vault-a" });
    let a3Completion!: Promise<void>;
    act(() => {
      a3Completion = result.current.actions.updateNode("after-a1", {
        title: "A3",
        note: ""
      });
    });
    await act(async () => Promise.resolve());
    expect(aLoadCount).toBe(1);
    expect(result.current).toMatchObject({ status: "loading", error: null });
    expect(result.current.state.rootIds).toEqual([]);

    await act(async () => {
      runningA1.resolve(workspace([node({ id: "a1-response" })]));
      await a1Completion;
      await oldA2Completion;
    });
    await waitFor(() => expect(aLoadCount).toBe(2));
    expect(result.current.state.rootIds).toEqual(["a1-response"]);
    expect(store.updateNode).toHaveBeenCalledTimes(2);

    await act(async () =>
      refreshedA.resolve(workspace([node({ id: "after-a1" })]))
    );
    await act(async () => a3Completion);

    expect(store.updateNode).toHaveBeenNthCalledWith(
      3,
      "/vault-a",
      { id: "after-a1", title: "A3", note: "" },
      historyContext("update")
    );
    expect(result.current.state.nodesById["a3-updated"]).toBeDefined();
    expect(result.current.state.nodesById["a-before"]).toBeUndefined();
  });

  it("keeps the committed identity active when a different render is abandoned", async () => {
    const firstCommand = deferred<NotesWorkspace>();
    const suspended = deferred<void>();
    const store = repository({
      updateNode: vi
        .fn()
        .mockReturnValueOnce(firstCommand.promise)
        .mockResolvedValueOnce(workspace([node({ id: "second-a-result" })]))
    });
    const { result, rerender } = renderHook(
      ({ vaultRoot, shouldSuspend }) => {
        const current = useNotesWorkspace({ vaultRoot, repository: store });
        if (shouldSuspend) {
          throw suspended.promise;
        }
        return current;
      },
      {
        initialProps: { vaultRoot: "/vault-a", shouldSuspend: false },
        wrapper: suspenseMode
      }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    let secondCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "committed-A1",
        note: ""
      });
      secondCompletion = result.current.actions.updateNode("root", {
        title: "committed-A2",
        note: ""
      });
    });
    await waitFor(() => expect(store.updateNode).toHaveBeenCalledOnce());

    rerender({ vaultRoot: "/vault-b", shouldSuspend: true });
    expect(store.initialize).toHaveBeenCalledOnce();

    await act(async () => {
      firstCommand.resolve(workspace([
        node({ id: "root" }),
        node({ id: "first-a-result" })
      ]));
      await Promise.all([firstCompletion, secondCompletion]);
    });

    expect(store.updateNode).toHaveBeenCalledTimes(2);
    expect(store.updateNode).toHaveBeenNthCalledWith(
      2,
      "/vault-a",
      { id: "root", title: "committed-A2", note: "" },
      historyContext("update")
    );
  });

  it("retains a root creation failure when its queued child dependency is missing", async () => {
    createNoteIdMock
      .mockReturnValueOnce("new-parent")
      .mockReturnValueOnce("new-child");
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([])),
      createNode: vi.fn().mockRejectedValue(new Error("root failed"))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let rootCompletion!: Promise<void>;
    let childCompletion!: Promise<void>;
    act(() => {
      rootCompletion = result.current.actions.createRoot();
      childCompletion = result.current.actions.createChild("new-parent");
    });
    await act(async () => {
      await Promise.all([rootCompletion, childCompletion]);
    });

    expect(store.createNode).toHaveBeenCalledOnce();
    expect(result.current.state.rootIds).toEqual([]);
    expect(result.current).toMatchObject({ status: "error", error: "root failed" });
  });

  it("retains a split failure when its queued duplicate dependency is missing", async () => {
    const store = repository({
      splitNode: vi.fn().mockRejectedValue(new Error("split failed")),
      duplicateNode: vi.fn().mockResolvedValue(workspace([]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let splitCompletion!: Promise<void>;
    let duplicateCompletion!: Promise<void>;
    act(() => {
      splitCompletion = result.current.actions.splitNode(
        "root",
        "split-child",
        "prefix",
        "suffix"
      );
      duplicateCompletion = result.current.actions.duplicateNode("split-child");
    });
    await act(async () => {
      await Promise.all([splitCompletion, duplicateCompletion]);
    });

    expect(store.splitNode).toHaveBeenCalledOnce();
    expect(store.duplicateNode).not.toHaveBeenCalled();
    expect(result.current.state.nodesById.root).toBeDefined();
    expect(result.current).toMatchObject({ status: "error", error: "split failed" });
  });

  it("handles a synchronous createNoteId throw and clears it on later authoritative success", async () => {
    createNoteIdMock
      .mockImplementationOnce(() => {
        throw new Error("id creation failed");
      })
      .mockReturnValueOnce("created-after-failure");
    const store = repository({
      createNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "created-after-failure" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let failedCompletion!: Promise<void>;
    act(() => {
      failedCompletion = result.current.actions.createRoot();
    });
    await act(async () => {
      await expect(failedCompletion).resolves.toBeUndefined();
    });
    expect(store.createNode).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      status: "error",
      error: "id creation failed"
    });

    await act(async () => result.current.actions.createRoot());
    expect(store.createNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "created-after-failure",
        parentId: null,
        afterId: "root",
        title: "",
        note: ""
      },
      historyContext("create")
    );
    expect(result.current.state.nodesById["created-after-failure"]).toBeDefined();
    expect(result.current).toMatchObject({ status: "ready", error: null });
  });

  it("isolates the same vault across different repository objects", async () => {
    const firstRepositoryCommand = deferred<NotesWorkspace>();
    const firstStore = repository({
      updateNode: vi.fn().mockReturnValue(firstRepositoryCommand.promise)
    });
    const secondStore = repository({
      loadWorkspace: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-root" })])),
      updateNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "second-updated" })]))
    });
    const { result, rerender } = renderHook(
      ({ repository: current }) =>
        useNotesWorkspace({ vaultRoot: "/shared-vault", repository: current }),
      { initialProps: { repository: firstStore } }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let firstCompletion!: Promise<void>;
    act(() => {
      firstCompletion = result.current.actions.updateNode("root", {
        title: "first repository",
        note: ""
      });
    });
    await waitFor(() => expect(firstStore.updateNode).toHaveBeenCalledOnce());

    rerender({ repository: secondStore });
    await waitFor(() => expect(result.current.state.nodesById["second-root"]).toBeDefined());
    await act(async () =>
      result.current.actions.updateNode("second-root", {
        title: "second repository",
        note: ""
      })
    );

    expect(secondStore.updateNode).toHaveBeenCalledOnce();
    expect(result.current.state.nodesById["second-updated"]).toBeDefined();

    await act(async () => {
      firstRepositoryCommand.resolve(workspace([node({ id: "first-late" })]));
      await firstCompletion;
    });
    expect(result.current.state.nodesById["first-late"]).toBeUndefined();
  });

  it("allows restore to target a node absent from the active workspace", async () => {
    const store = repository({
      restoreNode: vi
        .fn()
        .mockResolvedValue(workspace([node({ id: "restored" })]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.actions.restoreNode("restored"));

    expect(store.restoreNode).toHaveBeenCalledWith(
      "/vault",
      "restored",
      historyContext("restore")
    );
    expect(result.current.state.nodesById.restored).toBeDefined();
  });

  it("follows the currently viewed restored Trash root into Active with title focus", async () => {
    const activeBefore = workspace([node({ id: "active", sortKey: 1 })]);
    const deleted = node({
      id: "deleted",
      sortKey: 2,
      title: "Deleted",
      deletedAt: "2026-07-10T01:00:00Z"
    });
    const activeAfter = workspace([
      node({ id: "active", sortKey: 1 }),
      { ...deleted, deletedAt: null }
    ]);
    let restored = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) =>
        scope.kind === "trash"
          ? workspace(restored ? [] : [deleted])
          : restored
            ? activeAfter
            : activeBefore
      ),
      restoreNode: vi.fn(async () => {
        restored = true;
        return activeAfter;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("trash"));
    await act(async () => {
      await result.current.actions.zoomTo("deleted");
      await result.current.actions.focusNode("deleted");
    });

    await act(async () => result.current.actions.restoreNode("deleted"));

    expect(store.restoreNode).toHaveBeenCalledWith(
      "/vault",
      "deleted",
      historyContext("restore")
    );
    expect(result.current.libraryView).toBe("all");
    expect(result.current.state).toMatchObject({
      rootIds: ["active", "deleted"],
      selectedId: "deleted",
      zoomRootId: "deleted",
      editingNoteId: "deleted",
      pendingFocusId: "deleted",
      pendingFocusField: "title"
    });
  });

  it("flushes every draft before archiving a root and selects the next visible root", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "second-child", parentId: "second", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      updateNode: vi.fn().mockResolvedValue(before),
      archiveNode: vi.fn().mockResolvedValue(after),
      listTagsWithCounts: vi.fn().mockResolvedValue([
        {
          prefix: "#",
          normalizedTag: "remaining",
          displayTag: "remaining",
          count: 1
        }
      ])
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual([
      "first",
      "second",
      "third"
    ]));

    act(() => {
      void result.current.actions.zoomTo("second");
      result.current.actions.updateNodeDraft("second-child", {
        title: "Saved before archive",
        note: ""
      });
    });
    await act(async () => result.current.actions.archiveNode("second"));

    expect(store.updateNode).toHaveBeenCalledWith(
      "/vault",
      {
        id: "second-child",
        title: "Saved before archive",
        note: ""
      },
      historyContext("text")
    );
    expect(store.archiveNode).toHaveBeenCalledWith(
      "/vault",
      "second",
      historyContext("archive")
    );
    expect(
      vi.mocked(store.updateNode).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(store.archiveNode).mock.invocationCallOrder[0]);
    expect(store.listTagsWithCounts).toHaveBeenCalledWith("/vault");
    expect(result.current.tagSummaries).toEqual([
      {
        prefix: "#",
        normalizedTag: "remaining",
        displayTag: "remaining",
        count: 1
      }
    ]);
    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "third",
      zoomRootId: "third",
      editingNoteId: "third",
      pendingFocusId: "third"
    });
  });

  it("falls back to the active projection when a post-archive scoped reload fails", async () => {
    const target = node({ id: "target", isStarred: true, sortKey: 1 });
    const outside = node({ id: "outside", sortKey: 2 });
    const before = workspace([target, outside]);
    const after = workspace([outside]);
    let archived = false;
    const store = repository({
      loadWorkspace: vi.fn(async (_vaultRoot, scope) => {
        if (scope.kind === "starred") {
          if (archived) {
            throw new Error("Starred projection failed");
          }
          return workspace([target]);
        }
        return archived ? after : before;
      }),
      archiveNode: vi.fn(async () => {
        archived = true;
        return after;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("starred"));
    await act(async () => result.current.actions.zoomTo("target"));

    await act(async () => result.current.actions.archiveNode("target"));

    expect(store.archiveNode).toHaveBeenCalledWith(
      "/vault",
      "target",
      historyContext("archive")
    );
    expect(result.current.error).toBeNull();
    expect(result.current.libraryView).toBe("all");
    expect(result.current.state).toMatchObject({
      rootIds: ["outside"],
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null
    });
  });

  it("preserves navigation made while a root lifecycle mutation is pending", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const archive = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      archiveNode: vi.fn().mockReturnValue(archive.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.zoomTo("second"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.archiveNode("second");
    });
    await waitFor(() => expect(store.archiveNode).toHaveBeenCalledOnce());

    act(() => {
      void result.current.actions.zoomTo("first");
      void result.current.actions.focusNode("first");
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        selectedId: "first",
        zoomRootId: "first",
        editingNoteId: "first",
        pendingFocusId: "first"
      })
    );

    await act(async () => {
      archive.resolve(after);
      await completion;
    });

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("preserves navigation when the lifecycle mutation resolves before React renders it", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const archive = deferred<NotesWorkspace>();
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      archiveNode: vi.fn().mockReturnValue(archive.promise)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.zoomTo("second"));

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.actions.archiveNode("second");
    });
    await waitFor(() => expect(store.archiveNode).toHaveBeenCalledOnce());

    await act(async () => {
      void result.current.actions.zoomTo("first");
      void result.current.actions.focusNode("first");
      expect(result.current.state.zoomRootId).toBe("second");
      archive.resolve(after);
      await completion;
    });

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "first",
      zoomRootId: "first",
      editingNoteId: "first",
      pendingFocusId: "first"
    });
  });

  it("falls back to the previous root and then the empty state", async () => {
    let current = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async () => current),
      archiveNode: vi.fn().mockImplementation(async (_vault, nodeId) => {
        current = workspace(current.nodes.filter((currentNode) => currentNode.id !== nodeId));
        return current;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual(["first", "second"]));

    await act(async () => result.current.actions.zoomTo("second"));
    await act(async () => result.current.actions.archiveNode("second"));
    expect(result.current.state.zoomRootId).toBe("first");

    await act(async () => result.current.actions.archiveNode("first"));
    expect(result.current.state).toMatchObject({
      rootIds: [],
      selectedId: null,
      zoomRootId: null
    });
  });

  it("uses the same deterministic fallback when an open root moves to Trash", async () => {
    const before = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const after = workspace([
      node({ id: "first", sortKey: 1 }),
      node({ id: "third", sortKey: 3 })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(before),
      softDeleteNode: vi.fn().mockResolvedValue(after)
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.rootIds).toEqual([
      "first",
      "second",
      "third"
    ]));

    await act(async () => result.current.actions.zoomTo("second"));
    await act(async () => result.current.actions.deleteNode("second"));

    expect(result.current.state).toMatchObject({
      rootIds: ["first", "third"],
      selectedId: "third",
      zoomRootId: "third",
      editingNoteId: "third",
      pendingFocusId: "third"
    });
  });

  it("rejects non-root archive and unarchive targets before invoking storage", async () => {
    const child = node({ id: "child", parentId: "root" });
    const store = repository({
      loadWorkspace: vi.fn().mockResolvedValue(workspace([
        node({ id: "root" }),
        child
      ]))
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.state.nodesById.child).toBeDefined());

    await act(async () => {
      await result.current.actions.archiveNode("child");
      await result.current.actions.unarchiveNode("child");
    });

    expect(store.archiveNode).not.toHaveBeenCalled();
    expect(store.unarchiveNode).not.toHaveBeenCalled();
  });

  it("unarchives a root through the archive scope and chooses its next archived sibling", async () => {
    const active = workspace([node({ id: "active" })]);
    let archived = workspace([
      node({
        id: "archived-first",
        sortKey: 1,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first"
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second"
      })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (_vault, scope) =>
        scope.kind === "archive" ? archived : active
      ),
      unarchiveNode: vi.fn().mockImplementation(async () => {
        archived = workspace(archived.nodes.filter((current) => current.id !== "archived-first"));
        return active;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("archive"));
    await act(async () => result.current.actions.zoomTo("archived-first"));
    await act(async () => result.current.actions.unarchiveNode("archived-first"));

    expect(store.unarchiveNode).toHaveBeenCalledWith(
      "/vault",
      "archived-first",
      historyContext("unarchive")
    );
    expect(store.loadWorkspace).toHaveBeenLastCalledWith("/vault", {
      kind: "archive"
    });
    expect(result.current.state).toMatchObject({
      rootIds: ["archived-second"],
      selectedId: "archived-second",
      zoomRootId: "archived-second",
      editingNoteId: "archived-second",
      pendingFocusId: "archived-second"
    });
  });

  it("focuses the next archived sibling after moving the open archived root to Trash", async () => {
    const active = workspace([node({ id: "active" })]);
    let archived = workspace([
      node({
        id: "archived-first",
        sortKey: 1,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-first"
      }),
      node({
        id: "archived-second",
        sortKey: 2,
        archivedAt: "2026-07-11T01:00:00Z",
        archiveRootId: "archived-second"
      })
    ]);
    const store = repository({
      loadWorkspace: vi.fn().mockImplementation(async (_vault, scope) =>
        scope.kind === "archive" ? archived : active
      ),
      softDeleteNode: vi.fn().mockImplementation(async () => {
        archived = workspace(
          archived.nodes.filter((current) => current.id !== "archived-first")
        );
        return active;
      })
    });
    const { result } = renderHook(() =>
      useNotesWorkspace({ vaultRoot: "/vault", repository: store })
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.actions.selectLibraryView("archive"));
    await act(async () => result.current.actions.zoomTo("archived-first"));

    await act(async () => result.current.actions.deleteNode("archived-first"));

    expect(store.softDeleteNode).toHaveBeenCalledWith(
      "/vault",
      "archived-first",
      historyContext("trash")
    );
    expect(result.current.state).toMatchObject({
      rootIds: ["archived-second"],
      selectedId: "archived-second",
      zoomRootId: "archived-second",
      editingNoteId: "archived-second",
      pendingFocusId: "archived-second"
    });
  });
});
