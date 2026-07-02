import { useEffect, useState } from "react";
import type { GithubConnection } from "./useGithubAuth";
import type { GitHubNotification } from "../domain/notifications";
import { sampleNotificationDetail } from "../fixtures/sampleNotifications";
import {
  fetchNotificationDetail,
  type NotificationDetailContent
} from "../services/notificationDetail";

export interface UseNotificationDetailResult {
  detail: NotificationDetailContent | null;
  loading: boolean;
  error: string | null;
}

/** Loads the conversation for the selected notification through the GitHub API. */
export function useNotificationDetail(
  notification: GitHubNotification | null,
  connection: GithubConnection,
  online: boolean
): UseNotificationDetailResult {
  const [detail, setDetail] = useState<NotificationDetailContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = connection.token.trim();

  useEffect(() => {
    if (!notification) {
      setDetail(null);
      setError(null);
      return;
    }

    if (!token) {
      setDetail(sampleNotificationDetail(notification));
      setError(null);
      return;
    }

    if (!online) {
      setError("Offline — the conversation loads when you reconnect.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNotificationDetail({
      token,
      apiBaseUrl: connection.apiBaseUrl,
      webBaseUrl: connection.webBaseUrl,
      notification
    })
      .then((content) => {
        if (!cancelled) {
          setDetail(content);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setDetail(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    notification,
    token,
    online,
    connection.apiBaseUrl,
    connection.webBaseUrl
  ]);

  return { detail, loading, error };
}
