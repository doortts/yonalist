import { parseMarkdownDocument, serializeMarkdownDocument } from "../domain/markdown";
import { itemMergeKey, withVaultItemPath } from "../domain/items";
import type {
  CommentDocument,
  ItemDocument,
  ItemFrontMatter,
  ItemKind,
  ItemState,
  OutboxOperationDocument,
  OutboxOperationFrontMatter,
  SyncStatus,
  VaultSourceDocument
} from "../domain/types";

const vaultDocumentsKey = "yonalist.vaultDocuments.v1";
const vaultDocumentHashesKey = "yonalist.vaultDocumentHashes.v1";

interface StoredVaults {
  [vaultRoot: string]: Record<string, string>;
}

interface StoredVaultHashes {
  [vaultRoot: string]: Record<string, string>;
}

interface NativeVaultDocumentHashRecord {
  relative_path: string;
  content_hash: string;
  size: number;
}

interface TauriVaultFile {
  relative_path: string;
  contents: string;
}

interface PersistVaultDocumentInput {
  relative_path: string;
  contents: string;
}

interface NativeVaultItemIndexRecord {
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

export interface PersistVaultDocumentsResult {
  checked: number;
  written: number;
  skipped: number;
}

export interface VaultState {
  items: ItemDocument[];
  outbox: OutboxOperationDocument[];
}

const vaultHashMemoryCache = new Map<string, Map<string, string>>();

function memoryHashesForVault(vaultRoot: string): Map<string, string> {
  let hashes = vaultHashMemoryCache.get(vaultRoot);
  if (!hashes) {
    hashes = new Map();
    vaultHashMemoryCache.set(vaultRoot, hashes);
  }
  return hashes;
}

function memoryDocumentHash(
  vaultRoot: string,
  documentRelativePath: string
): string | undefined {
  return vaultHashMemoryCache.get(vaultRoot)?.get(documentRelativePath);
}

function rememberMemoryDocumentHash(
  vaultRoot: string,
  documentRelativePath: string,
  hash: string
) {
  memoryHashesForVault(vaultRoot).set(documentRelativePath, hash);
}

function replaceMemoryDocumentHashes(
  vaultRoot: string,
  documents: Array<{ relativePath: string; contents: string }>
) {
  const hashes = new Map<string, string>();
  for (const document of documents) {
    hashes.set(document.relativePath, hashString(document.contents));
  }
  vaultHashMemoryCache.set(vaultRoot, hashes);
}

export function clearVaultDocumentHashMemoryCache() {
  vaultHashMemoryCache.clear();
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

function parseJsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function itemIndexRecord(
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

function itemFromIndexRecord(
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

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function loadStoredVaultHashes(): StoredVaultHashes {
  try {
    const stored = window.localStorage.getItem(vaultDocumentHashesKey);
    return stored ? (JSON.parse(stored) as StoredVaultHashes) : {};
  } catch {
    return {};
  }
}

function persistStoredVaultHashes(hashes: StoredVaultHashes) {
  try {
    window.localStorage.setItem(vaultDocumentHashesKey, JSON.stringify(hashes));
  } catch {
    // Hashes are an optimization; failed persistence should not block writes.
  }
}

async function getStoredDocumentHash(
  vaultRoot: string,
  documentRelativePath: string
): Promise<string | null> {
  const cached = memoryDocumentHash(vaultRoot, documentRelativePath);
  if (cached !== undefined) {
    return cached;
  }
  if (isTauri()) {
    const stored = await invokeTauri<string | null>("get_vault_document_hash", {
      vaultPath: vaultRoot,
      relativePath: documentRelativePath
    });
    if (stored !== null) {
      rememberMemoryDocumentHash(vaultRoot, documentRelativePath, stored);
    }
    return stored;
  }
  const stored = loadStoredVaultHashes()[vaultRoot]?.[documentRelativePath] ?? null;
  if (stored !== null) {
    rememberMemoryDocumentHash(vaultRoot, documentRelativePath, stored);
  }
  return stored;
}

async function rememberDocumentHash(
  vaultRoot: string,
  documentRelativePath: string,
  hash: string,
  size: number
) {
  rememberMemoryDocumentHash(vaultRoot, documentRelativePath, hash);
  if (isTauri()) {
    await invokeTauri("upsert_vault_document_hash", {
      vaultPath: vaultRoot,
      relativePath: documentRelativePath,
      contentHash: hash,
      size
    });
    return;
  }

  const hashes = loadStoredVaultHashes();
  const documents = { ...(hashes[vaultRoot] ?? {}) };
  if (documents[documentRelativePath] === hash) {
    return;
  }
  documents[documentRelativePath] = hash;
  hashes[vaultRoot] = documents;
  persistStoredVaultHashes(hashes);
}

async function rememberDocumentHashes(
  vaultRoot: string,
  documents: Array<{ relativePath: string; contents: string }>
) {
  replaceMemoryDocumentHashes(vaultRoot, documents);
  if (isTauri()) {
    const records: NativeVaultDocumentHashRecord[] = documents.map((document) => ({
      relative_path: document.relativePath,
      content_hash: hashString(document.contents),
      size: document.contents.length
    }));
    await invokeTauri("replace_vault_document_hashes", {
      vaultPath: vaultRoot,
      documents: records
    });
    return;
  }

  const hashes = loadStoredVaultHashes();
  const current = hashes[vaultRoot] ?? {};
  const next: Record<string, string> = {};

  for (const document of documents) {
    next[document.relativePath] = hashString(document.contents);
  }

  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  const changed =
    currentKeys.length !== nextKeys.length ||
    nextKeys.some((key) => current[key] !== next[key]);
  if (!changed) {
    return;
  }
  hashes[vaultRoot] = next;
  persistStoredVaultHashes(hashes);
}

async function forgetDocumentHash(vaultRoot: string, documentRelativePath: string) {
  vaultHashMemoryCache.get(vaultRoot)?.delete(documentRelativePath);
  if (isTauri()) {
    await invokeTauri("delete_vault_document_hash", {
      vaultPath: vaultRoot,
      relativePath: documentRelativePath
    });
    return;
  }

  const hashes = loadStoredVaultHashes();
  const documents = { ...(hashes[vaultRoot] ?? {}) };
  if (!(documentRelativePath in documents)) {
    return;
  }
  delete documents[documentRelativePath];
  hashes[vaultRoot] = documents;
  persistStoredVaultHashes(hashes);
}

async function moveDocumentHash(
  vaultRoot: string,
  fromRelativePath: string,
  toRelativePath: string,
  contents?: string
) {
  vaultHashMemoryCache.get(vaultRoot)?.delete(fromRelativePath);
  if (isTauri()) {
    await invokeTauri("move_vault_document_hash", {
      vaultPath: vaultRoot,
      fromRelativePath,
      toRelativePath,
      contentHash: typeof contents === "string" ? hashString(contents) : null,
      size: typeof contents === "string" ? contents.length : null
    });
    if (typeof contents === "string") {
      rememberMemoryDocumentHash(vaultRoot, toRelativePath, hashString(contents));
    }
    return;
  }

  const hashes = loadStoredVaultHashes();
  const documents = { ...(hashes[vaultRoot] ?? {}) };
  const nextHash =
    typeof contents === "string"
      ? hashString(contents)
      : documents[fromRelativePath];
  delete documents[fromRelativePath];
  if (nextHash) {
    documents[toRelativePath] = nextHash;
    rememberMemoryDocumentHash(vaultRoot, toRelativePath, nextHash);
  }
  hashes[vaultRoot] = documents;
  persistStoredVaultHashes(hashes);
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
  const nextHash = hashString(contents);
  if ((await getStoredDocumentHash(vaultRoot, relative)) === nextHash) {
    return;
  }
  if (isTauri()) {
    await invokeTauri("write_text_file", {
      vaultPath: vaultRoot,
      relativePath: relative,
      contents
    });
    await rememberDocumentHash(vaultRoot, relative, nextHash, contents.length);
    return;
  }

  const vaults = loadStoredVaults();
  const existingDocuments = vaults[vaultRoot] ?? {};
  const existsInPreviewStore = Object.prototype.hasOwnProperty.call(
    existingDocuments,
    relative
  );
  if (existsInPreviewStore && hashString(existingDocuments[relative]) === nextHash) {
    await rememberDocumentHash(vaultRoot, relative, nextHash, contents.length);
    return;
  }
  vaults[vaultRoot] = { ...(vaults[vaultRoot] ?? {}), [relative]: contents };
  persistStoredVaults(vaults);
  await rememberDocumentHash(vaultRoot, relative, nextHash, contents.length);
}

async function persistVaultDocuments(
  vaultRoot: string,
  documents: PersistVaultDocumentInput[]
): Promise<PersistVaultDocumentsResult> {
  if (documents.length === 0) {
    return { checked: 0, written: 0, skipped: 0 };
  }

  if (isTauri()) {
    const result = await invokeTauri<PersistVaultDocumentsResult>(
      "persist_vault_documents",
      {
        vaultPath: vaultRoot,
        documents
      }
    );
    for (const document of documents) {
      rememberMemoryDocumentHash(
        vaultRoot,
        document.relative_path,
        hashString(document.contents)
      );
    }
    return result;
  }

  const vaults = loadStoredVaults();
  const existingDocuments = vaults[vaultRoot] ?? {};
  const storedHashes = loadStoredVaultHashes();
  const documentHashes = { ...(storedHashes[vaultRoot] ?? {}) };
  let nextDocuments = existingDocuments;
  let documentsChanged = false;
  let hashesChanged = false;
  const result: PersistVaultDocumentsResult = {
    checked: 0,
    written: 0,
    skipped: 0
  };

  for (const document of documents) {
    result.checked += 1;
    const relative = document.relative_path;
    const nextHash = hashString(document.contents);
    const cachedHash = memoryDocumentHash(vaultRoot, relative) ?? documentHashes[relative];
    if (cachedHash === nextHash) {
      rememberMemoryDocumentHash(vaultRoot, relative, nextHash);
      result.skipped += 1;
      continue;
    }

    if (
      Object.prototype.hasOwnProperty.call(existingDocuments, relative) &&
      hashString(existingDocuments[relative]) === nextHash
    ) {
      documentHashes[relative] = nextHash;
      hashesChanged = true;
      rememberMemoryDocumentHash(vaultRoot, relative, nextHash);
      result.skipped += 1;
      continue;
    }

    if (!documentsChanged) {
      nextDocuments = { ...existingDocuments };
      documentsChanged = true;
    }
    nextDocuments[relative] = document.contents;
    documentHashes[relative] = nextHash;
    hashesChanged = true;
    rememberMemoryDocumentHash(vaultRoot, relative, nextHash);
    result.written += 1;
  }

  if (documentsChanged) {
    vaults[vaultRoot] = nextDocuments;
    persistStoredVaults(vaults);
  }
  if (hashesChanged) {
    storedHashes[vaultRoot] = documentHashes;
    persistStoredVaultHashes(storedHashes);
  }

  return result;
}

async function upsertNativeItemIndex(vaultRoot: string, items: ItemDocument[]) {
  if (!isTauri() || items.length === 0) {
    return;
  }
  await invokeTauri("upsert_vault_item_index", {
    vaultPath: vaultRoot,
    records: items.map((item) => itemIndexRecord(vaultRoot, item))
  });
}

async function replaceNativeItemIndex(vaultRoot: string, items: ItemDocument[]) {
  if (!isTauri()) {
    return;
  }
  await invokeTauri("replace_vault_item_index", {
    vaultPath: vaultRoot,
    records: items.map((item) => itemIndexRecord(vaultRoot, item))
  });
}

export async function deleteVaultDocument(vaultRoot: string, documentPath: string) {
  const relative = relativePath(vaultRoot, documentPath);
  if (isTauri()) {
    await invokeTauri("delete_text_file", {
      vaultPath: vaultRoot,
      relativePath: relative
    });
    await forgetDocumentHash(vaultRoot, relative);
    return;
  }

  const vaults = loadStoredVaults();
  const documents = { ...(vaults[vaultRoot] ?? {}) };
  delete documents[relative];
  vaults[vaultRoot] = documents;
  persistStoredVaults(vaults);
  await forgetDocumentHash(vaultRoot, relative);
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
    await moveDocumentHash(vaultRoot, fromRelativePath, toRelativePath, contents);
    return;
  }

  const vaults = loadStoredVaults();
  const documents = { ...(vaults[vaultRoot] ?? {}) };
  documents[toRelativePath] = contents ?? documents[fromRelativePath] ?? "";
  delete documents[fromRelativePath];
  vaults[vaultRoot] = documents;
  persistStoredVaults(vaults);
  await moveDocumentHash(
    vaultRoot,
    fromRelativePath,
    toRelativePath,
    documents[toRelativePath]
  );
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
  await upsertNativeItemIndex(vaultRoot, [item]);
}

export async function persistItemDocuments(
  vaultRoot: string,
  items: ItemDocument[]
): Promise<PersistVaultDocumentsResult> {
  const result = await persistVaultDocuments(
    vaultRoot,
    items.map((item) => ({
      relative_path: relativePath(vaultRoot, item.path),
      contents: serializeItem(item)
    }))
  );
  await upsertNativeItemIndex(vaultRoot, items);
  return result;
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

export async function persistCommentDocuments(
  vaultRoot: string,
  comments: CommentDocument[]
): Promise<PersistVaultDocumentsResult> {
  return persistVaultDocuments(
    vaultRoot,
    comments.map((comment) => ({
      relative_path: relativePath(vaultRoot, comment.path),
      contents: serializeComment(comment)
    }))
  );
}

export async function readVaultDocuments(
  vaultRoot: string
): Promise<VaultSourceDocument[]> {
  if (isTauri()) {
    const files = await invokeTauri<TauriVaultFile[]>("list_markdown_files", {
      vaultPath: vaultRoot
    });
    await rememberDocumentHashes(
      vaultRoot,
      files.map((file) => ({
        relativePath: file.relative_path,
        contents: file.contents
      }))
    );
    return files.map((file) => ({
      path: absolutePath(vaultRoot, file.relative_path),
      contents: file.contents
    }));
  }

  const documents = loadStoredVaults()[vaultRoot] ?? {};
  await rememberDocumentHashes(
    vaultRoot,
    Object.entries(documents).map(([path, contents]) => ({
      relativePath: path,
      contents
    }))
  );
  return Object.entries(documents).map(([path, contents]) => ({
    path: absolutePath(vaultRoot, path),
    contents
  }));
}

async function readOutboxDocuments(
  vaultRoot: string
): Promise<VaultSourceDocument[]> {
  if (!isTauri()) {
    return (await readVaultDocuments(vaultRoot)).filter((document) =>
      relativePath(vaultRoot, document.path).startsWith(".yonalist/outbox/")
    );
  }

  const files = await invokeTauri<TauriVaultFile[]>("list_outbox_markdown_files", {
    vaultPath: vaultRoot
  });
  if (files.length > 0) {
    await rememberDocumentHashes(
      vaultRoot,
      files.map((file) => ({
        relativePath: file.relative_path,
        contents: file.contents
      }))
    );
  }
  return files.map((file) => ({
    path: absolutePath(vaultRoot, file.relative_path),
    contents: file.contents
  }));
}

async function loadIndexedItems(vaultRoot: string): Promise<ItemDocument[]> {
  if (!isTauri()) {
    return [];
  }
  const records = await invokeTauri<NativeVaultItemIndexRecord[]>(
    "list_vault_item_index",
    { vaultPath: vaultRoot }
  );
  return records.map((record) => itemFromIndexRecord(vaultRoot, record));
}

function preferIndexedItem(left: ItemDocument, right: ItemDocument): ItemDocument {
  const winner =
    right.frontMatter.updated_at.localeCompare(left.frontMatter.updated_at) > 0
      ? right
      : left;
  const fallback = winner === right ? left : right;
  return {
    ...winner,
    frontMatter: {
      ...winner.frontMatter,
      comments_count:
        winner.frontMatter.comments_count ?? fallback.frontMatter.comments_count,
      local: {
        ...winner.frontMatter.local,
        favorite:
          winner.frontMatter.local.favorite ||
          fallback.frontMatter.local.favorite
      }
    }
  };
}

function parseVaultItemsFromDocuments(
  vaultRoot: string,
  documents: VaultSourceDocument[]
): ItemDocument[] {
  const byIdentity = new Map<string, ItemDocument>();

  for (const document of documents) {
    const parsed = parseMarkdownDocument<unknown>(document.contents);
    if (!isItemFrontMatter(parsed.frontMatter)) {
      continue;
    }
    const item = withVaultItemPath(vaultRoot, {
      path: document.path,
      frontMatter: parsed.frontMatter,
      body: ""
    });
    const key = itemMergeKey(item);
    const current = byIdentity.get(key);
    byIdentity.set(key, current ? preferIndexedItem(current, item) : item);
  }

  return [...byIdentity.values()].sort((left, right) =>
    right.frontMatter.updated_at.localeCompare(left.frontMatter.updated_at)
  );
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
  if (isTauri()) {
    const indexedItems = await loadIndexedItems(vaultRoot);
    if (indexedItems.length > 0) {
      return {
        items: indexedItems,
        outbox: parseOutboxDocuments(await readOutboxDocuments(vaultRoot))
      };
    }
  }

  const documents = await readVaultDocuments(vaultRoot);
  const sortedItems = parseVaultItemsFromDocuments(vaultRoot, documents);
  await replaceNativeItemIndex(vaultRoot, sortedItems);

  return {
    items: sortedItems,
    outbox: parseOutboxDocuments(documents)
  };
}

export async function rebuildVaultStateFromMarkdown(
  vaultRoot: string
): Promise<VaultState> {
  const documents = await readVaultDocuments(vaultRoot);
  const items = parseVaultItemsFromDocuments(vaultRoot, documents);
  await replaceNativeItemIndex(vaultRoot, items);
  return {
    items,
    outbox: parseOutboxDocuments(documents)
  };
}

function parseOutboxDocuments(
  documents: VaultSourceDocument[]
): OutboxOperationDocument[] {
  const outbox: OutboxOperationDocument[] = [];
  for (const document of documents) {
    const parsed = parseMarkdownDocument<unknown>(document.contents);
    if (isOutboxFrontMatter(parsed.frontMatter)) {
      outbox.push({
        path: document.path,
        frontMatter: parsed.frontMatter,
        body: parsed.body
      });
    }
  }
  return outbox.sort((left, right) =>
    left.frontMatter.created_at.localeCompare(right.frontMatter.created_at)
  );
}

export async function loadItemDocumentBody(
  vaultRoot: string,
  item: ItemDocument
): Promise<string> {
  if (item.body) {
    return item.body;
  }
  const relative = relativePath(vaultRoot, item.path);
  const contents = isTauri()
    ? await invokeTauri<string>("read_text_file", {
        vaultPath: vaultRoot,
        relativePath: relative
      })
    : loadStoredVaults()[vaultRoot]?.[relative] ?? "";
  const parsed = parseMarkdownDocument<unknown>(contents);
  return parsed.body;
}
