import type { ItemDocument } from "./types";

/** Web page for a work item; falls back to a constructed host URL. */
export function itemWebUrl(item: ItemDocument, webBaseUrl: string): string {
  if (item.frontMatter.html_url) {
    return item.frontMatter.html_url;
  }
  const base = `${webBaseUrl.replace(/\/+$/, "")}/${item.frontMatter.owner}/${item.frontMatter.repo}`;
  const number = item.frontMatter.number;
  switch (item.frontMatter.kind) {
    case "pull":
      return `${base}/pull/${number}`;
    case "discussion":
      return `${base}/discussions/${number}`;
    default:
      return `${base}/issues/${number}`;
  }
}
