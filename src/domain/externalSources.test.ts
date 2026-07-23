import { expect, it } from "vitest";
import {
  isGithubNotificationsPluginMeta,
  isGithubNotificationsPluginState,
  serializeExternalBulletKey
} from "./externalSources";

it("serializes every key dimension without collisions", () => {
  const left = serializeExternalBulletKey({
    providerId: "github-notifications",
    connectionId: "server-a/account-1",
    remoteId: "23"
  });
  const right = serializeExternalBulletKey({
    providerId: "github-notifications",
    connectionId: "server-a/account-2",
    remoteId: "23"
  });
  expect(left).not.toBe(right);
  expect(JSON.parse(left)).toEqual([
    "github-notifications",
    "server-a/account-1",
    "23"
  ]);
});

it("accepts only exact GitHub notification plugin wire shapes", () => {
  expect(
    isGithubNotificationsPluginState({
      collapsedGroups: ["2026.07.21"]
    })
  ).toBe(true);
  expect(
    isGithubNotificationsPluginState({
      collapsedGroups: ["2026.07.21"],
      extra: true
    })
  ).toBe(false);
  expect(
    isGithubNotificationsPluginState({
      collapsedGroups: ["2026.07.21", "2026.07.21"]
    })
  ).toBe(false);
  expect(
    isGithubNotificationsPluginState({
      collapsedGroups: Array(1)
    })
  ).toBe(false);
  expect(
    isGithubNotificationsPluginMeta({
      kind: "date",
      dateKey: "2026.07.21"
    })
  ).toBe(true);
  expect(
    isGithubNotificationsPluginMeta({
      kind: "notification",
      notificationKey:
        '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
      notificationType: "Issue",
      url: "https://github.com/example/repo/issues/42",
      updatedAt: "2026-07-21T00:00:00Z",
      unread: true
    })
  ).toBe(true);
});

it.each([
  { kind: "unknown" },
  { kind: "date", dateKey: "2026.02.30" },
  { kind: "date", dateKey: "0000.01.01" },
  {
    kind: "notification",
    notificationKey: "not-json",
    notificationType: "Issue",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey: '["github","https://api.github.com/1","42"]',
    notificationType: "Issue",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["gitlab","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
    notificationType: "Issue",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["github","[\\"https://api.github.com/\\",\\"account-7\\"]","42"]',
    notificationType: "Issue",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["github","[\\"https://api.github.com\\",\\"\\"]","42"]',
    notificationType: "Issue",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
    notificationType: "Issue Type",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
    notificationType: "",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
    notificationType: "Issue",
    url: "https:///issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
    notificationType: "Issue",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-02-30T00:00:00Z",
    unread: true
  },
  {
    kind: "notification",
    notificationKey:
      '["github","[\\"https://api.github.com\\",\\"account-7\\"]","42"]',
    notificationType: "Issue",
    url: "https://github.com/example/repo/issues/42",
    updatedAt: "2026-07-21T00:00:00Z",
    unread: true,
    extra: true
  }
])("rejects malformed plugin metadata %#", (value) => {
  expect(isGithubNotificationsPluginMeta(value)).toBe(false);
});
