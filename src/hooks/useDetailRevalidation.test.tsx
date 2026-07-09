import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import type { ItemThreadTarget } from "../services/itemThread";
import { revalidateItemThread } from "../services/itemThread";
import { revalidateNotificationDetail } from "../services/notificationDetail";
import { useDetailRevalidation } from "./useDetailRevalidation";

vi.mock("../services/itemThread", () => ({
  revalidateItemThread: vi.fn()
}));

vi.mock("../services/notificationDetail", () => ({
  revalidateNotificationDetail: vi.fn()
}));

const connection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

const itemTarget: ItemThreadTarget = {
  kind: "issue",
  owner: "acme",
  repo: "app",
  number: 42
};

const notification: GitHubNotification = {
  id: "n1",
  unread: true,
  reason: "mention",
  updated_at: "2026-07-09T00:00:00Z",
  last_read_at: null,
  subject: {
    title: "Notification",
    type: "Issue",
    url: "https://api.github.com/repos/acme/app/issues/42"
  },
  repository: {
    full_name: "acme/app",
    name: "app",
    owner: { login: "acme" }
  }
};

function Harness({
  target,
  enabled = true,
  onChanged = vi.fn()
}: {
  target: Parameters<typeof useDetailRevalidation>[0]["target"];
  enabled?: boolean;
  onChanged?: () => void;
}) {
  useDetailRevalidation({
    target,
    enabled,
    onChanged
  });
  return null;
}

describe("useDetailRevalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(revalidateItemThread).mockResolvedValue({ changed: false });
    vi.mocked(revalidateNotificationDetail).mockResolvedValue({ changed: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("waits two seconds after an item detail is shown before revalidating", async () => {
    render(
      <Harness
        target={{
          kind: "item",
          key: "item:/vault/issue.md",
          connection,
          item: itemTarget
        }}
      />
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(revalidateItemThread).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(revalidateItemThread).toHaveBeenCalledWith(connection, itemTarget);
  });

  it("calls onChanged only when the delayed revalidation detects changes", async () => {
    const onChanged = vi.fn();
    vi.mocked(revalidateItemThread).mockResolvedValue({ changed: true });

    render(
      <Harness
        target={{
          kind: "item",
          key: "item:/vault/issue.md",
          connection,
          item: itemTarget
        }}
        onChanged={onChanged}
      />
    );

    await vi.advanceTimersByTimeAsync(2_000);

    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("does not start another delayed probe for the same detail key after refresh toggles loading", async () => {
    const onChanged = vi.fn();
    const target: Parameters<typeof useDetailRevalidation>[0]["target"] = {
      kind: "item",
      key: "item:/vault/issue.md",
      connection,
      item: itemTarget
    };
    vi.mocked(revalidateItemThread).mockResolvedValue({ changed: true });

    const { rerender } = render(
      <Harness target={target} enabled onChanged={onChanged} />
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(revalidateItemThread).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);

    rerender(<Harness target={target} enabled={false} onChanged={onChanged} />);
    rerender(<Harness target={target} enabled onChanged={onChanged} />);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(revalidateItemThread).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("cancels the previous delayed probe when the detail target changes", async () => {
    const { rerender } = render(
      <Harness
        target={{
          kind: "item",
          key: "item:/vault/issue-42.md",
          connection,
          item: itemTarget
        }}
      />
    );

    await vi.advanceTimersByTimeAsync(1_000);
    rerender(
      <Harness
        target={{
          kind: "item",
          key: "item:/vault/issue-43.md",
          connection,
          item: { ...itemTarget, number: 43 }
        }}
      />
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(revalidateItemThread).toHaveBeenCalledTimes(1);
    expect(revalidateItemThread).toHaveBeenCalledWith(connection, {
      ...itemTarget,
      number: 43
    });
  });

  it("revalidates notification details with the same two-second delay", async () => {
    render(
      <Harness
        target={{
          kind: "notification",
          key: "notification:n1",
          token: connection.token,
          apiBaseUrl: connection.apiBaseUrl,
          webBaseUrl: connection.webBaseUrl,
          notification
        }}
      />
    );

    await vi.advanceTimersByTimeAsync(2_000);

    expect(revalidateNotificationDetail).toHaveBeenCalledWith({
      token: connection.token,
      apiBaseUrl: connection.apiBaseUrl,
      webBaseUrl: connection.webBaseUrl,
      notification
    });
  });
});
