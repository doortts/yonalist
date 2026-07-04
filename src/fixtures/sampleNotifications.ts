import { subjectNumber, type GitHubNotification } from "../domain/notifications";
import type { NotificationDetailContent } from "../services/notificationDetail";
import { sampleItems } from "./sampleItems";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(offsetMs: number, now: Date): string {
  return new Date(now.valueOf() - offsetMs).toISOString();
}

/** Demo notifications shown until a personal access token is configured. */
export function sampleNotifications(now: Date = new Date()): GitHubNotification[] {
  return [
    {
      id: "sample-1",
      unread: true,
      reason: "mention",
      updated_at: iso(2 * HOUR, now),
      last_read_at: null,
      subject: {
        title: "Design offline issue reading",
        url: "https://api.github.com/repos/Yona-projects/Home/issues/42",
        type: "Issue"
      },
      repository: {
        full_name: "Yona-projects/Home",
        name: "Home",
        owner: { login: "Yona-projects" }
      }
    },
    {
      id: "sample-2",
      unread: true,
      reason: "review_requested",
      updated_at: iso(5 * HOUR, now),
      last_read_at: null,
      subject: {
        title: "Refresh publishing notes",
        url: "https://api.github.com/repos/doortts/blog/pulls/17",
        type: "PullRequest"
      },
      repository: {
        full_name: "doortts/blog",
        name: "blog",
        owner: { login: "doortts" }
      }
    },
    {
      id: "sample-3",
      unread: false,
      reason: "comment",
      updated_at: iso(DAY + 3 * HOUR, now),
      last_read_at: iso(DAY + 2 * HOUR, now),
      subject: {
        title: "Cache linked attachments in the vault",
        url: "https://api.github.com/repos/Yona-projects/Home/issues/38",
        type: "Issue"
      },
      repository: {
        full_name: "Yona-projects/Home",
        name: "Home",
        owner: { login: "Yona-projects" }
      }
    },
    {
      id: "sample-4",
      unread: false,
      reason: "author",
      updated_at: iso(DAY + 8 * HOUR, now),
      last_read_at: iso(DAY + 6 * HOUR, now),
      subject: {
        title: "v0.1.0 packaging checklist",
        url: "https://api.github.com/repos/doortts/blog/discussions/5",
        type: "Discussion"
      },
      repository: {
        full_name: "doortts/blog",
        name: "blog",
        owner: { login: "doortts" }
      }
    },
    {
      id: "sample-5",
      unread: true,
      reason: "subscribed",
      updated_at: iso(3 * DAY, now),
      last_read_at: null,
      subject: {
        title: "Yonalist 0.1.0",
        url: "https://api.github.com/repos/Yona-projects/Home/releases/1001",
        type: "Release"
      },
      repository: {
        full_name: "Yona-projects/Home",
        name: "Home",
        owner: { login: "Yona-projects" }
      }
    }
  ];
}

/** Demo detail content mirroring what the GitHub API would return. */
export function sampleNotificationDetail(
  notification: GitHubNotification
): NotificationDetailContent {
  const number = subjectNumber(notification.subject);
  const match = sampleItems.find(
    (item) =>
      `${item.frontMatter.owner}/${item.frontMatter.repo}` ===
        notification.repository.full_name && item.frontMatter.number === number
  );

  if (match) {
    return {
      title: match.frontMatter.title,
      state: match.frontMatter.state,
      author: match.frontMatter.author,
      authorAssociation: "OWNER",
      created_at: match.frontMatter.created_at,
      body: match.body,
      labels: match.frontMatter.labels.map((name) => ({ name, color: "" })),
      comments: [
        {
          id: "sample-comment-1",
          author: "mona",
          authorAssociation: "MEMBER",
          created_at: match.frontMatter.updated_at,
          body: "Sample reply so the conversation thread layout is visible offline."
        }
      ]
    };
  }

  return {
    title: notification.subject.title,
    state: "open",
    author: notification.repository.owner.login,
    created_at: notification.updated_at,
    body:
      "This is sample content.\n\nSign in from Settings to load the real conversation from GitHub.",
    labels: [],
    comments: []
  };
}
