import { parseMarkdownDocument } from "./markdown";
import type {
  ItemFrontMatter,
  ItemIndexEntry,
  OutboxOperationDocument,
  OutboxOperationFrontMatter,
  RepositoryIndexEntry,
  VaultIndex,
  VaultSourceDocument
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isItemFrontMatter(value: unknown): value is ItemFrontMatter {
  return isRecord(value) && ["issue", "pull", "discussion"].includes(String(value.kind));
}

function isOutboxFrontMatter(
  value: unknown
): value is OutboxOperationFrontMatter {
  return isRecord(value) && value.kind === "outbox_operation";
}

export function buildVaultIndex(documents: VaultSourceDocument[]): VaultIndex {
  const items: ItemIndexEntry[] = [];
  const outbox: OutboxOperationDocument[] = [];
  const repositories = new Map<string, RepositoryIndexEntry>();

  for (const document of documents) {
    const parsed = parseMarkdownDocument<unknown>(document.contents);

    if (isItemFrontMatter(parsed.frontMatter)) {
      const frontMatter = parsed.frontMatter;
      const key = `${frontMatter.host}/${frontMatter.owner}/${frontMatter.repo}`;
      const item: ItemIndexEntry = {
        path: document.path,
        kind: frontMatter.kind,
        host: frontMatter.host,
        owner: frontMatter.owner,
        repo: frontMatter.repo,
        number: frontMatter.number,
        title: frontMatter.title,
        state: frontMatter.state,
        author: frontMatter.author,
        labels: frontMatter.labels,
        updated_at: frontMatter.updated_at,
        favorite: Boolean(frontMatter.local?.favorite),
        sync_status: frontMatter.sync.status
      };
      items.push(item);

      const repository = repositories.get(key) ?? {
        key,
        host: frontMatter.host,
        owner: frontMatter.owner,
        repo: frontMatter.repo,
        itemCount: 0,
        favoriteCount: 0
      };
      repository.itemCount += 1;
      if (item.favorite) {
        repository.favoriteCount += 1;
      }
      repositories.set(key, repository);
    }

    if (isOutboxFrontMatter(parsed.frontMatter)) {
      outbox.push({
        path: document.path,
        frontMatter: parsed.frontMatter,
        body: parsed.body
      });
    }
  }

  return {
    repositories: [...repositories.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    ),
    items: items.sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at)
    ),
    outbox: outbox.sort((left, right) =>
      left.frontMatter.created_at.localeCompare(right.frontMatter.created_at)
    )
  };
}
