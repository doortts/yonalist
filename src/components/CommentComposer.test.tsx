import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

describe("CommentComposer", () => {
  it("previews the rendered markdown draft", async () => {
    const user = userEvent.setup();
    render(
      <CommentComposer
        draft={"**hello**"}
        online
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    await user.click(screen.getByRole("tab", { name: /preview/i }));

    const preview = screen.getByLabelText("Comment preview");
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(preview.querySelector("strong")).toHaveTextContent("hello");
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
