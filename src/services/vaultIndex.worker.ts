import { parseVaultIndexScanChanges } from "./vaultIndex";

interface WorkerRequest {
  id: number;
  vaultRoot: string;
  changes: import("./vaultIndex").VaultIndexScanChange[];
}

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(value: unknown): void;
};

workerScope.onmessage = ({ data }) => {
  workerScope.postMessage({
    id: data.id,
    result: parseVaultIndexScanChanges(data.vaultRoot, data.changes)
  });
};
