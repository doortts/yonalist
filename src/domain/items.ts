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
      comments_count:
        remote.frontMatter.comments_count ?? local.frontMatter.comments_count,
      local: {
        ...remote.frontMatter.local,
        favorite:
          local.frontMatter.local.favorite || remote.frontMatter.local.favorite
      }
    }
  };
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function labelColorsEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return !left && !right;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Compares two item documents on every field that influences list rendering,
 * sorting, or the merge decisions above. When this returns true the objects are
 * interchangeable, so the caller may keep the existing reference to preserve
 * object identity (which lets `React.memo` rows skip re-rendering).
 */
export function itemsEqual(left: ItemDocument, right: ItemDocument): boolean {
  if (left === right) {
    return true;
  }
  if (left.path !== right.path || left.body !== right.body) {
    return false;
  }
  const a = left.frontMatter;
  const b = right.frontMatter;
  return (
    a.kind === b.kind &&
    a.host === b.host &&
    a.owner === b.owner &&
    a.repo === b.repo &&
    a.number === b.number &&
    a.node_id === b.node_id &&
    a.html_url === b.html_url &&
    a.title === b.title &&
    a.state === b.state &&
    a.author === b.author &&
    a.comments_count === b.comments_count &&
    a.created_at === b.created_at &&
    a.updated_at === b.updated_at &&
    a.synced_at === b.synced_at &&
    a.local.favorite === b.local.favorite &&
    a.sync.status === b.sync.status &&
    a.sync.last_error === b.sync.last_error &&
    stringArraysEqual(a.labels, b.labels) &&
    labelColorsEqual(a.label_colors, b.label_colors)
  );
}

/**
 * Returns `next` unless it is element-wise equal to `previous` (same order,
 * same render-affecting fields), in which case the `previous` array reference
 * is returned so downstream `useState`/memo consumers can bail out. For items
 * present in both, the previous object reference is reused when unchanged.
 */
export function reconcileItems(
  previous: ItemDocument[] | null | undefined,
  next: ItemDocument[]
): ItemDocument[] {
  if (!previous) {
    return next;
  }
  const previousByKey = new Map<string, ItemDocument>();
  for (const item of previous) {
    previousByKey.set(itemMergeKey(item), item);
  }

  let changed = false;
  const reconciled = next.map((item) => {
    const prior = previousByKey.get(itemMergeKey(item));
    if (prior && itemsEqual(prior, item)) {
      return prior;
    }
    changed = true;
    return item;
  });

  if (changed || reconciled.length !== previous.length) {
    return reconciled;
  }
  for (let index = 0; index < reconciled.length; index += 1) {
    if (reconciled[index] !== previous[index]) {
      return reconciled;
    }
  }
  return previous;
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
    if (!current) {
      byIdentity.set(key, remote);
      continue;
    }
    const merged = mergeRemoteOverLocal(current, remote);
    byIdentity.set(key, itemsEqual(current, merged) ? current : merged);
  }

  const merged = [...byIdentity.values()].sort((left, right) =>
    right.frontMatter.updated_at.localeCompare(left.frontMatter.updated_at)
  );

  if (merged.length === localItems.length) {
    let identical = true;
    for (let index = 0; index < merged.length; index += 1) {
      if (merged[index] !== localItems[index]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      return localItems;
    }
  }

  return merged;
}
