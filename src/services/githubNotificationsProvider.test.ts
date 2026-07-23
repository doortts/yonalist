import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  serializeExternalBulletKey,
  type ExternalBulletKey
} from "../domain/externalSources";
import type { GitHubNotification } from "../domain/notifications";
import { githubSourceConnectionId } from "./githubAccountIdentity";
import {
  GITHUB_EXTERNAL_KEY_PROVIDER,
  GITHUB_NOTIFICATIONS_PROVIDER_ID,
  GITHUB_NOTIFICATIONS_ROOT_ID,
  createGithubNotificationsProvider,
  projectGithubNotifications
} from "./githubNotificationsProvider";
import {
  clearNotificationCache,
  getNotificationCacheStats
} from "./notifications";
import { loadExternalSourceSnapshot } from "./externalSourceSnapshotStore";

const connection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "token"
};
const account = { id: "account-7", login: "octocat" };
const connectionId = githubSourceConnectionId(connection.apiBaseUrl, account.id);
const now = new Date("2026-07-22T12:00:00.000Z");

function notification(
  id: string,
  overrides: Partial<GitHubNotification> = {}
): GitHubNotification {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: "2026-07-22T10:00:00.000Z",
    last_read_at: null,
    subject: {
      title: "Fix inline caret",
      url: "https://api.github.com/repos/acme/yonalist/issues/17",
      type: "Issue"
    },
    repository: {
      full_name: "acme/yonalist",
      name: "yonalist",
      owner: { login: "acme" }
    },
    ...overrides
  };
}

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function provider(openDetails?: (remoteId: string) => void) {
  return createGithubNotificationsProvider({
    connection,
    account,
    now: () => now,
    openDetails
  });
}

const malformedCacheEquivalentRows: Array<
  [string, (item: GitHubNotification) => unknown]
> = [
  ["reason", (item) => ({ ...item, reason: 17 })],
  ["subject.url", (item) => ({
    ...item,
    subject: { ...item.subject, url: 17 }
  })],
  ["repository.name", (item) => ({
    ...item,
    repository: { ...item.repository, name: 17 }
  })],
  ["repository.owner.login", (item) => ({
    ...item,
    repository: {
      ...item.repository,
      owner: { ...item.repository.owner, login: 17 }
    }
  })]
];

