import type { ItemDocument } from "./types";

export function itemThreadVersion(item: ItemDocument, refreshKey = 0): string {
  return `${item.frontMatter.updated_at}|refresh:${refreshKey}`;
}
