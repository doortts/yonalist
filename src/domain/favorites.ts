import type { ItemDocument } from "./types";

export function toggleFavorite(
  item: ItemDocument,
  favorite = !item.frontMatter.local.favorite
): ItemDocument {
  return {
    ...item,
    frontMatter: {
      ...item.frontMatter,
      local: {
        ...item.frontMatter.local,
        favorite
      }
    }
  };
}

export function mergeRemoteItemPreservingLocal(
  remote: ItemDocument,
  local?: ItemDocument
): ItemDocument {
  return {
    ...remote,
    frontMatter: {
      ...remote.frontMatter,
      local: {
        ...remote.frontMatter.local,
        favorite:
          local?.frontMatter.local.favorite ?? remote.frontMatter.local.favorite
      }
    }
  };
}
