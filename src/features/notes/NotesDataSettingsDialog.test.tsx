import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteAllNotesDataMock = vi.hoisted(() => vi.fn());

vi.mock("./NotesWorkspaceContext", () => ({
  useNotesWorkspaceContext: () => ({
    actions: { deleteAllNotesData: deleteAllNotesDataMock }
  })
}));

import { NotesDataSettingsDialog } from "./NotesDataSettingsDialog";

describe("NotesDataSettingsDialog", () => {
  beforeEach(() => {
    deleteAllNotesDataMock.mockReset();
    deleteAllNotesDataMock.mockResolvedValue(undefined);
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

  it("keeps an asynchronous deletion failure visible and retryable", async () => {
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
    expect(
      screen.getByRole("button", { name: "Delete all Notes data" })
    ).toBeEnabled();
  });
});
