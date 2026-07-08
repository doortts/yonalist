export type ItemKind = "issue" | "pull" | "discussion";
export type ItemState = "open" | "closed" | "merged";
export type SyncStatus = "synced" | "pending" | "dirty" | "error" | "blocked";
export type OutboxOperationKind = "create_issue" | "create_comment";
export type OutboxStatus = "pending" | "blocked" | "syncing" | "failed" | "synced";
export type IssueCloseReason = "completed" | "not_planned" | "duplicate";
export type DiscussionCloseReason = "resolved" | "outdated" | "duplicate";
export type CommentCloseAction =
  | {
      kind: "issue";
      reason: IssueCloseReason;
      duplicate_issue_id?: number;
    }
  | {
      kind: "discussion";
      reason: DiscussionCloseReason;
    }
  | {
      kind: "pull";
    };

export interface RepositoryIdentity {
  host: string;
  owner: string;
  repo: string;
}

export interface ItemIdentity extends RepositoryIdentity {
  kind: ItemKind;
  number: number;
}

export interface LocalMetadata {
  favorite: boolean;
}

export interface SyncMetadata {
  status: SyncStatus;
  last_error?: string;
}

export interface ItemFrontMatter extends ItemIdentity {
  node_id?: string;
  html_url?: string;
  title: string;
  state: ItemState;
  author: string;
  labels: string[];
  label_colors?: Record<string, string>;
  comments_count?: number;
  created_at: string;
  updated_at: string;
  synced_at?: string;
  local: LocalMetadata;
  sync: SyncMetadata;
}

export interface CommentFrontMatter {
  kind: "comment" | "issue_comment";
  remote_id?: number;
  node_id?: string;
  parent_remote_id?: number | string;
  parent_node_id?: string;
  author: string;
  created_at: string;
  updated_at: string;
  sync: SyncMetadata;
}

export interface OutboxTarget extends RepositoryIdentity {
  kind?: ItemKind;
  number?: number;
  parent_comment_id?: number | string;
  parent_comment_node_id?: string;
}

export interface OutboxOperationFrontMatter {
  kind: "outbox_operation";
  operation: OutboxOperationKind;
  id: string;
  target: OutboxTarget;
  close_after_comment?: boolean | CommentCloseAction;
  local_file_path: string;
  created_at: string;
  status: OutboxStatus;
  last_error?: string;
}

export interface AttachmentManifestEntry {
  local_path: string;
  remote_url?: string;
  status: "cached" | "pending_remote_url" | "uploaded";
}

export interface MarkdownDocument<TFrontMatter> {
  path: string;
  frontMatter: TFrontMatter;
  body: string;
}

export type ItemDocument = MarkdownDocument<ItemFrontMatter>;
export type CommentDocument = MarkdownDocument<CommentFrontMatter>;
export type OutboxOperationDocument =
  MarkdownDocument<OutboxOperationFrontMatter>;

export interface VaultSourceDocument {
  path: string;
  contents: string;
}

export interface RepositoryIndexEntry extends RepositoryIdentity {
  key: string;
  itemCount: number;
  favoriteCount: number;
}

export interface ItemIndexEntry extends ItemIdentity {
  path: string;
  title: string;
  state: string;
  author: string;
  labels: string[];
  label_colors?: Record<string, string>;
  updated_at: string;
  favorite: boolean;
  sync_status: SyncStatus;
}

export interface VaultIndex {
  repositories: RepositoryIndexEntry[];
  items: ItemIndexEntry[];
  outbox: OutboxOperationDocument[];
}
