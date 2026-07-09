import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useState
} from "react";
import type { DraftIssue, RepositoryEntry } from "../components/NewIssuePage";
import { createIssueOutboxOperation, createOperationId } from "../domain/outbox";
import { draftIssuePath } from "../domain/paths";
import type { ItemDocument, OutboxOperationDocument } from "../domain/types";
import {
  persistItemDocument,
  persistOutboxOperation
} from "../services/vaultStore";

export interface UseDraftIssueOptions {
  vaultRoot: string;
  repositories: RepositoryEntry[];
  selectedItem: ItemDocument | undefined;
  setDrafts: Dispatch<SetStateAction<ItemDocument[]>>;
  setSelectedPath: (path: string | null) => void;
  setShowNewIssue: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  appendOutboxOperation: (operation: OutboxOperationDocument) => void;
}

/**
 * The new-issue draft flow: holds the in-progress draft, opens the composer
 * seeded with the current repository, and queues the finished draft as a
 * local item plus an outbox operation.
 */
export function useDraftIssue(options: UseDraftIssueOptions) {
  const {
    vaultRoot,
    repositories,
    selectedItem,
    setDrafts,
    setSelectedPath,
    setShowNewIssue,
    setShowSettings,
    appendOutboxOperation
  } = options;
  const [draftIssue, setDraftIssue] = useState<DraftIssue>({
    title: "",
    body: "",
    repositoryKey: ""
  });

  const openNewIssue = useCallback(() => {
    setShowSettings(false);
    setDraftIssue((current) => ({
      ...current,
      repositoryKey:
        current.repositoryKey ||
        (selectedItem
          ? `${selectedItem.frontMatter.owner}/${selectedItem.frontMatter.repo}`
          : repositories[0]?.key ?? "")
    }));
    setShowNewIssue(true);
  }, [repositories, selectedItem, setShowNewIssue, setShowSettings]);

  function queueIssue(event: FormEvent) {
    event.preventDefault();
    if (!draftIssue.title.trim()) {
      return;
    }

    const repository =
      repositories.find((entry) => entry.key === draftIssue.repositoryKey) ??
      repositories[0];
    if (!repository) {
      return;
    }

    const localId = createOperationId("issue");
    const draftPath = draftIssuePath(vaultRoot, {
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
      local_id: localId
    });
    const newItem: ItemDocument = {
      path: draftPath,
      body: draftIssue.body,
      frontMatter: {
        kind: "issue",
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
        number: 0,
        title: draftIssue.title,
        state: "open",
        author: "local",
        labels: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        local: { favorite: false },
        sync: { status: "pending" }
      }
    };
    const operation = createIssueOutboxOperation({
      id: localId,
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
      localFilePath: draftPath,
      createdAt: new Date().toISOString(),
      vaultRoot
    });
    const queuedOperation = { ...operation, body: draftIssue.title };

    void persistItemDocument(vaultRoot, newItem);
    void persistOutboxOperation(vaultRoot, queuedOperation);
    setDrafts((current) => [newItem, ...current]);
    setSelectedPath(draftPath);
    appendOutboxOperation(queuedOperation);
    setDraftIssue({ title: "", body: "", repositoryKey: "" });
    setShowNewIssue(false);
    setShowSettings(false);
  }

  return { draftIssue, setDraftIssue, openNewIssue, queueIssue };
}
