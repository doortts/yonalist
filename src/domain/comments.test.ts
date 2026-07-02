import { describe, expect, it } from "vitest";
import { sortCommentsByTimeline } from "./comments";
import type { CommentDocument } from "./types";

describe("comment ordering", () => {
  it("orders comments by created time and remote id", () => {
    const comments: CommentDocument[] = [
      {
        path: "c.md",
        body: "third",
        frontMatter: {
          kind: "comment",
          remote_id: 3,
          node_id: "c",
          author: "mona",
          created_at: "2026-07-01T00:00:01Z",
          updated_at: "2026-07-01T00:00:01Z",
          sync: { status: "synced" }
        }
      },
      {
        path: "a.md",
        body: "first",
        frontMatter: {
          kind: "comment",
          remote_id: 1,
          node_id: "a",
          author: "mona",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-01T00:00:00Z",
          sync: { status: "synced" }
        }
      },
      {
        path: "b.md",
        body: "second",
        frontMatter: {
          kind: "comment",
          remote_id: 2,
          node_id: "b",
          author: "mona",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-01T00:00:00Z",
          sync: { status: "synced" }
        }
      }
    ];

    expect(sortCommentsByTimeline(comments).map((comment) => comment.body)).toEqual([
      "first",
      "second",
      "third"
    ]);
  });
});
