import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import type { NotesDataRepairReport } from "../../services/notesStore";

const flushAllDraftsMock = vi.hoisted(() => vi.fn());
const notesRepairDataMock = vi.hoisted(() => vi.fn());
const workspaceState = vi.hoisted(() => ({
  stateStatus: "ready",
  draftsByNodeId: {} as Record<string, unknown>,
  writeError: null as Error | null
}));

vi.mock("../../services/notesStore", () => ({
  notesRepairData: notesRepairDataMock
}));

vi.mock("./NotesWorkspaceContext", () => ({
  useNotesActions: () => ({
    actions: { flushAllDrafts: flushAllDraftsMock }
  }),
  useNotesDrafts: () => ({
    draftsByNodeId: workspaceState.draftsByNodeId,
    writeError: workspaceState.writeError
  }),
  useNotesState: () => ({
    state: { status: workspaceState.stateStatus }
  })
}));

import {
  NOTES_DATA_REPAIR_NOTICE_KEY,
  NotesDataRepairAction,
  readNotesDataRepairNotice,
  takeNotesDataRepairNotice
} from "./NotesDataRepairAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function repairActionTree(
  vaultRoot: string,
  reloadApplication: () => void
) {
  return (
    <VaultRootContext.Provider value={vaultRoot}>
      <NotesDataRepairAction reloadApplication={reloadApplication} />
    </VaultRootContext.Provider>
  );
}

async function confirmRepair(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Repair Notes data" }));
  await user.click(
    within(
      screen.getByRole("alertdialog", { name: "Repair Notes data?" })
    ).getByRole("button", { name: "Repair Notes data" })
  );
}

describe("NotesDataRepairAction", () => {
  beforeEach(() => {
    sessionStorage.clear();
    flushAllDraftsMock.mockReset();
    flushAllDraftsMock.mockResolvedValue(true);
    notesRepairDataMock.mockReset();
    notesRepairDataMock.mockResolvedValue({
      repairedNodeCount: 3,
      backedUpFileCount: 1,
      backupPath: "/vault/.yonalist/notes-repair-backups/repair-1"
    });
    workspaceState.stateStatus = "ready";
    workspaceState.draftsByNodeId = {};
    workspaceState.writeError = null;
  });

  it("flushes drafts, repairs, stores the result, and reloads", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    render(repairActionTree("/vault", reloadApplication));

    await confirmRepair(user);

    expect(flushAllDraftsMock).toHaveBeenCalledOnce();
    expect(notesRepairDataMock).toHaveBeenCalledWith("/vault");
    expect(
      JSON.parse(sessionStorage.getItem(NOTES_DATA_REPAIR_NOTICE_KEY)!)
    ).toMatchObject({ repairedNodeCount: 3 });
    expect(reloadApplication).toHaveBeenCalledOnce();
  });

  it("proceeds without a draft flush result when no workspace or drafts exist", async () => {
    const user = userEvent.setup();
    workspaceState.stateStatus = "error";
    flushAllDraftsMock.mockResolvedValue(false);
    notesRepairDataMock.mockResolvedValue({
      repairedNodeCount: 0,
      backedUpFileCount: 0,
      backupPath: null
    });
    render(repairActionTree("/vault", vi.fn()));

    await confirmRepair(user);

    expect(notesRepairDataMock).toHaveBeenCalledWith("/vault");
  });

  it("blocks repair when real unsaved drafts cannot flush", async () => {
    const user = userEvent.setup();
    flushAllDraftsMock.mockResolvedValue(false);
    workspaceState.draftsByNodeId = {
      node: {
        title: "Unsaved",
        note: "",
        imageOffsetUtf16: 0,
        revision: 1,
        status: "failed"
      }
    };
    render(repairActionTree("/vault", vi.fn()));

    await confirmRepair(user);

    expect(notesRepairDataMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unsaved Notes edits could not be written."
    );
  });

  it("ignores a completed request after the Vault changes", async () => {
    const user = userEvent.setup();
    const request = deferred<NotesDataRepairReport>();
    const reloadApplication = vi.fn();
    notesRepairDataMock.mockReturnValue(request.promise);
    const view = render(repairActionTree("/vault-a", reloadApplication));

    await confirmRepair(user);
    view.rerender(repairActionTree("/vault-b", reloadApplication));
    await act(async () => {
      request.resolve({
        repairedNodeCount: 1,
        backedUpFileCount: 1,
        backupPath: "/vault-a/backup"
      });
      await request.promise;
    });

    expect(sessionStorage.getItem(NOTES_DATA_REPAIR_NOTICE_KEY)).toBeNull();
    expect(reloadApplication).not.toHaveBeenCalled();
  });

  it("reads a repair notice without consuming it, then takes it once", () => {
    sessionStorage.setItem(
      NOTES_DATA_REPAIR_NOTICE_KEY,
      JSON.stringify({
        repairedNodeCount: 2,
        backedUpFileCount: 1,
        backupPath: "/backup"
      })
    );
    expect(readNotesDataRepairNotice(sessionStorage)).toEqual({
      repairedNodeCount: 2,
      backedUpFileCount: 1,
      backupPath: "/backup"
    });
    expect(sessionStorage.getItem(NOTES_DATA_REPAIR_NOTICE_KEY)).not.toBeNull();
    expect(takeNotesDataRepairNotice(sessionStorage)).toEqual({
      repairedNodeCount: 2,
      backedUpFileCount: 1,
      backupPath: "/backup"
    });
    expect(sessionStorage.getItem(NOTES_DATA_REPAIR_NOTICE_KEY)).toBeNull();

    sessionStorage.setItem(
      NOTES_DATA_REPAIR_NOTICE_KEY,
      JSON.stringify({ repairedNodeCount: "2" })
    );
    expect(takeNotesDataRepairNotice(sessionStorage)).toBeNull();
    expect(sessionStorage.getItem(NOTES_DATA_REPAIR_NOTICE_KEY)).toBeNull();
  });

  it("reloads after a successful repair when result storage is unavailable", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    render(repairActionTree("/vault", reloadApplication));

    await confirmRepair(user);

    expect(notesRepairDataMock).toHaveBeenCalledWith("/vault");
    expect(reloadApplication).toHaveBeenCalledOnce();
  });
});
