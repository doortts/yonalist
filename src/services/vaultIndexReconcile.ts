import { invoke } from "@tauri-apps/api/core";
import type {
  VaultIndexScanChange,
  VaultIndexWorkerResult,
  VaultRemovedIndexPath
} from "./vaultIndex";

interface VaultIndexScan {
  changes: VaultIndexScanChange[];
  removed_paths: VaultRemovedIndexPath[];
  scanned: number;
  read: number;
  unchanged: number;
  deferred: number;
}

interface VaultIndexCommitReport {
  upserted: number;
  removed: number;
  deferred: number;
}

export interface VaultReconcileReport {
  scanned: number;
  read: number;
  unchanged: number;
  upserted: number;
  removed: number;
  deferred: number;
}

function parseInWorker(
  vaultRoot: string,
  changes: VaultIndexScanChange[]
): Promise<VaultIndexWorkerResult> {
  const worker = new Worker(new URL("./vaultIndex.worker.ts", import.meta.url), {
    type: "module"
  });
  const id = 1;
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      if (event.data.id !== id) return;
      worker.terminate();
      resolve(event.data.result as VaultIndexWorkerResult);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Vault index worker failed."));
    };
    worker.postMessage({ id, vaultRoot, changes });
  });
}

export async function reconcileVaultItemIndex(
  vaultRoot: string,
  force = false
): Promise<VaultReconcileReport> {
  const scan = await invoke<VaultIndexScan>("scan_vault_item_index_changes", {
    vaultPath: vaultRoot,
    force
  });
  if (scan.changes.length === 0 && scan.removed_paths.length === 0) {
    return {
      scanned: scan.scanned,
      read: scan.read,
      unchanged: scan.unchanged,
      upserted: 0,
      removed: 0,
      deferred: scan.deferred
    };
  }

  const parsed: VaultIndexWorkerResult = scan.changes.length
    ? await parseInWorker(vaultRoot, scan.changes)
    : { changes: [], invalidCount: 0 };
  const committed = await invoke<VaultIndexCommitReport>(
    "commit_vault_item_index_changes",
    {
      vaultPath: vaultRoot,
      changes: parsed.changes,
      removedPaths: scan.removed_paths
    }
  );
  return {
    scanned: scan.scanned,
    read: scan.read,
    unchanged: scan.unchanged,
    upserted: committed.upserted,
    removed: committed.removed,
    deferred: scan.deferred + parsed.invalidCount + committed.deferred
  };
}
