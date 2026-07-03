import type { ItemDocument, OutboxOperationDocument } from "../domain/types";
import type { GitHubClient } from "./github";

export interface OutboxSyncResult {
  operation: OutboxOperationDocument;
  ok: boolean;
  remote?: SyncedRemote;
  error?: string;
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
  items: ItemDocument[]
): Promise<OutboxSyncResult[]> {
  const results: OutboxSyncResult[] = [];

  for (const operation of operations) {
    const { target } = operation.frontMatter;
    try {
      if (operation.frontMatter.operation === "create_issue") {
        const draft = findDraftItem(operation, items);
        if (!draft) {
          throw new Error("Draft issue file is missing from the vault.");
        }
        const created = (await client.createIssue(target.owner, target.repo, {
          title: draft.frontMatter.title,
          body: draft.body
        })) as CreatedIssueResponse;
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
        const created = (await client.createIssueComment(
          target.owner,
          target.repo,
          target.number,
          operation.body
        )) as CreatedCommentResponse;
        if (created.id === undefined) {
          throw new Error("GitHub did not return the created comment id.");
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
            updated_at: created.updated_at
          }
        });
      }
    } catch (error) {
      results.push({
        operation,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}
