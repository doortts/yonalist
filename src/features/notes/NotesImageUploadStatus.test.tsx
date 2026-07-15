import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesImageUploadStatus } from "./NotesImageUploadStatus";

const retryImageUpload = vi.hoisted(() => vi.fn());

vi.mock("./NotesWorkspaceContext", () => ({
  useNotesActions: () => ({ actions: { retryImageUpload } })
}));

describe("NotesImageUploadStatus", () => {
  beforeEach(() => {
    retryImageUpload.mockReset().mockResolvedValue(undefined);
  });

  it("offers an ID-less retry that reopens the picker", async () => {
    const user = userEvent.setup();
    render(
      <NotesImageUploadStatus
        nodeId="image-node"
        uploadError="Image picker failed: dialog failed"
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Retry image upload" })
    );

    expect(retryImageUpload).toHaveBeenCalledOnce();
    expect(retryImageUpload).toHaveBeenCalledWith("image-node", undefined);
  });

  it("passes an upload attempt ID through unchanged", async () => {
    const user = userEvent.setup();
    render(
      <NotesImageUploadStatus
        nodeId="image-node"
        uploadError="Image upload failed: disk full"
        uploadRetryAttemptId="attempt-42"
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Retry image upload" })
    );

    expect(retryImageUpload).toHaveBeenCalledWith("image-node", "attempt-42");
  });

  it("hides retry while read-only", () => {
    render(
      <NotesImageUploadStatus
        nodeId="image-node"
        uploadError="Image picker failed: dialog failed"
        readOnly
      />
    );

    expect(screen.getByRole("alert", { name: "Image upload failed" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry image upload" })
    ).not.toBeInTheDocument();
  });

  it("does not offer upload retry for an unrelated validation error", () => {
    render(
      <NotesImageUploadStatus
        nodeId="image-node"
        uploadError="Drop one image at a time."
      />
    );

    expect(screen.getByRole("alert", { name: "Image upload failed" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry image upload" })
    ).not.toBeInTheDocument();
  });

  it("does not infer an upload failure from retry action availability", () => {
    render(<NotesImageUploadStatus nodeId="image-node" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
