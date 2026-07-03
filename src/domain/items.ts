import { itemMainPath } from "./paths";
import type { ItemDocument, ItemIdentity } from "./types";

function identityParts(identity: ItemIdentity): string[] {
  return [
    identity.host.toLowerCase(),
    identity.owner.toLowerCase(),
    identity.repo.toLowerCase(),
    identity.kind,
    String(identity.number)
  ];
}

export function itemIdentityKey(identity: ItemIdentity): string {
  return identityParts(identity).join("/");
}

export function itemMergeKey(item: ItemDocument): string {
  if (item.frontMatter.number > 0) {
    return itemIdentityKey(item.frontMatter);
  }
  return `path:${item.path}`;
}

export function withVaultItemPath(
  vaultRoot: string,
  item: ItemDocument
): ItemDocument {
  if (item.frontMatter.number <= 0) {
    return item;
  }

  const path = itemMainPath(vaultRoot, item.frontMatter);
  return path === item.path ? item : { ...item, path };
}

function mergeRemoteOverLocal(
  local: ItemDocument,
  remote: ItemDocument
): ItemDocument {
  return {
    ...remote,
    frontMatter: {
      ...remote.frontMatter,
      local: {
        ...remote.frontMatter.local,
        favorite:
          local.frontMatter.local.favorite || remote.frontMatter.local.favorite
      }
    }
  };
}

export function mergeItemDocuments(
  localItems: ItemDocument[],
  remoteItems: ItemDocument[],
  vaultRoot: string
): ItemDocument[] {
  const byIdentity = new Map<string, ItemDocument>();

  for (const item of localItems) {
    byIdentity.set(itemMergeKey(item), item);
  }

  for (const item of remoteItems) {
    const remote = withVaultItemPath(vaultRoot, item);
    const key = itemMergeKey(remote);
    const current = byIdentity.get(key);
    if (current?.frontMatter.sync.status === "pending") {
      continue;
    }
    byIdentity.set(key, current ? mergeRemoteOverLocal(current, remote) : remote);
  }

  return [...byIdentity.values()].sort((left, right) =>
    right.frontMatter.updated_at.localeCompare(left.frontMatter.updated_at)
  );
}
