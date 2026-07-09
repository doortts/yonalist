import { useEffect } from "react";
import type { GitHubNotification } from "../domain/notifications";
import {
  revalidateItemThread,
  type ItemThreadTarget
} from "../services/itemThread";
import { revalidateNotificationDetail } from "../services/notificationDetail";
import type { GithubConnection } from "./useGithubAuth";

const DEFAULT_DETAIL_REVALIDATION_DELAY_MS = 2_000;

export type DetailRevalidationTarget =
  | {
      kind: "item";
      key: string;
      connection: GithubConnection;
      item: ItemThreadTarget;
    }
  | {
      kind: "notification";
      key: string;
      token: string;
      apiBaseUrl: string;
      webBaseUrl: string;
      notification: GitHubNotification;
    };

export interface UseDetailRevalidationOptions {
  target: DetailRevalidationTarget | null;
  enabled: boolean;
  delayMs?: number;
  onChanged: () => void;
  onError?: (message: string) => void;
}

export function useDetailRevalidation({
  target,
  enabled,
  delayMs = DEFAULT_DETAIL_REVALIDATION_DELAY_MS,
  onChanged,
  onError
}: UseDetailRevalidationOptions): void {
  useEffect(() => {
    if (!enabled || !target) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const request =
        target.kind === "item"
          ? revalidateItemThread(target.connection, target.item)
          : revalidateNotificationDetail({
              token: target.token,
              apiBaseUrl: target.apiBaseUrl,
              webBaseUrl: target.webBaseUrl,
              notification: target.notification
            });
      void request
        .then((result) => {
          if (!cancelled && result.changed) {
            onChanged();
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            onError?.(cause instanceof Error ? cause.message : String(cause));
          }
        });
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delayMs, enabled, onChanged, onError, target]);
}
