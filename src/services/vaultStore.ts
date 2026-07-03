import { parseMarkdownDocument, serializeMarkdownDocument } from "../domain/markdown";
import type {
  CommentDocument,
  ItemDocument,
  ItemFrontMatter,
  OutboxOperationDocument,
  OutboxOperationFrontMatter,
  VaultSourceDocument
} from "../domain/types";

const vaultDocumentsKey = "yonalist.vaultDocuments.v1";

interface StoredVaults {
  [vaultRoot: string]: Record<string, string>;
}

interface TauriVaultFile {
  relative_path: string;
  contents: string;
}

export interface VaultState {
  items: ItemDocument[];
  outbox: OutboxOperationDocument[];
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinPath(...parts: string[]): string {
  const [first, ...rest] = parts;
  const prefix = first.startsWith("/") ? "/" : "";
  const joined = [trimSlashes(first), ...rest.map(trimSlashes)]
    .filter(Boolean)
    .join("/");
  return `${prefix}${joined}`;
}

function relativePath(vaultRoot: string, documentPath: string): string {
  const normalizedRoot = vaultRoot.replace(/\/+$/, "");
  const normalizedPath = documentPath.replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return trimSlashes(documentPath);
}

function absolutePath(vaultRoot: string, relativePath: string): string {
  return joinPath(vaultRoot, relativePath);
}

function loadStoredVaults(): StoredVaults {
  try {
    const stored = window.localStorage.getItem(vaultDocumentsKey);
    return stored ? (JSON.parse(stored) as StoredVaults) : {};
  } catch {
    return {};
  }
}

function persistStoredVaults(vaults: StoredVaults) {
  try {
    window.localStorage.setItem(vaultDocumentsKey, JSON.stringify(vaults));
  } catch {
    // The in-memory React state still works when local persistence is blocked.
  }
}

function serializeItem(item: ItemDocument): string {
  return serializeMarkdownDocument(item.frontMatter, item.body);
}

function serializeOutbox(operation: OutboxOperationDocument): string {
  return serializeMarkdownDocument(operation.frontMatter, operation.body);
}

function serializeComment(comment: CommentDocument): string {
  return serializeMarkdownDocument(comment.frontMatter, comment.body);
}

async function invokeTauri<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function writeVaultFile(
  vaultRoot: string,
  documentPath: string,
  contents: string
) {
  const relative = relativePath(vaultRoot, documentPath);
  if (isTauri()) {
    await invokeTauri("write_text_file", {
      vaultPath: vaultRoot,
      relativePath: relative,
      contents
    });
    return;
  }

  const vaults = loadStoredVaults();
  vaults[vaultRoot] = { ...(vaults[vaultRoot] ?? {}), [relative]: contents };
  persistStoredVaults(vaults);
}

export async function deleteVaultDocument(vaultRoot: string, documentPath: string) {
  const relative = relativePath(vaultRoot, documentPath);
  if (isTauri()) {
    await invokeTauri("delete_text_file", {
      vaultPath: vaultRoot,
      relativePath: relative
    });
    return;
  }

  const vaults = loadStoredVaults();
  const documents = { ...(vaults[vaultRoot] ?? {}) };
  delete documents[relative];
  vaults[vaultRoot] = documents;
  persistStoredVaults(vaults);
}

export async function moveVaultDocument(
  vaultRoot: string,
  fromPath: string,
  toPath: string,
  contents?: string
) {
  const fromRelativePath = relativePath(vaultRoot, fromPath);
  const toRelativePath = relativePath(vaultRoot, toPath);
  if (isTauri()) {
    await invokeTauri("move_text_file", {
      vaultPath: vaultRoot,
      fromRelativePath,
      toRelativePath,
      contents
    });
    return;
  }

  const vaults = loadStoredVaults();
  const documents = { ...(vaults[vaultRoot] ?? {}) };
  documents[toRelativePath] = contents ?? documents[fromRelativePath] ?? "";
  delete documents[fromRelativePath];
  vaults[vaultRoot] = documents;
  persistStoredVaults(vaults);
}

export function itemDocumentContents(item: ItemDocument): string {
  return serializeItem(item);
}

export function outboxOperationContents(operation: OutboxOperationDocument): string {
  return serializeOutbox(operation);
}

export function commentDocumentContents(comment: CommentDocument): string {
  return serializeComment(comment);
}

export async function persistItemDocument(vaultRoot: string, item: ItemDocument) {
  await writeVaultFile(vaultRoot, item.path, serializeItem(item));
}

export async function persistOutboxOperation(
  vaultRoot: string,
  operation: OutboxOperationDocument
) {
  await writeVaultFile(vaultRoot, operation.path, serializeOutbox(operation));
}

export async function persistCommentDocument(
  vaultRoot: string,
  comment: CommentDocument
) {
  await writeVaultFile(vaultRoot, comment.path, serializeComment(comment));
}

export async function readVaultDocuments(
  vaultRoot: string
): Promise<VaultSourceDocument[]> {
  if (isTauri()) {
    const files = await invokeTauri<TauriVaultFile[]>("list_markdown_files", {
      vaultPath: vaultRoot
    });
    return files.map((file) => ({
      path: absolutePath(vaultRoot, file.relative_path),
      contents: file.contents
    }));
  }

  const documents = loadStoredVaults()[vaultRoot] ?? {};
  return Object.entries(documents).map(([path, contents]) => ({
    path: absolutePath(vaultRoot, path),
    contents
  }));
}

function isItemFrontMatter(value: unknown): value is ItemFrontMatter {
  return (
    typeof value === "object" &&
    value !== null &&
    ["issue", "pull", "discussion"].includes(
      String((value as { kind?: unknown }).kind)
    )
  );
}

function isOutboxFrontMatter(
  value: unknown
): value is OutboxOperationFrontMatter {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "outbox_operation"
  );
}

export async function loadVaultState(vaultRoot: string): Promise<VaultState> {
  const documents = await readVaultDocuments(vaultRoot);
  const items: ItemDocument[] = [];
  const outbox: OutboxOperationDocument[] = [];

  for (const document of documents) {
    const parsed = parseMarkdownDocument<unknown>(document.contents);
    if (isItemFrontMatter(parsed.frontMatter)) {
      items.push({
        path: document.path,
        frontMatter: parsed.frontMatter,
        body: parsed.body
      });
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
    items: items.sort((left, right) =>
      right.frontMatter.updated_at.localeCompare(left.frontMatter.updated_at)
    ),
    outbox: outbox.sort((left, right) =>
      left.frontMatter.created_at.localeCompare(right.frontMatter.created_at)
    )
  };
}
