import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

// jsdom ships without IntersectionObserver; the composer uses one to detect
// when its settle sentinel scrolls into the detail viewport. Install a
// controllable mock that captures each observer so tests can drive
// intersection changes deterministically.
interface MockObserver {
  callback: IntersectionObserverCallback;
  target: Element | null;
  instance: IntersectionObserver;
}
const observers: MockObserver[] = [];

class IntersectionObserverMock {
  private record: MockObserver;

  constructor(callback: IntersectionObserverCallback) {
    this.record = {
      callback,
      target: null,
      instance: this as unknown as IntersectionObserver
    };
    observers.push(this.record);
  }

  observe(target: Element) {
    this.record.target = target;
  }

  unobserve() {
    this.record.target = null;
  }

  disconnect() {
    const index = observers.indexOf(this.record);
    if (index >= 0) {
      observers.splice(index, 1);
    }
  }

  takeRecords() {
    return [] as IntersectionObserverEntry[];
  }
}

function fireSettle(isIntersecting: boolean) {
  const observer = observers[observers.length - 1];
  if (!observer) {
    throw new Error("no IntersectionObserver was created by the composer");
  }
  act(() => {
    observer.callback(
      [
        {
          isIntersecting,
          target: observer.target
        } as unknown as IntersectionObserverEntry
      ],
      observer.instance
    );
  });
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ControlledComposer({ initial = "" }: { initial?: string }) {
  const [draft, setDraft] = useState(initial);
  return (
    <CommentComposer
      draft={draft}
      online
      canClose
      onDraftChange={setDraft}
      onSubmit={vi.fn()}
    />
  );
}

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

  it("starts collapsed as a single-line bar with the action buttons hidden", () => {
    const { container } = render(<ControlledComposer />);

    const form = container.querySelector(".comment-composer");
    expect(form).not.toBeNull();
    expect(form).toHaveClass("is-collapsed");
    expect(form).toHaveAttribute("data-expanded", "false");

    // The one-line bar is the textarea itself; it stays reachable so a click
    // or focus can expand the composer.
    expect(screen.getByLabelText("Write a comment")).toBeInTheDocument();
    // Collapsed hides the action buttons and the Write/Preview tabs.
    expect(
      screen.queryByRole("button", { name: "Comment" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Comment and close" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("expands and keeps focus when the collapsed bar is focused", async () => {
    const user = userEvent.setup();
    const { container } = render(<ControlledComposer />);
    const textarea = screen.getByLabelText("Write a comment");

    await user.click(textarea);

    const form = container.querySelector(".comment-composer");
    expect(form).toHaveClass("is-expanded");
    expect(form).toHaveAttribute("data-expanded", "true");
    // Focus is retained on the same textarea after expanding.
    expect(document.activeElement).toBe(textarea);
    // Buttons appear once expanded (disabled while the draft is empty).
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("collapses again after blur when the draft is empty and not settled", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <ControlledComposer />
        <button type="button">outside</button>
      </>
    );
    const textarea = screen.getByLabelText("Write a comment");

    await user.click(textarea);
    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-expanded"
    );

    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-collapsed"
    );
  });

  it("stays expanded while a draft is present even without focus", () => {
    const { container } = render(<ControlledComposer initial="draft text" />);

    const form = container.querySelector(".comment-composer");
    expect(form).toHaveClass("is-expanded");
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("auto-expands when the settle sentinel becomes visible and re-collapses when it leaves", () => {
    const { container } = render(<ControlledComposer />);

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-collapsed"
    );

    // Sentinel enters the detail viewport -> composer has settled at the
    // bottom of the thread and expands without stealing focus.
    fireSettle(true);

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-expanded"
    );
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Write a comment")
    );

    // Scrolling away hides the sentinel again -> collapse (unfocused, empty).
    fireSettle(false);

    expect(container.querySelector(".comment-composer")).toHaveClass(
      "is-collapsed"
    );
  });

  it("renders a settle sentinel after the composer form", () => {
    const { container } = render(<ControlledComposer />);

    const sentinel = container.querySelector(".composer-dock-sentinel");
    expect(sentinel).not.toBeNull();

    const form = container.querySelector(".comment-composer");
    expect(
      form!.compareDocumentPosition(sentinel!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders the Write/Preview tab row as an overlay so typing does not shift the form", () => {
    const { container } = render(<ControlledComposer initial="hello" />);

    const toggleRow = container.querySelector(".composer-preview-toggle-row");
    expect(toggleRow).not.toBeNull();
    // The overlay class takes the tab row out of flow (absolute), so it no
    // longer pushes the textarea down when it appears.
    expect(toggleRow).toHaveClass("composer-tabs-overlay");
  });
});
