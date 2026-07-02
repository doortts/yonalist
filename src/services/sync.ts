import type { ItemDocument, OutboxOperationDocument } from "../domain/types";
import type { GitHubClient } from "./github";

export interface OutboxSyncResult {
  operation: OutboxOperationDocument;
  ok: boolean;
  error?: string;
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
        await client.createIssue(target.owner, target.repo, {
          title: draft.frontMatter.title,
          body: draft.body
        });
      } else {
        if (target.number === undefined) {
          throw new Error("Comment operation is missing a target number.");
        }
        await client.createIssueComment(
          target.owner,
          target.repo,
          target.number,
          operation.body
        );
      }
      results.push({ operation, ok: true });
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
