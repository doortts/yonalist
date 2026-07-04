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
  it("renders each comment with its author-association badge", () => {
    render(<CommentThread comments={comments} subjectAuthor="doortts" />);

    const thread = screen.getByLabelText("Comments");
    expect(within(thread).getByText("first reply")).toBeInTheDocument();
    expect(within(thread).getByText("Member")).toBeInTheDocument();
    // doortts is the subject author → "Author" badge overrides Owner.
    expect(within(thread).getByText("Author")).toBeInTheDocument();
  });

  it("renders nothing when there are no comments", () => {
    const { container } = render(<CommentThread comments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("OpeningPost", () => {
  it("renders the post full width without an initial-letter avatar", () => {
    const { container } = render(
      <OpeningPost
        author={{ login: "octocat" }}
        subtitle="Issue · opened 1d ago"
        body="hello"
      />
    );

    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Issue · opened 1d ago")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    // No initial-letter avatar fallback is rendered.
    expect(container.querySelector(".avatar")).toBeNull();
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
