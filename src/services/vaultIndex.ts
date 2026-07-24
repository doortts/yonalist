import { parseMarkdownDocument } from "../domain/markdown";
import { withVaultItemPath } from "../domain/items";
import type {
  ItemDocument,
  ItemFrontMatter,
  ItemKind,
  ItemState,
  SyncStatus
} from "../domain/types";

export interface NativeVaultItemIndexRecord {
  relative_path: string;
  host: string;
  owner: string;
  repo: string;
  kind: string;
  number: number;
  title: string;
  state: string;
  author: string;
  labels_json: string;
  label_colors_json: string;
  comment_count: number | null;
  created_at: string;
  updated_at: string;
  html_url: string | null;
  favorite: boolean;
  sync_status: string;
}

export interface VaultManifestFingerprint {
  content_hash: string;
  size: number;
  modified_ns: string;
}

export interface VaultIndexScanChange {
  relative_path: string;
  size: number;
  modified_ns: string;
  content_hash: string;
  frontmatter: string | null;
  frontmatter_error: boolean;
  expected: VaultManifestFingerprint | null;
}

export interface VaultRemovedIndexPath {
  relative_path: string;
  expected: VaultManifestFingerprint;
}

export interface VaultParsedIndexChange
  extends Omit<VaultIndexScanChange, "frontmatter" | "frontmatter_error"> {
  candidate: NativeVaultItemIndexRecord | null;
}

export interface VaultIndexWorkerResult {
  changes: VaultParsedIndexChange[];
  invalidCount: number;
}

function relativePath(vaultRoot: string, documentPath: string): string {
  const root = vaultRoot.replace(/\/+$/, "");
  const path = documentPath.replace(/\/+$/, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.replace(/^\/+/, "");
}

function absolutePath(vaultRoot: string, relativePath: string): string {
  const root = vaultRoot.replace(/\/+$/, "");
  return `${root || "/"}/${relativePath.replace(/^\/+/, "")}`.replace(/^\/\//, "/");
}

function parseJsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function itemIndexRecord(
  vaultRoot: string,
  item: ItemDocument
): NativeVaultItemIndexRecord {
  return {
    relative_path: relativePath(vaultRoot, item.path),
    host: item.frontMatter.host,
    owner: item.frontMatter.owner,
    repo: item.frontMatter.repo,
    kind: item.frontMatter.kind,
    number: item.frontMatter.number,
    title: item.frontMatter.title,
    state: item.frontMatter.state,
    author: item.frontMatter.author,
    labels_json: JSON.stringify(item.frontMatter.labels ?? []),
    label_colors_json: JSON.stringify(item.frontMatter.label_colors ?? {}),
    comment_count: item.frontMatter.comments_count ?? null,
    created_at: item.frontMatter.created_at,
    updated_at: item.frontMatter.updated_at,
    html_url: item.frontMatter.html_url ?? null,
    favorite: Boolean(item.frontMatter.local.favorite),
    sync_status: item.frontMatter.sync.status
  };
}

export function itemFromIndexRecord(
  vaultRoot: string,
  record: NativeVaultItemIndexRecord
): ItemDocument {
  const labels = parseJsonValue<string[]>(record.labels_json, []);
  const labelColors = parseJsonValue<Record<string, string>>(
    record.label_colors_json,
    {}
  );
  const frontMatter: ItemFrontMatter = {
    kind: record.kind as ItemKind,
    host: record.host,
    owner: record.owner,
    repo: record.repo,
    number: record.number,
    title: record.title,
    state: record.state as ItemState,
    author: record.author,
    labels,
    ...(Object.keys(labelColors).length > 0 ? { label_colors: labelColors } : {}),
    ...(record.comment_count !== null && record.comment_count !== undefined
      ? { comments_count: record.comment_count }
      : {}),
    ...(record.html_url ? { html_url: record.html_url } : {}),
    created_at: record.created_at,
    updated_at: record.updated_at,
    local: { favorite: record.favorite },
    sync: { status: record.sync_status as SyncStatus }
  };
  return {
    path: absolutePath(vaultRoot, record.relative_path),
    frontMatter,
    body: ""
  };
}

function isItemKind(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ["issue", "pull", "discussion"].includes(
      String((value as { kind?: unknown }).kind)
    )
  );
}

function isItemFrontMatter(value: unknown): value is ItemFrontMatter {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const frontMatter = value as Record<string, unknown>;
  const labels = frontMatter.labels;
  const labelColors = frontMatter.label_colors;
  const local = frontMatter.local;
  const sync = frontMatter.sync;
  return (
    isItemKind(value) &&
    Number.isSafeInteger(frontMatter.number) &&
    Number(frontMatter.number) > 0 &&
    typeof frontMatter.host === "string" &&
    frontMatter.host.trim().length > 0 &&
    typeof frontMatter.owner === "string" &&
    frontMatter.owner.trim().length > 0 &&
    typeof frontMatter.repo === "string" &&
    frontMatter.repo.trim().length > 0 &&
    typeof frontMatter.title === "string" &&
    frontMatter.title.trim().length > 0 &&
    typeof frontMatter.state === "string" &&
    typeof frontMatter.author === "string" &&
    Array.isArray(labels) &&
    labels.every((label) => typeof label === "string") &&
    (labelColors === undefined ||
      (typeof labelColors === "object" &&
        labelColors !== null &&
        !Array.isArray(labelColors) &&
        Object.values(labelColors).every((color) => typeof color === "string"))) &&
    typeof frontMatter.created_at === "string" &&
    typeof frontMatter.updated_at === "string" &&
    typeof local === "object" &&
    local !== null &&
    typeof (local as { favorite?: unknown }).favorite === "boolean" &&
    typeof sync === "object" &&
    sync !== null &&
    typeof (sync as { status?: unknown }).status === "string" &&
    (frontMatter.comments_count === undefined ||
      (typeof frontMatter.comments_count === "number" &&
        Number.isSafeInteger(frontMatter.comments_count))) &&
    (frontMatter.html_url === undefined ||
      typeof frontMatter.html_url === "string")
  );
}

export function parseVaultIndexScanChanges(
  vaultRoot: string,
  changes: VaultIndexScanChange[]
): VaultIndexWorkerResult {
  const parsed: VaultParsedIndexChange[] = [];
  let invalidCount = 0;

  for (const change of changes) {
    if (change.frontmatter_error) {
      invalidCount += 1;
      continue;
    }

    try {
      const document = parseMarkdownDocument<unknown>(
        `---\n${change.frontmatter ?? ""}\n---\n`
      );
      const rawFrontMatter = document.frontMatter as Record<string, unknown>;
      const draft = rawFrontMatter.number === 0;
      if (isItemKind(document.frontMatter) && !draft && !isItemFrontMatter(document.frontMatter)) {
        invalidCount += 1;
        continue;
      }
      const candidate =
        isItemFrontMatter(document.frontMatter)
          ? {
              ...itemIndexRecord(
                vaultRoot,
                withVaultItemPath(vaultRoot, {
                  path: absolutePath(vaultRoot, change.relative_path),
                  frontMatter: document.frontMatter,
                  body: ""
                })
              ),
              relative_path: change.relative_path
            }
          : null;
      const { frontmatter: _frontmatter, frontmatter_error: _frontmatterError, ...scan } =
        change;
      parsed.push({ ...scan, candidate });
    } catch {
      invalidCount += 1;
    }
  }

  return { changes: parsed, invalidCount };
}
