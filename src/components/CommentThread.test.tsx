import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

  it("renders nothing when there are no comments", () => {
    const { container } = render(<CommentThread comments={[]} />);
    expect(container).toBeEmptyDOMElement();
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
    // No initial-letter avatar fallback is rendered.
    expect(container.querySelector(".avatar")).toBeNull();
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
