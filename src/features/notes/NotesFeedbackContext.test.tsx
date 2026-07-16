import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotesFeedbackProvider,
  NotesStatusBarMessage,
  useNotesFeedback
} from "./NotesFeedbackContext";

function FeedbackPublisher({
  kind,
  message
}: {
  kind: "status" | "error";
  message: string;
}) {
  const { publish } = useNotesFeedback();
  useEffect(() => {
    publish({ kind, message });
  }, [kind, message, publish]);
  return null;
}

function renderFeedbackTree({
  active,
  message
}: {
  active: boolean;
  message: string | null;
}) {
  return (
    <NotesFeedbackProvider active={active}>
      {message && <FeedbackPublisher kind="status" message={message} />}
      <NotesStatusBarMessage />
    </NotesFeedbackProvider>
  );
}

function renderFeedback(props: { active: boolean; message: string | null }) {
  return render(renderFeedbackTree(props));
}

describe("NotesFeedbackProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows errors in the status bar and clears them after six seconds", () => {
    vi.useFakeTimers();
    render(
      <NotesFeedbackProvider active>
        <FeedbackPublisher kind="error" message="Can't indent selection." />
        <NotesStatusBarMessage />
      </NotesFeedbackProvider>
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Can't indent selection."
    );
    act(() => vi.advanceTimersByTime(5999));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears Notes feedback when Notes becomes inactive", () => {
    const { rerender } = renderFeedback({
      active: true,
      message: "Moved selection."
    });
    expect(screen.getByRole("status")).toHaveTextContent("Moved selection.");

    rerender(renderFeedbackTree({ active: false, message: null }));

    expect(screen.queryByText("Moved selection.")).not.toBeInTheDocument();
  });
});
