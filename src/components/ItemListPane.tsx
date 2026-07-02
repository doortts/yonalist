import {
  Bookmark,
  CircleDot,
  GitPullRequest,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search
} from "lucide-react";
import type { ItemDocument } from "../domain/types";
import { timeAgo } from "../timeFormat";

interface ItemListPaneProps {
  items: ItemDocument[];
  selectedPath: string | null;
  query: string;
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (path: string) => void;
  onNewIssue: () => void;
  onRefresh: () => void;
}

export function itemTypeLabel(item: ItemDocument): string {
  switch (item.frontMatter.kind) {
    case "pull":
      return "PR";
    case "discussion":
      return "Discussion";
    default:
      return "Issue";
  }
}

function kindIcon(item: ItemDocument) {
  switch (item.frontMatter.kind) {
    case "pull":
      return <GitPullRequest size={15} />;
    case "discussion":
      return <MessagesSquare size={15} />;
    default:
      return <CircleDot size={15} />;
  }
}

export function ItemListPane({
  items,
  selectedPath,
  query,
  loading,
  error,
  demoMode,
  onQueryChange,
  onSelect,
  onNewIssue,
  onRefresh
}: ItemListPaneProps) {
  return (
    <section className="list-pane" aria-label="Items">
      <div className="pane-titlebar-spacer" />
      <div className="search-row">
        <Search size={18} />
        <input
          aria-label="Search"
          placeholder="Search..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <button
          className="icon-button list-refresh"
          type="button"
          aria-label="Refresh items"
          disabled={demoMode}
          onClick={onRefresh}
        >
          <RefreshCw size={15} className={loading ? "spinning" : undefined} />
        </button>
        <button className="text-button" type="button" onClick={onNewIssue}>
          <Plus size={17} />
          New issue
        </button>
      </div>

      {demoMode && (
        <p className="list-note">Sample items. Sign in from Settings to load yours.</p>
      )}
      {error && <p className="list-error">{error}</p>}

      <div className="item-list">
        {items.length === 0 && !loading && (
          <p className="empty-copy list-empty">No items match this view.</p>
        )}
        {items.length === 0 && loading && (
          <p className="empty-copy list-empty">Loading items...</p>
        )}
        {items.map((item) => (
          <button
            type="button"
            className={item.path === selectedPath ? "item-card selected" : "item-card"}
            key={item.path}
            onClick={() => onSelect(item.path)}
          >
            <span className="item-meta">
              {kindIcon(item)}
              {itemTypeLabel(item)} #{item.frontMatter.number || "draft"}
              <span className="item-time">{timeAgo(item.frontMatter.updated_at)}</span>
            </span>
            <span className="item-title">{item.frontMatter.title}</span>
            <span className="item-footer">
              {item.frontMatter.owner}/{item.frontMatter.repo}
              {item.frontMatter.local.favorite && (
                <Bookmark className="small-bookmark" size={14} fill="currentColor" />
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
