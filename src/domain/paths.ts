import type { ItemIdentity, ItemKind, RepositoryIdentity } from "./types";

interface DraftIssueInput extends RepositoryIdentity {
  local_id: string;
}

interface CommentPathInput extends ItemIdentity {
  created_at: string;
  remote_id?: number | string;
  local_id?: string;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function safeSegment(value: string | number): string {
  return String(value).replace(/[/:\\]/g, "-");
}

function joinPath(...parts: Array<string | number>): string {
  const [first, ...rest] = parts.map(String);
  const prefix = first.startsWith("/") ? "/" : "";
  const joined = [trimSlashes(first), ...rest.map(trimSlashes)]
    .filter(Boolean)
    .join("/");
  return `${prefix}${joined}`;
}

function folderForKind(kind: ItemKind): string {
  return {
    issue: "issues",
    pull: "pulls",
    discussion: "discussions"
  }[kind];
}

function mainFileForKind(kind: ItemKind): string {
  return {
    issue: "issue.md",
    pull: "pull.md",
    discussion: "discussion.md"
  }[kind];
}

function compactTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.valueOf())) {
    return safeSegment(isoTimestamp);
  }
  return date.toISOString().replace(/[-:]/g, "").replace(".000", "");
}

export function repositoryRoot(
  vaultRoot: string,
  repository: RepositoryIdentity
): string {
  return joinPath(
    vaultRoot,
    safeSegment(repository.host),
    safeSegment(repository.owner),
    safeSegment(repository.repo)
  );
}

export function itemDirectory(vaultRoot: string, item: ItemIdentity): string {
  return joinPath(
    repositoryRoot(vaultRoot, item),
    folderForKind(item.kind),
    item.number
  );
}

export function itemMainPath(vaultRoot: string, item: ItemIdentity): string {
  return joinPath(itemDirectory(vaultRoot, item), mainFileForKind(item.kind));
}

export function commentsDirectory(vaultRoot: string, item: ItemIdentity): string {
  return joinPath(itemDirectory(vaultRoot, item), "comments");
}

export function commentFilePath(
  vaultRoot: string,
  input: CommentPathInput
): string {
  const id = input.remote_id ?? input.local_id ?? "local";
  return joinPath(
    commentsDirectory(vaultRoot, input),
    `${compactTimestamp(input.created_at)}-${safeSegment(id)}.md`
  );
}

export function attachmentDirectory(
  vaultRoot: string,
  item: ItemIdentity
): string {
  return joinPath(itemDirectory(vaultRoot, item), "attachments");
}

export function draftIssuePath(
  vaultRoot: string,
  input: DraftIssueInput
): string {
  return joinPath(
    repositoryRoot(vaultRoot, input),
    "issues",
    "_drafts",
    safeSegment(input.local_id),
    "issue.md"
  );
}

export function outboxOperationPath(vaultRoot: string, operationId: string): string {
  return joinPath(vaultRoot, ".yonalist", "outbox", `${safeSegment(operationId)}.md`);
}
