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

function FeedbackControls({
  onPublish
}: {
  onPublish(publish: ReturnType<typeof useNotesFeedback>["publish"]): void;
}) {
  onPublish(useNotesFeedback().publish);
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

  it("remounts and restarts the timeout for a repeated identical message", () => {
    vi.useFakeTimers();
    let publish: ReturnType<typeof useNotesFeedback>["publish"] | undefined;
    render(
      <NotesFeedbackProvider active>
        <FeedbackControls onPublish={(next) => (publish = next)} />
        <NotesStatusBarMessage />
      </NotesFeedbackProvider>
    );

    act(() => publish?.({ kind: "status", message: "Copied." }));
    const firstRegion = screen.getByRole("status");
    act(() => vi.advanceTimersByTime(3000));
    act(() => publish?.({ kind: "status", message: "Copied." }));

    expect(screen.getByRole("status")).not.toBe(firstRegion);
    act(() => vi.advanceTimersByTime(5999));
    expect(screen.getByRole("status")).toHaveTextContent("Copied.");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

  it("ignores feedback published after Notes becomes inactive", () => {
    let publish: ReturnType<typeof useNotesFeedback>["publish"] | undefined;
    const tree = (active: boolean) => (
      <NotesFeedbackProvider active={active}>
        <FeedbackControls onPublish={(next) => (publish = next)} />
        <NotesStatusBarMessage />
      </NotesFeedbackProvider>
    );
    const { rerender } = render(tree(true));
    act(() => publish?.({ kind: "status", message: "Copied." }));
    expect(screen.getByRole("status")).toHaveTextContent("Copied.");

    rerender(tree(false));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => publish?.({ kind: "error", message: "Late failure." }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Late failure.")).not.toBeInTheDocument();
  });
});
