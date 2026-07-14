import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConversationComment } from "../domain/conversation";
import { CommentThread, OpeningPost } from "./CommentThread";

const comments: ConversationComment[] = [
  {
    id: "1",
    author: "mona",
    authorAssociation: "MEMBER",
    created_at: "2026-07-02T00:00:00Z",
    body: "first reply"
  },
  {
    id: "2",
    author: "doortts",
    authorAssociation: "OWNER",
    created_at: "2026-07-02T01:00:00Z",
    body: "author reply"
  }
];

describe("CommentThread", () => {
  it("renders each comment with its author-association badge", async () => {
    render(<CommentThread comments={comments} subjectAuthor="doortts" />);

    const thread = screen.getByLabelText("Comments");
    expect(await within(thread).findByText("first reply")).toBeInTheDocument();
    expect(within(thread).getByText("Member")).toBeInTheDocument();
    // doortts is the subject author → "Author" badge overrides Owner.
    expect(within(thread).getByText("Author")).toBeInTheDocument();
  });

  it("shows only a display name and keeps the login in a tooltip", () => {
    render(
      <CommentThread
        comments={[
          {
            id: "3",
            author: "yogno-koo",
            authorName: "Yogno Koo",
            created_at: "2026-07-02T00:00:00Z",
            body: "named reply"
          }
        ]}
      />
    );

    expect(screen.getByText("Yogno Koo")).toHaveAttribute("title", "yogno-koo");
    expect(screen.queryByText("Yogno Koo yogno-koo")).not.toBeInTheDocument();
  });

  it("renders nested discussion replies below their parent comment", async () => {
    render(
      <CommentThread
        comments={[
          {
            id: "parent",
            author: "mona",
            created_at: "2026-07-02T00:00:00Z",
            body: "parent discussion comment",
            replies: [
              {
                id: "reply",
                author: "octocat",
                created_at: "2026-07-02T01:00:00Z",
                body: "threaded discussion reply"
              }
            ]
          }
        ]}
      />
    );

    expect(await screen.findByText("parent discussion comment")).toBeInTheDocument();
    const replies = screen.getByLabelText("Replies");
    expect(within(replies).getByText("threaded discussion reply")).toBeInTheDocument();
  });

  it("renders nested replies as timeline bubbles with author metadata outside the bubble", async () => {
    render(
      <CommentThread
        comments={[
          {
            id: "parent",
            author: "mona",
            created_at: "2026-07-02T00:00:00Z",
            body: "parent",
            replies: [
              {
                id: "reply-1",
                author: "ted-hwang",
                authorAssociation: "MEMBER",
                created_at: "2026-07-02T01:00:00Z",
                body: "first nested reply"
              },
              {
                id: "reply-2",
                author: "ted-hwang",
                authorAssociation: "MEMBER",
                created_at: "2026-07-02T02:00:00Z",
                body: "second nested reply"
              },
              {
                id: "reply-3",
                author: "octocat",
                created_at: "2026-07-02T03:00:00Z",
                body: "different author reply"
              }
            ]
          }
        ]}
      />
    );

    const replies = screen.getByLabelText("Replies");
    expect(await within(replies).findByText("first nested reply")).toBeInTheDocument();
    expect(within(replies).getByText("second nested reply")).toBeInTheDocument();
    expect(within(replies).getByText("different author reply")).toBeInTheDocument();
    expect(replies.querySelectorAll(".comment-reply-author-row")).toHaveLength(2);
    expect(replies.querySelectorAll(".comment-reply-card.is-compact")).toHaveLength(1);

    const firstReply = replies.querySelector(".comment-reply-card") as HTMLElement;
    expect(firstReply.querySelector(".comment-reply-author-row")).toHaveTextContent(
      "ted-hwang"
    );
    expect(firstReply.querySelector(".comment-reply-author-row")).toHaveTextContent(
      "Member"
    );
    expect(firstReply.querySelector(".comment-reply-header")).not.toHaveTextContent(
      "ted-hwang"
    );

    const compactReply = replies.querySelector(
      ".comment-reply-card.is-compact"
    ) as HTMLElement;
    expect(compactReply.querySelector(".comment-reply-author-row")).toBeNull();
    expect(compactReply.querySelector(".comment-reply-header")).not.toHaveTextContent(
      "comment added"
    );
    expect(within(replies).queryByText("comment added")).not.toBeInTheDocument();
  });

  it("opens an auto-growing inline reply composer from the comment hover action", async () => {
    const user = userEvent.setup();
    const onReplySubmit = vi.fn();
    render(
      <CommentThread
        comments={[
          {
            id: "parent",
            nodeId: "DC_parent",
            author: "mona",
            created_at: "2026-07-02T00:00:00Z",
            body: "parent discussion comment"
          }
        ]}
        onReplySubmit={onReplySubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "대댓글 추가" }));

    const textarea = screen.getByLabelText("대댓글 입력");
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 56
    });
    fireEvent.change(textarea, { target: { value: "first line\nsecond line" } });

    await waitFor(() => {
      expect(textarea).toHaveStyle({ height: "56px" });
    });

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onReplySubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "parent", nodeId: "DC_parent" }),
      "first line\nsecond line"
    );
  });

  it("uses the top-level discussion comment as the target when replying from an existing reply", async () => {
    const user = userEvent.setup();
    const onReplySubmit = vi.fn();
    render(
      <CommentThread
        comments={[
          {
            id: "parent",
            nodeId: "DC_parent",
            author: "mona",
            created_at: "2026-07-02T00:00:00Z",
            body: "parent discussion comment",
            replies: [
              {
                id: "reply",
                nodeId: "DC_reply",
                author: "octocat",
                created_at: "2026-07-02T01:00:00Z",
                body: "existing threaded reply"
              }
            ]
          }
        ]}
        onReplySubmit={onReplySubmit}
      />
    );

    const replies = screen.getByLabelText("Replies");
    await user.click(within(replies).getByRole("button", { name: "대댓글 추가" }));
    await user.type(screen.getByLabelText("대댓글 입력"), "reply to the thread");
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onReplySubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "parent", nodeId: "DC_parent" }),
      "reply to the thread"
    );
    expect(onReplySubmit).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "reply", nodeId: "DC_reply" }),
      expect.any(String)
    );
  });

  it("opens an inline reply composer with a restored draft when a queued reply is edited", () => {
    render(
      <CommentThread
        comments={[
          {
            id: "parent",
            nodeId: "DC_parent",
            author: "mona",
            created_at: "2026-07-02T00:00:00Z",
            body: "parent discussion comment"
          }
        ]}
        onReplySubmit={vi.fn()}
        replyDraft={{
          parentNodeId: "DC_parent",
          body: "restore this reply",
          version: 1
        }}
      />
    );

    expect(screen.getByLabelText("대댓글 입력")).toHaveValue("restore this reply");
  });

  it("renders nothing when there are no comments", () => {
    const { container } = render(<CommentThread comments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the first batch immediately when comments arrive after mount", () => {
    const { container, rerender } = render(<CommentThread comments={[]} />);

    rerender(<CommentThread comments={[comments[0]]} />);

    expect(container.querySelectorAll(".comment-item")).toHaveLength(1);
  });
});

