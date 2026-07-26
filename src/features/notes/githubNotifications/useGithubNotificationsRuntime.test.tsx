import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalBulletKey } from "../../../domain/externalSources";
import type { GitHubNotification } from "../../../domain/notifications";
import type { GithubConnection } from "../../../hooks/useGithubAuth";
import type { ExternalSourceHandle } from "../../../services/externalSourceHost";
import { githubSourceConnectionId } from "../../../services/githubAccountIdentity";
import { loadGithubNotificationViewedAt } from "./githubNotificationViewedStore";
import { useGithubNotificationsRuntime } from "./useGithubNotificationsRuntime";

const mocks = vi.hoisted(() => ({
  createExternalSourceHost: vi.fn(),
  createGithubNotificationsProvider: vi.fn(),
  openExternal: vi.fn(),
  useDesktopNotifications: vi.fn(),
}));

vi.mock("../../../hooks/useDesktopNotifications", () => ({
  useDesktopNotifications: mocks.useDesktopNotifications,
}));

vi.mock("../../../services/browser", () => ({
  openExternal: mocks.openExternal,
}));

vi.mock("../../../services/externalSourceHost", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/externalSourceHost")
  >()),
  createExternalSourceHost: mocks.createExternalSourceHost,
}));

vi.mock(
  "../../../services/githubNotificationsProvider",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/githubNotificationsProvider")
    >()),
    createGithubNotificationsProvider: mocks.createGithubNotificationsProvider,
  }),
);

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test",
};
const account = { id: "7", login: "octocat" };
const notification: GitHubNotification = {
  id: "thread-7",
  unread: true,
  reason: "mention",
  updated_at: "2026-07-27T01:00:00Z",
  last_read_at: null,
  subject: {
    title: "Fix sync",
    url: "https://api.github.com/repos/acme/app/issues/7",
    type: "Issue",
  },
  repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } },
};
const externalKey: ExternalBulletKey = {
  providerId: "github",
  connectionId: githubSourceConnectionId(connection.apiBaseUrl, account.id),
  remoteId: notification.id,
};
const notificationUrl = "https://github.com/acme/app/issues/7";

let sourceHandle: ExternalSourceHandle<GitHubNotification>;

function renderRuntime(
  overrides: Partial<Parameters<typeof useGithubNotificationsRuntime>[0]> = {},
) {
  return renderHook(() =>
    useGithubNotificationsRuntime({
      connection,
      authState: "passed",
      account,
      online: true,
      pluginEnabled: true,
      desktopNotificationsEnabled: false,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  const sourceState = {
    items: [notification],
    loaded: true,
    isComplete: true,
    loading: false,
    error: null,
    syncedAt: "2026-07-27T01:00:00.000Z",
    completionVersion: 0,
    completingKeys: new Set<string>(),
    completionErrors: {},
  };
  sourceHandle = {
    getState: () => sourceState,
    subscribe: () => () => undefined,
    acquire: vi.fn(() => () => undefined),
    refresh: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  mocks.createExternalSourceHost.mockReturnValue(sourceHandle);
  mocks.createGithubNotificationsProvider.mockReturnValue({
    normalizeSettings: vi.fn((value) => value),
    project: vi.fn(() => []),
  });
});

afterEach(() => vi.clearAllMocks());

describe("useGithubNotificationsRuntime", () => {
  it("does not acquire or expose GN when the plugin is disabled", () => {
    const { result } = renderRuntime({ pluginEnabled: false });
    expect(result.current.externalSources.pages).toEqual([]);
    expect(sourceHandle.acquire).not.toHaveBeenCalled();
    expect(mocks.useDesktopNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("acquires the source only while the authenticated online Notes lease is requested", () => {
    const { result } = renderRuntime();
    expect(sourceHandle.acquire).not.toHaveBeenCalled();
    act(() => result.current.externalSources.requestGithubProjection?.(true));
    expect(sourceHandle.acquire).toHaveBeenCalledOnce();
  });

  it("enables desktop notifications without an Inbox or active-feature input", () => {
    renderRuntime({ desktopNotificationsEnabled: true });
    expect(mocks.useDesktopNotifications).toHaveBeenCalledWith({
      connection,
      viewedAt: expect.any(Object),
      online: true,
      enabled: true,
      demoMode: false,
    });
  });

  it("submits a completed source snapshot to the registered Notes materializer", async () => {
    const { result } = renderRuntime();
    const materialize = vi.fn().mockResolvedValue("committed");
    act(() =>
      result.current.externalSources.registerGithubMaterializedRefresh?.(
        materialize,
      ),
    );
    act(() => result.current.externalSources.requestGithubProjection?.(true));
    await waitFor(() =>
      expect(materialize).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: expect.any(String),
          webBaseUrl: "https://github.com",
          items: [notification],
        }),
      ),
    );
  });

  it("opens only a safe GitHub URL and records it as viewed", () => {
    const { result } = renderRuntime();
    act(() =>
      result.current.externalSources.openDetails(externalKey, notificationUrl),
    );
    expect(mocks.openExternal).toHaveBeenCalledWith(notificationUrl);
    expect(loadGithubNotificationViewedAt()).toHaveProperty(notificationUrl);

    act(() =>
      result.current.externalSources.openDetails(
        { ...externalKey, remoteId: "missing" },
        "javascript:alert(1)",
      ),
    );
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
  });

  it("keeps the source host when recording a viewed notification", () => {
    const { result } = renderRuntime();
    expect(mocks.createExternalSourceHost).toHaveBeenCalledOnce();

    act(() =>
      result.current.externalSources.openDetails(externalKey, notificationUrl),
    );

    expect(mocks.createExternalSourceHost).toHaveBeenCalledOnce();
    expect(sourceHandle.dispose).not.toHaveBeenCalled();
  });

  it("keeps the source host for an equivalent connection snapshot", () => {
    const { rerender } = renderHook(
      ({ runtimeConnection }: { runtimeConnection: GithubConnection }) =>
        useGithubNotificationsRuntime({
          connection: runtimeConnection,
          authState: "passed",
          account,
          online: true,
          pluginEnabled: true,
          desktopNotificationsEnabled: false,
        }),
      { initialProps: { runtimeConnection: connection } },
    );
    expect(mocks.createExternalSourceHost).toHaveBeenCalledOnce();

    rerender({ runtimeConnection: { ...connection } });

    expect(mocks.createExternalSourceHost).toHaveBeenCalledOnce();
    expect(sourceHandle.dispose).not.toHaveBeenCalled();
  });
});
