import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

describe("CommentComposer", () => {
  it("previews the rendered markdown draft from the Preview tab", async () => {
    const user = userEvent.setup();
    render(
      <CommentComposer
        draft={"**hello**"}
        online
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    // With a draft present the Write/Preview tabs render, Write active first.
    expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
    expect(screen.queryByLabelText("Comment preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Preview" }));

    const preview = screen.getByLabelText("Comment preview");
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(preview.querySelector("strong")).toHaveTextContent("hello");
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.queryByLabelText("Write a comment")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Write" }));

    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
    expect(screen.queryByLabelText("Comment preview")).not.toBeInTheDocument();
  });

  it("shows the Write/Preview tabs only after the user starts typing", async () => {
    const user = userEvent.setup();
    function WrappedComposer() {
      const [draft, setDraft] = useState("");
      return (
        <CommentComposer
          draft={draft}
          online
          onDraftChange={setDraft}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<WrappedComposer />);

    expect(screen.queryByRole("tab")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Write a comment"), "hello");

    expect(screen.getByRole("tab", { name: "Write" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Preview" })).toBeInTheDocument();
  });

  it("moves between the Write and Preview tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <CommentComposer
        draft={"**hi**"}
        online
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const writeTab = screen.getByRole("tab", { name: "Write" });
    writeTab.focus();

    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByLabelText("Comment preview")).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
  });

  it("grows the textarea to fit wrapped content", async () => {
    function WrappedComposer() {
      const [draft, setDraft] = useState("hello");
      return (
        <CommentComposer
          draft={draft}
          online
          onDraftChange={setDraft}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<WrappedComposer />);
    const textarea = screen.getByLabelText("Write a comment");
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 180
    });

    fireEvent.change(textarea, { target: { value: "hello\nworld" } });

    await waitFor(() => {
      expect(textarea).toHaveStyle({ height: "180px" });
    });
  });

  it("reports draft changes", () => {
    const onDraftChange = vi.fn();
    render(
      <CommentComposer
        draft={"hello"}
        online
        onDraftChange={onDraftChange}
        onSubmit={vi.fn()}
      />
    );
    const textarea = screen.getByLabelText("Write a comment");

    fireEvent.change(textarea, { target: { value: "hello\nworld" } });

    expect(onDraftChange).toHaveBeenCalledWith("hello\nworld");
  });

  it("submits comment-and-close separately from a regular comment", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CommentComposer
        draft={"Done"}
        online
        canClose
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Comment and close" }));
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenNthCalledWith(1, "comment-and-close");
    expect(onSubmit).toHaveBeenNthCalledWith(2, "comment");
  });
});
