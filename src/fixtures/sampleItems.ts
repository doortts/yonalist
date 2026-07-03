import type { ItemDocument } from "../domain/types";

export const SAMPLE_VAULT_ROOT = "/vault";

const syncedAt = "2026-07-02T12:00:00Z";

export const sampleItems: ItemDocument[] = [
  {
    path: "/vault/github.com/Yona-projects/Home/issues/42/issue.md",
    body:
      "Offline-first reading keeps GitHub work available on a laptop even when the network disappears.\n\n- cache markdown\n- preserve local favorite metadata\n- sync queued replies later",
    frontMatter: {
      kind: "issue",
      host: "github.com",
      owner: "Yona-projects",
      repo: "Home",
      number: 42,
      node_id: "I_42",
      html_url: "https://github.com/Yona-projects/Home/issues/42",
      title: "Design offline issue reading",
      state: "open",
      author: "doortts",
      labels: ["offline", "sync"],
      created_at: "2026-07-01T10:00:00Z",
      updated_at: "2026-07-02T09:00:00Z",
      synced_at: syncedAt,
      local: { favorite: true },
      sync: { status: "synced" }
    }
  },
  {
    path: "/vault/github.com/doortts/blog/pulls/17/pull.md",
    body:
      "This pull request is available for offline review as a conversation thread. Line review is reserved for a later release.",
    frontMatter: {
      kind: "pull",
      host: "github.com",
      owner: "doortts",
      repo: "blog",
      number: 17,
      node_id: "PR_17",
      html_url: "https://github.com/doortts/blog/pull/17",
      title: "Refresh publishing notes",
      state: "open",
      author: "mona",
      labels: ["docs"],
      created_at: "2026-06-30T10:00:00Z",
      updated_at: "2026-07-01T12:00:00Z",
      synced_at: syncedAt,
      local: { favorite: false },
      sync: { status: "synced" }
    }
  },
  {
    path: "/vault/github.com/doortts/blog/discussions/5/discussion.md",
    body:
      "Let's collect everything needed before tagging v0.1.0.\n\n- [ ] icons\n- [ ] release notes\n- [ ] signing",
    frontMatter: {
      kind: "discussion",
      host: "github.com",
      owner: "doortts",
      repo: "blog",
      number: 5,
      node_id: "D_5",
      html_url: "https://github.com/doortts/blog/discussions/5",
      title: "v0.1.0 packaging checklist",
      state: "open",
      author: "doortts",
      labels: ["release"],
      created_at: "2026-06-28T10:00:00Z",
      updated_at: "2026-07-01T04:00:00Z",
      synced_at: syncedAt,
      local: { favorite: false },
      sync: { status: "synced" }
    }
  }
];

/** Demo conversation threads so the detail pane shows comments offline. */
export function sampleItemThread(item: ItemDocument): {
  state: "open" | "closed" | "merged";
  draft: boolean;
  comments: Array<{ id: string; author: string; created_at: string; body: string }>;
} {
  return {
    state: item.frontMatter.state,
    draft: false,
    comments: [
      {
        id: `${item.frontMatter.number}-sample-1`,
        author: "mona",
        created_at: item.frontMatter.updated_at,
        body: "Sample reply so the conversation thread layout is visible offline."
      },
      {
        id: `${item.frontMatter.number}-sample-2`,
        author: item.frontMatter.author,
        created_at: item.frontMatter.updated_at,
        body: "Thanks! Sign in from Settings to load the real thread."
      }
    ]
  };
}
