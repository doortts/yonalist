import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import { NOTES_DRAFTS_FLUSH_FAILED_CODE } from "./useNotesWorkspace";

interface ConfirmDialogProbe {
  open: boolean;
  title: unknown;
  onConfirm(): void;
}

const deleteAllNotesDataMock = vi.hoisted(() => vi.fn());
const flushAllDraftsMock = vi.hoisted(() => vi.fn());
const notesPurgeUnusedAssetsMock = vi.hoisted(() => vi.fn());
const notesRepairDataMock = vi.hoisted(() => vi.fn());
const notesResetDatabaseMock = vi.hoisted(() => vi.fn());
const notesSyncRetryQuarantinedMock = vi.hoisted(() => vi.fn());
const useNotesSyncStatusMock = vi.hoisted(() =>
  vi.fn((_vaultRoot: string): unknown => null)
);
const activeDeleteAllNotesDataMock = vi.hoisted(() => ({
  current: deleteAllNotesDataMock
}));
const confirmDialogRenderMock = vi.hoisted(() =>
  vi.fn<(props: ConfirmDialogProbe) => void>()
);

vi.mock("../../components/ui/ConfirmDialog", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../components/ui/ConfirmDialog")
  >();
  return {
    ...actual,
    ConfirmDialog: (props: Parameters<typeof actual.ConfirmDialog>[0]) => {
      confirmDialogRenderMock({
        open: props.open,
        title: props.title,
        onConfirm: props.onConfirm
      });
      return actual.ConfirmDialog(props);
    }
  };
});

vi.mock("../../services/notesStore", () => ({
  notesPurgeUnusedAssets: notesPurgeUnusedAssetsMock,
  notesRepairData: notesRepairDataMock,
  notesResetDatabase: notesResetDatabaseMock,
  notesSyncRetryQuarantined: notesSyncRetryQuarantinedMock
}));

vi.mock("./useNotesSyncStatus", () => ({
  useNotesSyncStatus: (vaultRoot: string) => useNotesSyncStatusMock(vaultRoot),
  notesSyncStatusNeedsAttention: () => false
}));

vi.mock("./NotesWorkspaceContext", () => ({
  useNotesActions: () => ({
    actions: {
      deleteAllNotesData: activeDeleteAllNotesDataMock.current,
      flushAllDrafts: flushAllDraftsMock
    }
  }),
  useNotesDrafts: () => ({ draftsByNodeId: {}, writeError: null }),
  useNotesState: () => ({
    deletingNotesData: false,
    state: { status: "ready" }
  })
}));

import { NotesDataSettingsDialog } from "./NotesDataSettingsDialog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function latestOpenConfirmation(title: string): () => void {
  const calls = confirmDialogRenderMock.mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const props = calls[index][0];
    if (props.open && props.title === title) {
      return props.onConfirm;
    }
  }
  throw new Error(`No open confirmation found for ${title}`);
}

