import {
  Bookmark,
  CircleDot,
  GitPullRequest,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search
} from "lucide-react";
import type { CSSProperties } from "react";
import { labelTextColor } from "../domain/conversation";
import type { ItemDocument } from "../domain/types";
import { timeAgo } from "../timeFormat";

export type ItemStateFilter = "open" | "closed";

interface ItemListPaneProps {
  items: ItemDocument[];
  selectedPath: string | null;
  stateFilter: ItemStateFilter;
  query: string;
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  onStateFilterChange: (filter: ItemStateFilter) => void;
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

function labelColorStyle(
  item: ItemDocument,
  label: string
): CSSProperties | undefined {
  const color = item.frontMatter.label_colors?.[label]?.replace(/^#/, "");
  if (!color || !/^[0-9a-fA-F]{6}$/.test(color)) {
    return undefined;
  }
  const background = `#${color}`;
  return {
    backgroundColor: background,
    borderColor: background,
    color: labelTextColor(color)
  };
}

export function ItemListPane({
  items,
  selectedPath,
  stateFilter,
  query,
  loading,
  error,
  demoMode,
  onStateFilterChange,
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

      <div className="item-state-row" role="group" aria-label="Item state">
        <button
          type="button"
          className={
            stateFilter === "open" ? "item-state-tab active" : "item-state-tab"
          }
          aria-pressed={stateFilter === "open"}
          onClick={() => onStateFilterChange("open")}
        >
          Opened
        </button>
        <button
          type="button"
          className={
            stateFilter === "closed" ? "item-state-tab active" : "item-state-tab"
          }
          aria-pressed={stateFilter === "closed"}
          onClick={() => onStateFilterChange("closed")}
        >
          Closed
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
              {item.frontMatter.sync.status === "pending" && (
                <span className="item-sync-pending">Pending</span>
              )}
              <span className="item-time">{timeAgo(item.frontMatter.updated_at)}</span>
            </span>
            <span className="item-title">{item.frontMatter.title}</span>
            {item.frontMatter.labels.length > 0 && (
              <span className="item-labels">
                {item.frontMatter.labels.slice(0, 4).map((label) => (
                  <span
                    className={
                      item.frontMatter.label_colors?.[label]
                        ? "item-label colored"
                        : "item-label"
                    }
                    key={label}
                    style={labelColorStyle(item, label)}
                  >
                    {label}
                  </span>
                ))}
              </span>
            )}
            <span className="item-footer">
              <span className="item-repo">
                {item.frontMatter.owner}/{item.frontMatter.repo}
              </span>
              {item.frontMatter.comments_count !== undefined &&
                item.frontMatter.comments_count > 0 && (
                  <span className="item-comments">
                    <span className="yona-comment-icon" aria-hidden="true" />
                    {item.frontMatter.comments_count}
                  </span>
                )}
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
