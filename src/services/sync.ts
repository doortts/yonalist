import type { ItemDocument, OutboxOperationDocument } from "../domain/types";
import type { GitHubClient } from "./github";
import { GitHubRequestError } from "./githubTransport";

export interface OutboxSyncResult {
  operation: OutboxOperationDocument;
  ok: boolean;
  remote?: SyncedRemote;
  error?: string;
  /**
   * True when retrying cannot possibly succeed (target deleted, validation
   * rejected, locked) — the operation should be blocked, not re-queued.
   */
  permanent?: boolean;
}

export interface SyncOptions {
  /** Backoff between retry attempts for transient failures. */
  retryDelays?: number[];
}

const DEFAULT_RETRY_DELAYS = [500, 1500];

/**
 * A failure is permanent when the server definitively rejected the operation:
 * the target is gone (404/410), the payload is invalid (422), or access is
 * denied (403, except rate limiting which clears on its own).
 */
export function isPermanentSyncError(error: unknown): boolean {
  if (!(error instanceof GitHubRequestError)) {
    return false;
  }
  if (error.status === 404 || error.status === 410 || error.status === 422) {
    return true;
  }
  if (error.status === 403) {
    return !/rate limit/i.test(error.detail);
  }
  return false;
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one operation attempt, retrying transient failures with backoff. */
async function attemptWithRetry<T>(
  run: () => Promise<T>,
  retryDelays: number[]
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) {
      await wait(retryDelays[attempt - 1]);
    }
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (isPermanentSyncError(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

export type SyncedRemote =
  | {
      type: "issue";
      number: number;
      node_id?: string;
      html_url?: string;
      created_at?: string;
      updated_at?: string;
    }
  | {
      type: "comment";
      id: number | string;
      node_id?: string;
      html_url?: string;
      body?: string;
      created_at?: string;
      updated_at?: string;
      closedIssue?: boolean;
    };

interface CreatedIssueResponse {
  number?: number;
  node_id?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface CreatedCommentResponse {
  id?: number | string;
  node_id?: string;
  html_url?: string;
  body?: string;
  created_at?: string;
  updated_at?: string;
}

function findDraftItem(
  operation: OutboxOperationDocument,
  items: ItemDocument[]
): ItemDocument | undefined {
  return items.find((item) => item.path === operation.frontMatter.local_file_path);
}

/**
 * Pushes queued outbox operations to GitHub. Each operation is attempted
 * independently so one failure does not block the rest of the queue.
 */
export async function syncOutboxOperations(
  client: GitHubClient,
  operations: OutboxOperationDocument[],
  items: ItemDocument[],
  options: SyncOptions = {}
): Promise<OutboxSyncResult[]> {
  const results: OutboxSyncResult[] = [];
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;

  for (const operation of operations) {
    const { target } = operation.frontMatter;
    try {
      if (operation.frontMatter.operation === "create_issue") {
        const draft = findDraftItem(operation, items);
        if (!draft) {
          throw new Error("Draft issue file is missing from the vault.");
        }
        const created = (await attemptWithRetry(
          () =>
            client.createIssue(target.owner, target.repo, {
              title: draft.frontMatter.title,
              body: draft.body
            }),
          retryDelays
        )) as CreatedIssueResponse;
        if (typeof created.number !== "number") {
          throw new Error("GitHub did not return the created issue number.");
        }
        results.push({
          operation,
          ok: true,
          remote: {
            type: "issue",
            number: created.number,
            node_id: created.node_id,
            html_url: created.html_url,
            created_at: created.created_at,
            updated_at: created.updated_at
          }
        });
      } else {
        if (target.number === undefined) {
          throw new Error("Comment operation is missing a target number.");
        }
        const created = (await attemptWithRetry(
          () =>
            target.kind === "discussion"
              ? client.createDiscussionComment(
                  target.owner,
                  target.repo,
                  target.number as number,
                  operation.body
                )
              : client.createIssueComment(
                  target.owner,
                  target.repo,
                  target.number as number,
                  operation.body
                ),
          retryDelays
        )) as CreatedCommentResponse;
        if (created.id === undefined) {
          throw new Error("GitHub did not return the created comment id.");
        }
        if (
          operation.frontMatter.close_after_comment &&
          target.kind === "issue"
        ) {
          await attemptWithRetry(
            () =>
              client.closeIssue(
                target.owner,
                target.repo,
                target.number as number
              ),
            retryDelays
          );
        }
        results.push({
          operation,
          ok: true,
          remote: {
            type: "comment",
            id: created.id,
            node_id: created.node_id,
            html_url: created.html_url,
            body: created.body,
            created_at: created.created_at,
            updated_at: created.updated_at,
            ...(operation.frontMatter.close_after_comment && target.kind === "issue"
              ? { closedIssue: true }
              : {})
          }
        });
      }
    } catch (error) {
      results.push({
        operation,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        permanent: isPermanentSyncError(error)
      });
    }
  }

  return results;
}