describe("NotesDataSettingsDialog", () => {
  beforeEach(() => {
    deleteAllNotesDataMock.mockReset();
    deleteAllNotesDataMock.mockResolvedValue({ attachmentCleanupFailed: false });
    flushAllDraftsMock.mockReset();
    flushAllDraftsMock.mockResolvedValue(true);
    activeDeleteAllNotesDataMock.current = deleteAllNotesDataMock;
    confirmDialogRenderMock.mockReset();
    notesPurgeUnusedAssetsMock.mockReset();
    notesPurgeUnusedAssetsMock.mockResolvedValue({ count: 2, totalBytes: 4096 });
    notesRepairDataMock.mockReset();
    notesRepairDataMock.mockResolvedValue({
      repairedNodeCount: 1,
      backedUpFileCount: 1,
      backupPath: "/vault/.yonalist/notes-repair-backups/repair-1"
    });
    notesResetDatabaseMock.mockReset();
    notesResetDatabaseMock.mockResolvedValue(undefined);
    notesSyncRetryQuarantinedMock.mockReset();
    notesSyncRetryQuarantinedMock.mockResolvedValue({
      running: true,
      dirtyTopics: 0,
      quarantined: [],
      lastExportAt: null,
      lastMergeAt: null,
      lastError: null
    });
    useNotesSyncStatusMock.mockReset();
    useNotesSyncStatusMock.mockReturnValue(null);
  });

  it("repairs Notes data from the release-visible settings section", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesDataSettingsDialog
          open
          onOpenChange={vi.fn()}
          reloadApplication={reloadApplication}
        />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Repair Notes data" }));
    const confirm = screen.getByRole("alertdialog", {
      name: "Repair Notes data?"
    });
    expect(confirm).toHaveTextContent("Notes, attachments, and Trash data will not be deleted");
    await user.click(
      within(confirm).getByRole("button", { name: "Repair Notes data" })
    );

    await waitFor(() =>
      expect(notesRepairDataMock).toHaveBeenCalledWith("/vault")
    );
    expect(flushAllDraftsMock).toHaveBeenCalledOnce();
    expect(reloadApplication).toHaveBeenCalledOnce();
  });

  it("keeps settings maintenance controls disabled while repair is pending", async () => {
    const user = userEvent.setup();
    const repair = deferred<{
      repairedNodeCount: number;
      backedUpFileCount: number;
      backupPath: string | null;
    }>();
    notesRepairDataMock.mockReturnValueOnce(repair.promise);
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Repair Notes data" }));
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Repair Notes data?" })
      ).getByRole("button", { name: "Repair Notes data" })
    );
    await waitFor(() => expect(notesRepairDataMock).toHaveBeenCalledOnce());

    expect(
      screen.getByRole("button", { name: "Close Notes data settings" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete all Notes data" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check unused assets" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Repairing..." })).toBeDisabled();

    await act(async () => {
      repair.resolve({
        repairedNodeCount: 0,
        backedUpFileCount: 0,
        backupPath: null
      });
      await repair.promise;
    });
  });

  it("resets the development database without requiring a workspace action", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesDataSettingsDialog
          open
          onOpenChange={vi.fn()}
          reloadApplication={reloadApplication}
        />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Reset Notes database" }));
    const confirm = screen.getByRole("alertdialog", {
      name: "Reset the Notes database?"
    });
    expect(confirm).toHaveTextContent("Synced Notes files and attachments are kept");
    expect(confirm).toHaveTextContent(
      "Notes that exist only in SQLite will be permanently discarded"
    );
    await user.click(
      within(confirm).getByRole("button", { name: "Reset database" })
    );

    await waitFor(() =>
      expect(notesResetDatabaseMock).toHaveBeenCalledWith("/vault")
    );
    expect(deleteAllNotesDataMock).not.toHaveBeenCalled();
    expect(reloadApplication).toHaveBeenCalledOnce();
  });

  it("retries quarantined sync from the status section (R13)", async () => {
    const user = userEvent.setup();
    useNotesSyncStatusMock.mockReturnValue({
      running: true,
      dirtyTopics: 0,
      quarantined: ["broken.11111111.md"],
      lastExportAt: null,
      lastMergeAt: null,
      lastError: "Notes export broken.11111111.md exceeds the export cap"
    });
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Retry sync" }));

    await waitFor(() =>
      expect(notesSyncRetryQuarantinedMock).toHaveBeenCalledWith("/vault")
    );
  });

  it("shows a reset failure without reloading", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    notesResetDatabaseMock.mockRejectedValueOnce(new Error("Database is busy"));
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesDataSettingsDialog
          open
          onOpenChange={vi.fn()}
          reloadApplication={reloadApplication}
        />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Reset Notes database" }));
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Reset the Notes database?" })
      ).getByRole("button", { name: "Reset database" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Database is busy");
    const resetTrigger = screen.getByRole("button", {
      name: "Reset Notes database"
    });
    expect(resetTrigger).toBeEnabled();
    expect(resetTrigger).toHaveFocus();
    expect(reloadApplication).not.toHaveBeenCalled();
  });

  it("describes complete Notes-owned deletion and reloads", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    render(
      <NotesDataSettingsDialog
        open
        onOpenChange={vi.fn()}
        reloadApplication={reloadApplication}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    const confirm = screen.getByRole("alertdialog", {
      name: "Delete all Notes data?"
    });
    expect(confirm).toHaveTextContent("Notes database, synced Notes files, attachments, and Trash data");
    expect(confirm).toHaveTextContent(
      "Other vault files and application settings are kept"
    );
    await user.click(
      within(confirm).getByRole("button", { name: "Delete Notes data" })
    );

    await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledOnce());
    expect(reloadApplication).toHaveBeenCalledOnce();
  });

  it("requires confirmation and cancellation has no side effect", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <NotesDataSettingsDialog
        open
        onOpenChange={onOpenChange}
        reloadApplication={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    expect(deleteAllNotesDataMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", {
      name: "Delete all Notes data?"
    });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(deleteAllNotesDataMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Notes data" })).toBeInTheDocument();
  });

  it("deletes after confirmation and closes the data settings dialog", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <NotesDataSettingsDialog
        open
        onOpenChange={onOpenChange}
        reloadApplication={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );

    await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("focuses the retryable delete trigger after an asynchronous failure", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    deleteAllNotesDataMock.mockRejectedValueOnce(new Error("Database is busy"));
    render(
      <NotesDataSettingsDialog
        open
        onOpenChange={vi.fn()}
        reloadApplication={reloadApplication}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Database is busy");
    const deleteTrigger = screen.getByRole("button", {
      name: "Delete all Notes data"
    });
    expect(deleteTrigger).toBeEnabled();
    expect(deleteTrigger).toHaveFocus();
    expect(reloadApplication).not.toHaveBeenCalled();
  });

  it("blocks dialog dismissal while deletion is pending", async () => {
    const user = userEvent.setup();
    const deletion = deferred<void>();
    const onOpenChange = vi.fn();
    deleteAllNotesDataMock.mockReturnValue(deletion.promise);
    render(
      <NotesDataSettingsDialog
        open
        onOpenChange={onOpenChange}
        reloadApplication={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );
    await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledOnce());

    expect(
      screen.getByRole("button", { name: "Close Notes data settings" })
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog", { name: "Notes data" })).toBeInTheDocument();

    await act(async () => deletion.resolve());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("confirms discarding unsaved edits before deleting when the flush fails", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    deleteAllNotesDataMock.mockRejectedValueOnce(
      Object.assign(new Error("A draft could not be saved."), {
        name: "NotesDraftsFlushFailedError",
        code: NOTES_DRAFTS_FLUSH_FAILED_CODE
      })
    );
    deleteAllNotesDataMock.mockResolvedValueOnce({
      attachmentCleanupFailed: false
    });
    render(
      <NotesDataSettingsDialog
        open
        onOpenChange={onOpenChange}
        reloadApplication={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );

    const discardConfirm = await screen.findByRole("alertdialog", {
      name: "Discard unsaved edits and delete?"
    });
    expect(deleteAllNotesDataMock).toHaveBeenCalledTimes(1);
    await user.click(
      within(discardConfirm).getByRole("button", { name: "Discard and delete" })
    );

    await waitFor(() =>
      expect(deleteAllNotesDataMock).toHaveBeenCalledTimes(2)
    );
    expect(deleteAllNotesDataMock).toHaveBeenNthCalledWith(1, undefined);
    expect(deleteAllNotesDataMock).toHaveBeenNthCalledWith(2, {
      discardDrafts: true
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("warns without closing when some attachment files remain on disk", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    deleteAllNotesDataMock.mockResolvedValueOnce({
      attachmentCleanupFailed: true
    });
    render(<NotesDataSettingsDialog open onOpenChange={onOpenChange} />);

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "some attachment files could not be removed"
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("dialog", { name: "Notes data" })
    ).toBeInTheDocument();
  });

  it("dry-runs unused assets before requiring explicit purge confirmation", async () => {
    const user = userEvent.setup();
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Check unused assets" }));
    await screen.findByText("2 unused assets (4,096 bytes)");
    expect(notesPurgeUnusedAssetsMock).toHaveBeenCalledWith("/vault", false);
    expect(notesPurgeUnusedAssetsMock).not.toHaveBeenCalledWith("/vault", true);

    await user.click(
      screen.getByRole("button", { name: "Delete 2 unused assets" })
    );
    const confirm = screen.getByRole("alertdialog", {
      name: "Delete unused Notes assets now?"
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Delete unused assets" })
    );

    await waitFor(() =>
      expect(notesPurgeUnusedAssetsMock).toHaveBeenLastCalledWith("/vault", true)
    );
  });

  it("clears a stale purge report when refreshing the preview fails", async () => {
    const user = userEvent.setup();
    render(
      <VaultRootContext.Provider value="/vault">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Check unused assets" }));
    await screen.findByText("2 unused assets (4,096 bytes)");
    notesPurgeUnusedAssetsMock.mockRejectedValueOnce(
      new Error("Preview changed; run a new dry-run.")
    );
    await user.click(
      screen.getByRole("button", { name: "Refresh unused assets" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("new dry-run");
    expect(screen.queryByText("2 unused assets (4,096 bytes)")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete 2 unused assets" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check unused assets" })
    ).toBeEnabled();
  });

  it("invalidates purge previews and in-flight responses when the vault changes", async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<{ count: number; totalBytes: number }>();
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Check unused assets" }));
    await screen.findByText("2 unused assets (4,096 bytes)");
    notesPurgeUnusedAssetsMock.mockReturnValueOnce(staleRefresh.promise);
    await user.click(
      screen.getByRole("button", { name: "Refresh unused assets" })
    );

    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );
    expect(
      screen.queryByText("2 unused assets (4,096 bytes)")
    ).not.toBeInTheDocument();
    await act(async () => staleRefresh.resolve({ count: 9, totalBytes: 99 }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check unused assets" })
      ).toBeEnabled()
    );
    expect(screen.queryByText("9 unused assets (99 bytes)")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete 9 unused assets" })
    ).not.toBeInTheDocument();
  });

  it("rejects a stale purge confirmation callback rendered for vault B", async () => {
    const user = userEvent.setup();
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Check unused assets" }));
    await screen.findByText("2 unused assets (4,096 bytes)");
    await user.click(
      screen.getByRole("button", { name: "Delete 2 unused assets" })
    );
    notesPurgeUnusedAssetsMock.mockClear();

    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );
    const staleConfirm = latestOpenConfirmation(
      "Delete unused Notes assets now?"
    );
    await act(async () => staleConfirm());

    expect(notesPurgeUnusedAssetsMock).not.toHaveBeenCalled();
  });

  it("closes a delete confirmation from vault A before it can delete vault B", async () => {
    const user = userEvent.setup();
    const deleteVaultB = vi.fn();
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    expect(
      screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
    ).toBeInTheDocument();

    activeDeleteAllNotesDataMock.current = deleteVaultB;
    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    expect(
      screen.queryByRole("alertdialog", { name: "Delete all Notes data?" })
    ).not.toBeInTheDocument();
    expect(deleteVaultB).not.toHaveBeenCalled();
  });

  it("closes a discard confirmation from vault A before it can delete vault B", async () => {
    const user = userEvent.setup();
    const deleteVaultB = vi.fn();
    deleteAllNotesDataMock.mockRejectedValueOnce(
      Object.assign(new Error("A draft could not be saved."), {
        name: "NotesDraftsFlushFailedError",
        code: NOTES_DRAFTS_FLUSH_FAILED_CODE
      })
    );
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );
    expect(
      await screen.findByRole("alertdialog", {
        name: "Discard unsaved edits and delete?"
      })
    ).toBeInTheDocument();

    activeDeleteAllNotesDataMock.current = deleteVaultB;
    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    expect(
      screen.queryByRole("alertdialog", {
        name: "Discard unsaved edits and delete?"
      })
    ).not.toBeInTheDocument();
    expect(deleteVaultB).not.toHaveBeenCalled();
  });

  it("does not close vault B when a vault A deletion succeeds later", async () => {
    const user = userEvent.setup();
    const deletion = deferred<{ attachmentCleanupFailed: boolean }>();
    const onOpenChange = vi.fn();
    deleteAllNotesDataMock.mockReturnValueOnce(deletion.promise);
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={onOpenChange} />
      </VaultRootContext.Provider>
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );
    await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledOnce());

    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={onOpenChange} />
      </VaultRootContext.Provider>
    );
    onOpenChange.mockClear();
    await act(async () => deletion.resolve({ attachmentCleanupFailed: false }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close Notes data settings" })
      ).toBeEnabled()
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("does not show a vault A cleanup warning after switching to vault B", async () => {
    const user = userEvent.setup();
    const deletion = deferred<{ attachmentCleanupFailed: boolean }>();
    deleteAllNotesDataMock.mockReturnValueOnce(deletion.promise);
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );
    await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledOnce());

    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );
    await act(async () => deletion.resolve({ attachmentCleanupFailed: true }));

    expect(
      screen.queryByText(/some attachment files could not be removed/)
    ).not.toBeInTheDocument();
  });

  it("does not show a vault A deletion error after switching to vault B", async () => {
    const user = userEvent.setup();
    const deletion = deferred<never>();
    deleteAllNotesDataMock.mockReturnValueOnce(deletion.promise);
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );
    await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledOnce());

    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );
    await act(async () => deletion.reject(new Error("Vault A database is busy")));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not reopen vault A discard confirmation after switching to vault B", async () => {
    const user = userEvent.setup();
    const deletion = deferred<never>();
    deleteAllNotesDataMock.mockReturnValueOnce(deletion.promise);
    const view = render(
      <VaultRootContext.Provider value="/vault-a">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );

    await user.click(
      screen.getByRole("button", { name: "Delete all Notes data" })
    );
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete all Notes data?" })
      ).getByRole("button", { name: "Delete Notes data" })
    );
    await waitFor(() => expect(deleteAllNotesDataMock).toHaveBeenCalledOnce());

    view.rerender(
      <VaultRootContext.Provider value="/vault-b">
        <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
      </VaultRootContext.Provider>
    );
    await act(async () =>
      deletion.reject(
        Object.assign(new Error("A draft could not be saved."), {
          name: "NotesDraftsFlushFailedError",
          code: NOTES_DRAFTS_FLUSH_FAILED_CODE
        })
      )
    );

    expect(
      screen.queryByRole("alertdialog", {
        name: "Discard unsaved edits and delete?"
      })
    ).not.toBeInTheDocument();
  });
});
