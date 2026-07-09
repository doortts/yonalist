import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { showAppSnackbar } from "../components/AppSnackbar";
import { commentFilePath, itemMainPath } from "../domain/paths";
import type {
  CommentDocument,
  ItemDocument,
  OutboxOperationDocument
} from "../domain/types";
import { createGitHubClient } from "../services/github";
import { isRemoteReachable } from "../services/remoteReachability";
import { syncOutboxOperations, type OutboxSyncResult } from "../services/sync";
import {
  commentDocumentContents,
  deleteVaultDocument,
  itemDocumentContents,
  moveVaultDocument,
  persistOutboxOperation
} from "../services/vaultStore";
import type { GithubConnection } from "./useGithubAuth";

export interface ReconnectSyncPrompt {
  operations: OutboxOperationDocument[];
  count: number;
}

interface SyncOutcome {
  synced: number;
  failed: number;
  blocked: number;
}

export interface UseOutboxSyncOptions {
  vaultRoot: string;
  connection: GithubConnection;
  online: boolean;
  /** Mirrors the "sync queued changes on reconnect" setting. */
  syncQueuedOnReconnect: boolean;
  /** Current merged item list, used for conflict hints and issue reconcile. */
  items: ItemDocument[];
  setDrafts: Dispatch<SetStateAction<ItemDocument[]>>;
  setLoadedItemBodies: Dispatch<SetStateAction<Record<string, string>>>;
  /** Runs after any sync that pushed at least one change (cache refresh). */
  onAfterSync: () => void;
}

/**
 * The outbox/sync engine: owns the queued-operation state (outbox list,
 * selection, modal visibility, reconnect prompt, in-flight flag) and every
 * flow that pushes queued work to GitHub and reconciles the vault afterward.
 * Navigation-facing flows (opening a queued change's target, editing a queued
 * comment/issue) stay with the caller — they are UX, not sync.
 */
