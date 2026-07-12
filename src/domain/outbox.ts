import { outboxOperationPath } from "./paths";
import type {
  AttachmentManifestEntry,
  CommentCloseAction,
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
  closeAfterComment?:
    | boolean
    | (Omit<Extract<CommentCloseAction, { kind: "issue" }>, "duplicate_issue_id"> & {
        duplicateIssueId?: number;
      })
    | Extract<CommentCloseAction, { kind: "discussion" | "pull" }>;
  localFilePath: string;
  createdAt: string;
  vaultRoot?: string;
}

/** Unique id for a freshly queued operation, prefixed by its kind. */
export function createOperationId(prefix: string): string {
  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${unique}`;
}

function closeAfterCommentFrontMatter(
  closeAfterComment: CreateCommentOperationInput["closeAfterComment"]
): boolean | CommentCloseAction | undefined {
  if (!closeAfterComment) {
    return undefined;
  }
  if (closeAfterComment === true) {
    return true;
  }
  if (closeAfterComment.kind === "issue") {
    return {
      kind: "issue",
      reason: closeAfterComment.reason,
      ...(closeAfterComment.duplicateIssueId !== undefined
        ? { duplicate_issue_id: closeAfterComment.duplicateIssueId }
        : {})
    };
  }
  return closeAfterComment;
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
  const closeAfterComment = closeAfterCommentFrontMatter(
    input.closeAfterComment
  );
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
      ...(closeAfterComment
        ? { close_after_comment: closeAfterComment }
        : {}),
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
