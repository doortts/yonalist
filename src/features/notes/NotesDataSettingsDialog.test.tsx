import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTES_DRAFTS_FLUSH_FAILED_CODE } from "./useNotesWorkspace";

const deleteAllNotesDataMock = vi.hoisted(() => vi.fn());

vi.mock("./NotesWorkspaceContext", () => ({
  useNotesWorkspaceContext: () => ({
    actions: { deleteAllNotesData: deleteAllNotesDataMock },
    deletingNotesData: false
  })
}));

import { NotesDataSettingsDialog } from "./NotesDataSettingsDialog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("NotesDataSettingsDialog", () => {
  beforeEach(() => {
    deleteAllNotesDataMock.mockReset();
    deleteAllNotesDataMock.mockResolvedValue({ attachmentCleanupFailed: false });
  });

  it("requires confirmation and cancellation has no side effect", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <NotesDataSettingsDialog open onOpenChange={onOpenChange} />
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
      <NotesDataSettingsDialog open onOpenChange={onOpenChange} />
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
    deleteAllNotesDataMock.mockRejectedValueOnce(new Error("Database is busy"));
    render(
      <NotesDataSettingsDialog open onOpenChange={vi.fn()} />
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
  });

  it("blocks dialog dismissal while deletion is pending", async () => {
    const user = userEvent.setup();
    const deletion = deferred<void>();
    const onOpenChange = vi.fn();
    deleteAllNotesDataMock.mockReturnValue(deletion.promise);
    render(
      <NotesDataSettingsDialog open onOpenChange={onOpenChange} />
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
    render(<NotesDataSettingsDialog open onOpenChange={onOpenChange} />);

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
});