describe("OpeningPost", () => {
  it("renders the post full width without an initial-letter avatar", async () => {
    const { container } = render(
      <OpeningPost
        author={{ login: "octocat" }}
        subtitle="Issue · opened 1d ago"
        body="hello"
      />
    );

    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Issue · opened 1d ago")).toBeInTheDocument();
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(container.querySelector(".entry-avatar-slot")).not.toBeNull();
    // No initial-letter avatar fallback is rendered.
    expect(container.querySelector(".avatar")).toBeNull();
  });

  it("keeps the opening post kind and date in the right-side meta area", () => {
    const { container } = render(
      <OpeningPost
        author={{ login: "octocat", name: "The Octocat" }}
        subtitle="Discussion · opened 1d ago"
        body="hello"
      />
    );

    const header = container.querySelector(".opening-post-header");
    const authorCluster = container.querySelector(".comment-author-cluster");
    const time = screen.getByText("Discussion · opened 1d ago");

    expect(header).toContainElement(authorCluster as HTMLElement);
    expect(time).toHaveClass("comment-time");
  });

  it("shows wireframe placeholders while opening post author details load", () => {
    const { container } = render(
      <OpeningPost
        author={{ login: "octocat", loading: true }}
        subtitle="Issue · opened 1d ago"
        body="hello"
      />
    );

    expect(screen.getByLabelText("Loading author for octocat")).toHaveClass(
      "comment-author-skeleton"
    );
    expect(screen.getByLabelText("Loading avatar for octocat")).toHaveClass(
      "avatar-skeleton"
    );
    expect(screen.queryByText("octocat")).not.toBeInTheDocument();
    expect(container.querySelector(".entry-avatar-slot")).not.toBeNull();
  });

  it("shows only the opening post author's display name and keeps the login in a tooltip", () => {
    render(
      <OpeningPost
        author={{ login: "octocat", name: "The Octocat" }}
        subtitle="Issue"
        body="hello"
      />
    );

    expect(screen.getByText("The Octocat")).toHaveAttribute("title", "octocat");
    expect(screen.queryByText("The Octocat octocat")).not.toBeInTheDocument();
  });

  it("shows a real avatar image when one is provided", () => {
    render(
      <OpeningPost
        author={{ login: "octocat", avatarUrl: "https://example.com/o.png" }}
        subtitle="Issue"
        body="hi"
      />
    );
    expect(screen.getByRole("img", { name: "octocat" })).toHaveAttribute(
      "src",
      "https://example.com/o.png"
    );
  });
});