describe("GitHub notifications provider", () => {
  it("freezes the Notes plugin root ID", () => {
    expect(GITHUB_NOTIFICATIONS_ROOT_ID).toBe(
      "6983f947-c134-44fc-bf46-db19f68125bf"
    );
  });

  it("keeps the source ID separate from canonical persisted external keys", () => {
    const item = notification("thread-17");
    const source = provider();
    const key = source.keyOf(item, connectionId);
    const projected = projectGithubNotifications(
      [item],
      connectionId,
      30,
      now
    );

    expect(source.id).toBe(GITHUB_NOTIFICATIONS_PROVIDER_ID);
    expect(GITHUB_EXTERNAL_KEY_PROVIDER).toBe("github");
    expect(key.providerId).toBe(GITHUB_EXTERNAL_KEY_PROVIDER);
    expect(
      projected.every(
        (bullet) =>
          bullet.key.providerId === GITHUB_EXTERNAL_KEY_PROVIDER &&
          (bullet.parentKey === null ||
            bullet.parentKey.providerId === GITHUB_EXTERNAL_KEY_PROVIDER)
      )
    ).toBe(true);
    expect(serializeExternalBulletKey(key)).toBe(
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","thread-17"]'
    );
  });

  it("rejects the source namespace where an external key is required", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const item = notification("thread-17");
    const source = provider();
    const key = {
      ...source.keyOf(item, connectionId),
      providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID
    };

    await expect(
      source.markComplete!({
        key,
        item,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("Invalid GitHub notification key.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    window.localStorage.clear();
    clearNotificationCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects date parents and typed children", () => {
    const projected = projectGithubNotifications(
      [
        notification("today-pr", {
          updated_at: "2026-07-22T10:00:00",
          last_read_at: "2026-07-22T06:00:00",
          subject: {
            title: "Review the patch",
            url: "https://api.github.com/repos/acme/yonalist/pulls/21",
            type: "PullRequest"
          }
        }),
        notification("yesterday", {
          updated_at: "2026-07-21T10:00:00"
        })
      ],
      connectionId,
      30,
      new Date("2026-07-22T12:00:00"),
      connection.webBaseUrl,
      {
        "https://github.com/acme/yonalist/pull/21":
          "2026-07-22T06:00:00"
      }
    );

    expect(projected.map((bullet) => bullet.title)).toEqual([
      "Today",
      "Review the patch #21",
      "Yesterday",
      "Fix inline caret #17"
    ]);
    expect(projected[0]).toMatchObject({
      key: { remoteId: "date:2026.07.22" },
      parentKey: null,
      note: "",
      capabilities: {
        expand: false,
        openDetails: false,
        complete: false
      }
    });
    expect(projected[1]).toMatchObject({
      parentKey: projected[0].key,
      icon: "pull-request",
      note: "yonalist, 2h ago, seen 6h ago",
      capabilities: {
        expand: false,
        openDetails: true,
        complete: true
      }
    });
  });

  it.each([
    ["Issue", "issue"],
    ["PullRequest", "pull-request"],
    ["Discussion", "discussion"],
    ["Release", "release"],
    ["CheckSuite", "notification"]
  ])("maps %s subjects to the %s icon", (type, icon) => {
    const projected = projectGithubNotifications(
      [notification(type, { subject: { ...notification(type).subject, type } })],
      connectionId,
      30,
      now
    );

    expect(projected.find((bullet) => bullet.parentKey !== null)).toMatchObject({
      icon
    });
  });

  it("rebuilds membership and removes an empty group after refresh", () => {
    const before = notification("moving", {
      updated_at: "2026-07-21T10:00:00"
    });
    const after = {
      ...before,
      updated_at: "2026-07-22T11:00:00"
    };
    const first = projectGithubNotifications(
      [before],
      connectionId,
      30,
      new Date("2026-07-22T12:00:00"),
      connection.webBaseUrl
    );
    const second = projectGithubNotifications(
      [after],
      connectionId,
      30,
      new Date("2026-07-22T12:00:00"),
      connection.webBaseUrl
    );

    expect(first.map((bullet) => bullet.title)).toEqual([
      "Yesterday",
      "Fix inline caret #17"
    ]);
    expect(second.map((bullet) => bullet.title)).toEqual([
      "Today",
      "Fix inline caret #17"
    ]);
    expect(second[1].parentKey).toEqual(second[0].key);
    expect(
      second.some((bullet) => bullet.key.remoteId === "date:2026.07.21")
    ).toBe(false);
  });

  it("relabels parents at the next local-date projection", () => {
    const item = notification("boundary", {
      updated_at: "2026-07-22T10:00:00"
    });
    const today = projectGithubNotifications(
      [item],
      connectionId,
      30,
      new Date("2026-07-22T23:59:00"),
      connection.webBaseUrl
    );
    const tomorrow = projectGithubNotifications(
      [item],
      connectionId,
      30,
      new Date("2026-07-23T00:01:00"),
      connection.webBaseUrl
    );

    expect(today[0].title).toBe("Today");
    expect(tomorrow[0].title).toBe("Yesterday");
    expect(tomorrow[1].parentKey).toEqual(tomorrow[0].key);
  });

  it("normalizes settings and keeps only valid viewed-at dates", () => {
    const source = provider();

    expect(source.title).toBe("Github Notifications");
    expect(
      source.normalizeSettings({
        readRetentionDays: 12.7,
        viewedAt: {
          valid: "2026-07-22T06:00:00",
          invalid: "not-a-date",
          numeric: 17
        }
      })
    ).toEqual({
      readRetentionDays: 13,
      viewedAt: { valid: "2026-07-22T06:00:00" }
    });
    expect(source.normalizeSettings({ readRetentionDays: 30 })).toEqual({
      readRetentionDays: 30,
      viewedAt: {}
    });
  });

  it("projects GitHub unread state onto children", () => {
    const bullets = projectGithubNotifications(
      [notification("unread"), notification("read", { unread: false })],
      connectionId,
      30,
      now
    ).filter((bullet) => bullet.parentKey !== null);

    expect(bullets[0]).toMatchObject({
      key: {
        providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
        connectionId,
        remoteId: "unread"
      },
      parentKey: expect.any(Object),
      title: "Fix inline caret #17",
      completed: false,
      capabilities: { expand: false, uncomplete: false }
    });
    expect(bullets[1].completed).toBe(true);
  });

  it("keeps old unread rows and removes only old read rows", () => {
    const oldUnread = notification("old-unread", {
      updated_at: "2026-06-01T00:00:00.000Z"
    });
    const oldRead = notification("old-read", {
      unread: false,
      updated_at: "2026-06-01T00:00:00.000Z"
    });
    const boundaryRead = notification("boundary-read", {
      unread: false,
      updated_at: "2026-06-22T12:00:00.000Z"
    });

    const bullets = projectGithubNotifications(
      [oldUnread, oldRead, boundaryRead],
      connectionId,
      30,
      now
    );

    const ids = bullets
      .filter((bullet) => bullet.parentKey !== null)
      .map((bullet) => bullet.key.remoteId);
    expect(ids).toEqual([
      boundaryRead.id,
      oldUnread.id
    ]);
  });

  it("deduplicates paginated thread races using the newest snapshot", async () => {
    const older = notification("thread-17", {
      updated_at: "2026-07-22T09:00:00.000Z"
    });
    const newer = notification("thread-17", {
      unread: false,
      updated_at: "2026-07-22T11:00:00.000Z"
    });
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse([older], {
          Link: '<https://api.github.com/notifications?page=2>; rel="next"'
        })
      )
      .mockResolvedValueOnce(jsonResponse([newer]));
    vi.stubGlobal("fetch", fetchMock);
    const partials: (readonly GitHubNotification[])[] = [];
    const controller = new AbortController();

    const items = await provider().load({
      signal: controller.signal,
      publishPartial: (partial) => partials.push(partial)
    });

    expect(items).toEqual([newer]);
    expect(partials).toEqual([[older], [newer]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal === controller.signal))
      .toBe(true);
  });

  it("removes IDs missing from the next complete raw snapshot", async () => {
    const removed = notification("removed");
    const kept = notification("kept", {
      updated_at: "2026-07-22T11:00:00.000Z"
    });
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([removed, kept]))
      .mockResolvedValueOnce(jsonResponse([kept]));
    vi.stubGlobal("fetch", fetchMock);
    const source = provider();
    const input = {
      signal: new AbortController().signal,
      publishPartial: () => {}
    };

    await source.load(input);
    const next = await source.load(input);
    const bullets = source.project({
      items: next,
      connectionId,
      settings: source.normalizeSettings({ readRetentionDays: 30 }),
      now
    });

    expect(
      bullets
        .filter((bullet) => bullet.parentKey !== null)
        .map((bullet) => bullet.key.remoteId)
    ).toEqual(["kept"]);
  });

  it("reuses equal item and array references across unchanged polls", async () => {
    const unchanged = notification("stable");
    const fetchMock = vi
      .fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >()
      .mockResolvedValueOnce(jsonResponse([unchanged]))
      .mockResolvedValueOnce(jsonResponse([unchanged]));
    vi.stubGlobal("fetch", fetchMock);
    const source = provider();
    const partials: (readonly GitHubNotification[])[] = [];
    const input = {
      signal: new AbortController().signal,
      publishPartial: (items: readonly GitHubNotification[]) => {
        partials.push(items);
      }
    };

    const firstPoll = await source.load(input);
    partials.length = 0;
    const secondPoll = await source.load(input);

    expect(secondPoll).toBe(firstPoll);
    expect(secondPoll[0]).toBe(firstPoll[0]);
    expect(partials.length).toBeGreaterThan(0);
    expect(partials.every((items) => items === firstPoll)).toBe(true);
  });

  it("strictly decodes network and stored notification snapshots", async () => {
    const source = provider();
    const valid = notification("valid");
    expect(source.decodeItem(valid)).toEqual(valid);
    expect(source.decodeItem({ ...valid, updated_at: "not-a-date" })).toBeNull();
    expect(source.decodeItem({ ...valid, subject: { title: "broken" } })).toBeNull();
    expect(source.decodeItem({ ...valid, repository: { name: "broken" } })).toBeNull();

    window.localStorage.setItem(
      "yonalist.externalSources.snapshots.v1",
      JSON.stringify({
        [JSON.stringify([GITHUB_NOTIFICATIONS_PROVIDER_ID, connectionId])]: {
          version: 1,
          syncedAt: now.toISOString(),
          items: [valid, { ...valid, subject: null }]
        }
      })
    );
    expect(
      loadExternalSourceSnapshot(
        GITHUB_NOTIFICATIONS_PROVIDER_ID,
        connectionId,
        source.decodeItem
      )
    ).toBeNull();

    const recovered = notification("recovered", {
      updated_at: "2026-07-22T11:00:00.000Z"
    });
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([valid]))
      .mockResolvedValueOnce(jsonResponse([valid, { ...valid, last_read_at: "bad" }]))
      .mockResolvedValueOnce(jsonResponse([recovered]));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      signal: new AbortController().signal,
      publishPartial: () => {}
    };

    await expect(source.load(input)).resolves.toEqual([valid]);
    await expect(source.load(input)).rejects.toThrow();
    expect(getNotificationCacheStats().entries).toBe(1);
    await expect(source.load(input)).resolves.toEqual([recovered]);
  });

  it.each(malformedCacheEquivalentRows)(
    "rejects cache-equivalent network rows with malformed %s without poisoning the prior cache",
    async (_field, corrupt) => {
      const source = provider();
      const valid = notification("cached");
      const recovered = notification("cached", {
        updated_at: "2026-07-22T11:00:00.000Z"
      });
      const fetchMock = vi
        .fn<
          (input: string | URL | Request, init?: RequestInit) => Promise<Response>
        >()
        .mockResolvedValueOnce(jsonResponse([valid]))
        .mockResolvedValueOnce(jsonResponse([corrupt(valid)]))
        .mockResolvedValueOnce(jsonResponse([recovered]));
      vi.stubGlobal("fetch", fetchMock);
      const input = {
        signal: new AbortController().signal,
        publishPartial: () => {}
      };

      await expect(source.load(input)).resolves.toEqual([valid]);
      const cacheStats = getNotificationCacheStats();
      await expect(source.load(input)).rejects.toThrow();
      expect(getNotificationCacheStats()).toBe(cacheStats);
      await expect(source.load(input)).resolves.toEqual([recovered]);
    }
  );

  it("PATCHes once before returning the completed snapshot", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 205 }));
    vi.stubGlobal("fetch", fetchMock);
    const opened = vi.fn();
    const source = provider(opened);
    const item = notification("thread-17");
    const key = source.keyOf(item, connectionId);
    const controller = new AbortController();

    const completed = await source.markComplete!({
      key,
      item,
      signal: controller.signal
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/notifications/threads/thread-17",
      expect.objectContaining({ method: "PATCH", signal: controller.signal })
    );
    expect(completed).toMatchObject({
      id: "thread-17",
      unread: false,
      last_read_at: now.toISOString()
    });
    expect(item.unread).toBe(true);
    expect(source.canComplete(item)).toBe(true);
    expect(source.canComplete(completed)).toBe(false);

    source.openDetails?.(key);
    source.openDetails?.({ ...key, connectionId: "other" } as ExternalBulletKey);
    expect(opened).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledWith("thread-17");
  });
});
