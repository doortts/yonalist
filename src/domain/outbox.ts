import { outboxOperationPath } from "./paths";
import type {
  AttachmentManifestEntry,
  ItemKind,
  OutboxOperationDocument,
  RepositoryIdentity
} from "./types";

interface CreateIssueOperationInput extends RepositoryIdentity {
  id: string;
  localFilePath: string;
  createdAt: string;
  vaultRoot?: string;
}

interface CreateCommentOperationInput extends RepositoryIdentity {
  id: string;
  itemKind: ItemKind;
  number: number;
  parentCommentId?: number | string;
  parentCommentNodeId?: string;
  closeAfterComment?: boolean;
  localFilePath: string;
  createdAt: string;
  vaultRoot?: string;
}

export function createIssueOutboxOperation(
  input: CreateIssueOperationInput
): OutboxOperationDocument {
  return {
    path: outboxOperationPath(input.vaultRoot ?? "", input.id),
    body: "",
    frontMatter: {
      kind: "outbox_operation",
      operation: "create_issue",
      id: input.id,
      target: {
        host: input.host,
        owner: input.owner,
        repo: input.repo
      },
      local_file_path: input.localFilePath,
      created_at: input.createdAt,
      status: "pending"
    }
  };
}

export function createCommentOutboxOperation(
  input: CreateCommentOperationInput
): OutboxOperationDocument {
  return {
    path: outboxOperationPath(input.vaultRoot ?? "", input.id),
    body: "",
    frontMatter: {
      kind: "outbox_operation",
      operation: "create_comment",
      id: input.id,
      target: {
        host: input.host,
        owner: input.owner,
        repo: input.repo,
        kind: input.itemKind,
        number: input.number,
        ...(input.parentCommentId !== undefined
          ? { parent_comment_id: input.parentCommentId }
          : {}),
        ...(input.parentCommentNodeId
          ? { parent_comment_node_id: input.parentCommentNodeId }
          : {})
      },
      ...(input.closeAfterComment ? { close_after_comment: true } : {}),
      local_file_path: input.localFilePath,
      created_at: input.createdAt,
      status: "pending"
    }
  };
}

export function hasUnresolvedLocalAttachments(
  attachments: AttachmentManifestEntry[]
): boolean {
  return attachments.some(
    (attachment) =>
      attachment.status === "pending_remote_url" && !attachment.remote_url
  );
}