export function useOutboxSync(options: UseOutboxSyncOptions) {
  const {
    vaultRoot,
    connection,
    online,
    syncQueuedOnReconnect,
    items,
    setDrafts,
    setLoadedItemBodies,
    onAfterSync
  } = options;

  const [outbox, setOutbox] = useState<OutboxOperationDocument[]>([]);
  const [selectedOutboxIds, setSelectedOutboxIds] = useState<Set<string>>(
    new Set()
  );
  const [showOutbox, setShowOutbox] = useState(false);
  // Pending reconnect-sync confirmation; the captured operations are flushed
  // only if the user accepts. Null when no prompt is open.
  const [reconnectSyncPrompt, setReconnectSyncPrompt] =
    useState<ReconnectSyncPrompt | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Conflict hint: comment targets that changed remotely after the comment
  // was queued, so the user can re-read the thread before syncing.
  const remoteChangedOutboxIds = useMemo(() => {
    const changed = new Set<string>();
    for (const operation of outbox) {
      if (operation.frontMatter.operation !== "create_comment") {
        continue;
      }
      const { target } = operation.frontMatter;
      const item = items.find(
        (candidate) =>
          candidate.frontMatter.owner === target.owner &&
          candidate.frontMatter.repo === target.repo &&
          candidate.frontMatter.number === target.number
      );
      if (item && item.frontMatter.updated_at > operation.frontMatter.created_at) {
        changed.add(operation.frontMatter.id);
      }
    }
    return changed;
  }, [outbox, items]);

  const openOutbox = useCallback(() => {
    setSelectedOutboxIds(
      new Set(outbox.map((operation) => operation.frontMatter.id))
    );
    setShowOutbox(true);
  }, [outbox]);

  function toggleOutboxSelection(id: string) {
    setSelectedOutboxIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function removeOutboxOperationFromState(operation: OutboxOperationDocument) {
    const operationId = operation.frontMatter.id;
    const localFilePath = operation.frontMatter.local_file_path;

    setOutbox((current) =>
      current.filter((entry) => entry.frontMatter.id !== operationId)
    );
    setSelectedOutboxIds((current) => {
      const next = new Set(current);
      next.delete(operationId);
      return next;
    });
    if (operation.frontMatter.operation === "create_issue") {
      setDrafts((current) =>
        current.filter((draft) => draft.path !== localFilePath)
      );
    }
    setLoadedItemBodies((current) => {
      const next = { ...current };
      delete next[localFilePath];
      return next;
    });
  }

  function removeOutboxOperationDocuments(operation: OutboxOperationDocument) {
    const shouldDeleteLocalDocument =
      operation.frontMatter.operation === "create_issue" ||
      operation.body.trim().length > 0;
    return Promise.all([
      deleteVaultDocument(vaultRoot, operation.path),
      ...(shouldDeleteLocalDocument
        ? [deleteVaultDocument(vaultRoot, operation.frontMatter.local_file_path)]
        : [])
    ]);
  }

  function discardOutboxOperation(operation: OutboxOperationDocument) {
    removeOutboxOperationDocuments(operation).catch(() => {
      showAppSnackbar("Queued change could not be removed from disk.");
    });
    removeOutboxOperationFromState(operation);
  }

  function deleteOutboxOperation(operation: OutboxOperationDocument) {
    discardOutboxOperation(operation);
    showAppSnackbar("Queued change deleted.");
  }

  async function applySyncedOutboxResult(result: OutboxSyncResult) {
    const { operation, remote } = result;
    if (!remote) {
      return;
    }

    if (remote.type === "issue") {
      const draft = items.find(
        (item) => item.path === operation.frontMatter.local_file_path
      );
      if (!draft) {
        await deleteVaultDocument(vaultRoot, operation.path);
        return;
      }

      const syncedFrontMatter = {
        ...draft.frontMatter,
        number: remote.number,
        node_id: remote.node_id,
        html_url: remote.html_url,
        updated_at: remote.updated_at ?? new Date().toISOString(),
        synced_at: new Date().toISOString(),
        sync: { status: "synced" as const }
      };
      const syncedItem: ItemDocument = {
        path: itemMainPath(vaultRoot, syncedFrontMatter),
        frontMatter: syncedFrontMatter,
        body: draft.body
      };

      await moveVaultDocument(
        vaultRoot,
        draft.path,
        syncedItem.path,
        itemDocumentContents(syncedItem)
      );
      setDrafts((current) =>
        current.map((item) => (item.path === draft.path ? syncedItem : item))
      );
    }

    if (remote.type === "comment") {
      const target = operation.frontMatter.target;
      if (target.kind && typeof target.number === "number") {
        const createdAt = remote.created_at ?? new Date().toISOString();
        const comment: CommentDocument = {
          path: commentFilePath(vaultRoot, {
            kind: target.kind,
            host: target.host,
            owner: target.owner,
            repo: target.repo,
            number: target.number,
            created_at: createdAt,
            remote_id: remote.id
          }),
          body: remote.body ?? operation.body,
          frontMatter: {
            kind: "issue_comment",
            remote_id:
              typeof remote.id === "number" ? remote.id : Number(remote.id) || undefined,
            node_id: remote.node_id,
            ...(target.parent_comment_id !== undefined
              ? { parent_remote_id: target.parent_comment_id }
              : {}),
            ...(target.parent_comment_node_id
              ? { parent_node_id: target.parent_comment_node_id }
              : {}),
            author: "local",
            created_at: createdAt,
            updated_at: remote.updated_at ?? createdAt,
            sync: { status: "synced" }
          }
        };

        await moveVaultDocument(
          vaultRoot,
          operation.frontMatter.local_file_path,
          comment.path,
          commentDocumentContents(comment)
        );
      }
    }

    await deleteVaultDocument(vaultRoot, operation.path);
  }

  /**
   * Pushes the given operations to GitHub and reconciles the vault/outbox.
   * Transient failures stay "failed" (retryable); definitive rejections
   * (target gone, validation) become "blocked" so they are never auto-retried.
   */
  async function performSync(
    selected: OutboxOperationDocument[]
  ): Promise<SyncOutcome | null> {
    if (selected.length === 0) {
      return null;
    }

    const token = connection.token.trim();
    if (!token) {
      // Without credentials the queue is drained locally (prototype mode).
      const syncedIds = new Set(selected.map((operation) => operation.frontMatter.id));
      setOutbox((current) =>
        current.filter((operation) => !syncedIds.has(operation.frontMatter.id))
      );
      setSelectedOutboxIds(new Set());
      setShowOutbox(false);
      return { synced: selected.length, failed: 0, blocked: 0 };
    }

    setSyncing(true);
    try {
      const client = createGitHubClient({
        token,
        apiBaseUrl: connection.apiBaseUrl,
        webBaseUrl: connection.webBaseUrl
      });
      const results = await syncOutboxOperations(client, selected, items);
      await Promise.all(
        results
          .filter((result) => result.ok)
          .map((result) => applySyncedOutboxResult(result))
      );
      const syncedIds = new Set(
        results.filter((result) => result.ok).map((result) => result.operation.frontMatter.id)
      );
      const failures = new Map(
        results
          .filter((result) => !result.ok)
          .map((result) => [result.operation.frontMatter.id, result])
      );

      const operationsById = new Map(
        outbox.map((operation) => [operation.frontMatter.id, operation])
      );
      for (const operation of selected) {
        operationsById.set(operation.frontMatter.id, operation);
      }
      const failedOperations = Array.from(failures.entries()).flatMap(
        ([id, failure]) => {
          const operation = operationsById.get(id);
          if (!operation) {
            return [];
          }
          return [
            {
              ...operation,
              frontMatter: {
                ...operation.frontMatter,
                status: failure.permanent ? ("blocked" as const) : ("failed" as const),
                last_error: failure.error ?? "Sync failed."
              }
            }
          ];
        }
      );
      await Promise.all(
        failedOperations.map((operation) =>
          persistOutboxOperation(vaultRoot, operation)
        )
      );
      setOutbox((current) =>
        current
          .filter((operation) => !syncedIds.has(operation.frontMatter.id))
          .map(
            (operation) =>
              failedOperations.find(
                (failed) => failed.frontMatter.id === operation.frontMatter.id
              ) ?? operation
          )
      );
      setSelectedOutboxIds(new Set());
      return {
        synced: syncedIds.size,
        failed: failedOperations.filter(
          (operation) => operation.frontMatter.status === "failed"
        ).length,
        blocked: failedOperations.filter(
          (operation) => operation.frontMatter.status === "blocked"
        ).length
      };
    } finally {
      setSyncing(false);
    }
  }

  function describeSyncOutcome(outcome: SyncOutcome): string {
    const parts: string[] = [];
    if (outcome.synced > 0) {
      parts.push(
        `Synced ${outcome.synced} queued change${outcome.synced === 1 ? "" : "s"}`
      );
    }
    if (outcome.failed > 0) {
      parts.push(`${outcome.failed} failed`);
    }
    if (outcome.blocked > 0) {
      parts.push(`${outcome.blocked} blocked`);
    }
    return parts.join(" · ");
  }

  function refreshAfterSync(outcome: SyncOutcome) {
    if (outcome.synced === 0) {
      return;
    }
    onAfterSync();
  }

  async function syncSelectedOutbox() {
    const selected = outbox.filter((operation) =>
      selectedOutboxIds.has(operation.frontMatter.id)
    );
    const outcome = await performSync(selected);
    if (!outcome) {
      return;
    }
    refreshAfterSync(outcome);
    showAppSnackbar(describeSyncOutcome(outcome));
    if (outcome.failed === 0 && outcome.blocked === 0) {
      setShowOutbox(false);
    }
  }

  /**
   * On reconnect, confirm the configured server is actually reachable before
   * offering to flush. `navigator.onLine` (and the manual toggle) only prove a
   * network exists — an intranet GHE host can stay unreachable behind a live
   * internet connection — so we probe the real endpoint first. Only when it
   * answers do we surface the confirmation; any failure stays silent, and the
   * next offline→online transition re-evaluates.
   */
  async function promptReconnectSyncIfReachable(
    operations: OutboxOperationDocument[]
  ) {
    const reachable = await isRemoteReachable(connection);
    if (!reachable) {
      return;
    }
    setReconnectSyncPrompt({ operations, count: operations.length });
  }

  /** Reconnect flush: sync everything retryable after the user confirms. */
  async function autoFlushOutbox(operations: OutboxOperationDocument[]) {
    const outcome = await performSync(operations);
    if (!outcome) {
      return;
    }
    refreshAfterSync(outcome);
    showAppSnackbar(describeSyncOutcome(outcome));
    if (outcome.failed > 0 || outcome.blocked > 0) {
      // Leave nothing preselected: blocked entries should not be one-click
      // retried, and the user should review what went wrong.
      setSelectedOutboxIds(new Set());
      setShowOutbox(true);
    }
  }

  async function syncQueuedOperation(operation: OutboxOperationDocument) {
    if (!online || !connection.token.trim()) {
      return;
    }

    const outcome = await performSync([operation]);
    if (!outcome) {
      return;
    }
    refreshAfterSync(outcome);
    showAppSnackbar(describeSyncOutcome(outcome));
    if (outcome.failed > 0 || outcome.blocked > 0) {
      setSelectedOutboxIds(new Set([operation.frontMatter.id]));
      setShowOutbox(true);
    }
  }

  // When connectivity returns (browser event or manual toggle), queued work is
  // never sent silently: for signed-in sessions we first confirm the actual
  // remote is reachable, then ask before flushing; unsigned sessions surface
  // the queue for review so it is never forgotten. The transition is evaluated
  // once per offline→online edge (guarded by previousOnline), so a cancelled or
  // unreachable probe is not re-asked until the next reconnect.
  const previousOnline = useRef(online);
  useEffect(() => {
    if (
      online &&
      !previousOnline.current &&
      syncQueuedOnReconnect &&
      outbox.length > 0
    ) {
      const retryable = outbox.filter(
        (operation) => operation.frontMatter.status !== "blocked"
      );
      if (connection.token.trim() && retryable.length > 0) {
        void promptReconnectSyncIfReachable(retryable);
      } else if (!connection.token.trim()) {
        setSelectedOutboxIds(
          new Set(outbox.map((operation) => operation.frontMatter.id))
        );
        setShowOutbox(true);
      }
    }
    previousOnline.current = online;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, outbox, syncQueuedOnReconnect]);

  return {
    outbox,
    setOutbox,
    selectedOutboxIds,
    setSelectedOutboxIds,
    showOutbox,
    setShowOutbox,
    reconnectSyncPrompt,
    setReconnectSyncPrompt,
    syncing,
    remoteChangedOutboxIds,
    openOutbox,
    toggleOutboxSelection,
    discardOutboxOperation,
    deleteOutboxOperation,
    syncSelectedOutbox,
    autoFlushOutbox,
    syncQueuedOperation
  };
}
