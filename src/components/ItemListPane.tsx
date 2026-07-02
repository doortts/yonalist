import { Bookmark, CircleDot, GitPullRequest, Plus, Search } from "lucide-react";
import type { ItemDocument } from "../domain/types";

interface ItemListPaneProps {
  items: ItemDocument[];
  selectedPath: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (path: string) => void;
  onNewIssue: () => void;
}

export function itemTypeLabel(item: ItemDocument): string {
  return item.frontMatter.kind === "pull" ? "PR" : "Issue";
}

export function ItemListPane({
  items,
  selectedPath,
  query,
  onQueryChange,
  onSelect,
  onNewIssue
}: ItemListPaneProps) {
  return (
    <section className="list-pane" aria-label="Items">
      <div className="search-row">
        <Search size={18} />
        <input
          aria-label="Search"
          placeholder="Search..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <button className="text-button" type="button" onClick={onNewIssue}>
          <Plus size={17} />
          New issue
        </button>
      </div>

      <div className="item-list">
        {items.length === 0 && (
          <p className="empty-copy list-empty">No items match this view.</p>
        )}
        {items.map((item) => (
          <button
            type="button"
            className={item.path === selectedPath ? "item-card selected" : "item-card"}
            key={item.path}
            onClick={() => onSelect(item.path)}
          >
            <span className="item-meta">
              {item.frontMatter.kind === "pull" ? (
                <GitPullRequest size={15} />
              ) : (
                <CircleDot size={15} />
              )}
              {itemTypeLabel(item)} #{item.frontMatter.number || "draft"}
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
