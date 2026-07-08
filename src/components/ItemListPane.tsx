import { Tabs } from "@base-ui/react/tabs";
import {
  Bookmark,
  CircleDot,
  GitPullRequest,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search
} from "lucide-react";
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { labelTextColor } from "../domain/conversation";
import type { ItemDocument } from "../domain/types";
import { type AuthorProfile, useAuthorNames } from "../hooks/useAuthorNames";
import { timeAgo } from "../timeFormat";
import { Avatar } from "./Avatar";
import "./ItemListPane.css";
import "./ui/tabs.css";

export type ItemStateFilter = "open" | "closed";

const VIRTUALIZE_AT = 80;
// Virtualized rows use deterministic per-item heights so rows without labels do
// not reserve the optional label line. These are intentionally estimates, not
// measured layout, so scroll math stays cheap and stable.
const ITEM_ROW_HEIGHT_WITH_LABELS = 140;
const ITEM_ROW_HEIGHT_COMPACT = 112;
const ITEM_OVERSCAN = 6;

interface ItemStateCounts {
  open: number;
  closed: number;
}

interface ItemListPaneProps {
  items: ItemDocument[];
  selectedPath: string | null;
  stateFilter: ItemStateFilter;
  stateCounts?: ItemStateCounts;
  query: string;
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  online?: boolean;
  onStateFilterChange: (filter: ItemStateFilter) => void;
  onQueryChange: (query: string) => void;
  onSelect: (path: string) => void;
  onVisibleItemsChange?: (items: ItemDocument[]) => void;
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
  // The kind text label was dropped from the meta line, so the icon carries the
  // kind's accessible name on its own.
  const label = itemTypeLabel(item);
  switch (item.frontMatter.kind) {
    case "pull":
      return <GitPullRequest size={15} role="img" aria-label={label} />;
    case "discussion":
      return <MessagesSquare size={15} role="img" aria-label={label} />;
    default:
      return <CircleDot size={15} role="img" aria-label={label} />;
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

function itemListSignature(items: ItemDocument[]): string {
  return items
    .map((item) => `${item.path}|${item.frontMatter.updated_at}`)
    .join("\n");
}

function virtualRowHeightForItem(item: ItemDocument): number {
  return item.frontMatter.labels.length > 0
    ? ITEM_ROW_HEIGHT_WITH_LABELS
    : ITEM_ROW_HEIGHT_COMPACT;
}

interface VirtualRowMetrics {
  heights: number[];
  offsets: number[];
  totalHeight: number;
}

function buildVirtualRowMetrics(items: ItemDocument[]): VirtualRowMetrics {
  const heights: number[] = [];
  const offsets: number[] = [];
  let totalHeight = 0;

  for (const item of items) {
    offsets.push(totalHeight);
    const height = virtualRowHeightForItem(item);
    heights.push(height);
    totalHeight += height;
  }

  return { heights, offsets, totalHeight };
}

function rowIndexForOffset(metrics: VirtualRowMetrics, offset: number): number {
  if (metrics.offsets.length === 0) {
    return 0;
  }

  let low = 0;
  let high = metrics.offsets.length - 1;
  let result = 0;
  const target = Math.max(0, offset);

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (metrics.offsets[mid] <= target) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

export function ItemListPane({
  items,
  selectedPath,
  stateFilter,
  stateCounts,
  query,
  loading,
  error,
  demoMode,
  online = true,
  onStateFilterChange,
  onQueryChange,
  onSelect,
  onVisibleItemsChange,
  onNewIssue,
  onRefresh
}: ItemListPaneProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Login → display name for the authors in view. Demo/offline sessions skip
  // the fetch and fall back to the raw login (see useAuthorNames).
  const authorNames = useAuthorNames(items, { enabled: !demoMode && online });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const listIdentity = useMemo(
    () => items.map((item) => item.path).join("\n"),
    [items]
  );
  const counts =
    stateCounts ??
    items.reduce<ItemStateCounts>(
      (result, item) => {
        if (item.frontMatter.state === "open") {
          result.open += 1;
        } else if (
          item.frontMatter.state === "closed" ||
          item.frontMatter.state === "merged"
        ) {
          result.closed += 1;
        }
        return result;
      },
      { open: 0, closed: 0 }
    );

  useEffect(() => {
    updateViewportHeight();
    const node = listRef.current;
    if (!node) {
      return;
    }
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewportHeight);
      return () => window.removeEventListener("resize", updateViewportHeight);
    }
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = listRef.current;
    if (node) {
      node.scrollTop = 0;
    }
    setScrollTop(0);
  }, [listIdentity, query, stateFilter]);

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

      <Tabs.Root
        className="item-state-tabs-root"
        value={stateFilter}
        onValueChange={(value) => onStateFilterChange(value as ItemStateFilter)}
      >
        <Tabs.List className="item-state-row" aria-label="Item state">
          <span
            className="item-state-line item-state-line-start"
            aria-hidden="true"
          />
          <Tabs.Tab
            value="open"
            className={(state) =>
              state.active ? "item-state-tab active" : "item-state-tab"
            }
          >
            <span>Open</span>
            <span className="item-state-count">{counts.open}</span>
          </Tabs.Tab>
          <span
            className="item-state-line item-state-line-between"
            aria-hidden="true"
          />
          <Tabs.Tab
            value="closed"
            className={(state) =>
              state.active ? "item-state-tab active" : "item-state-tab"
            }
          >
            <span>Closed</span>
            <span className="item-state-count">{counts.closed}</span>
          </Tabs.Tab>
          <span
            className="item-state-line item-state-line-end"
            aria-hidden="true"
          />
        </Tabs.List>
      </Tabs.Root>

      {demoMode && (
        <p className="list-note">Sample items. Sign in from Settings to load yours.</p>
      )}
      {error && <p className="list-error">{error}</p>}

      <div
        className={items.length > VIRTUALIZE_AT ? "item-list virtualized" : "item-list"}
        ref={listRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {items.length === 0 && !loading && (
          <p className="empty-copy list-empty">No items match this view.</p>
        )}
        {items.length === 0 && loading && (
          <p className="empty-copy list-empty">Loading items...</p>
        )}
        <ItemRows
          items={items}
          authorNames={authorNames}
          selectedPath={selectedPath}
          scrollTop={scrollTop}
          viewportHeight={viewportHeight}
          onSelect={onSelect}
          onVisibleItemsChange={onVisibleItemsChange}
        />
      </div>
    </section>
  );

  function updateViewportHeight() {
    setViewportHeight(listRef.current?.clientHeight ?? 0);
  }
}

interface ItemRowsProps {
  items: ItemDocument[];
  authorNames: ReadonlyMap<string, AuthorProfile>;
  selectedPath: string | null;
  scrollTop: number;
  viewportHeight: number;
  onSelect: (path: string) => void;
  onVisibleItemsChange?: (items: ItemDocument[]) => void;
}

function ItemRows({
  items,
  authorNames,
  selectedPath,
  scrollTop,
  viewportHeight,
  onSelect,
  onVisibleItemsChange
}: ItemRowsProps) {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRow = useCallback(
    (path: string, node: HTMLButtonElement | null) => {
      if (node) {
        rowRefs.current.set(path, node);
      } else {
        rowRefs.current.delete(path);
      }
    },
    []
  );
  const [measuredViewportItems, setMeasuredViewportItems] = useState<
    ItemDocument[] | null
  >(null);
  const shouldVirtualize = items.length > VIRTUALIZE_AT && viewportHeight > 0;
  const rowMetrics = useMemo(() => buildVirtualRowMetrics(items), [items]);
  const viewportRange = useMemo(() => {
    if (viewportHeight <= 0) {
      return { start: 0, end: items.length };
    }
    const start = rowIndexForOffset(rowMetrics, scrollTop);
    const end = Math.min(
      items.length,
      Math.max(start + 1, rowIndexForOffset(rowMetrics, scrollTop + viewportHeight) + 1)
    );
    return { start, end };
  }, [items.length, rowMetrics, scrollTop, viewportHeight]);
  const range = useMemo(() => {
    if (!shouldVirtualize) {
      return { start: 0, end: items.length };
    }
    const visibleStart = rowIndexForOffset(rowMetrics, scrollTop);
    const visibleEnd = rowIndexForOffset(rowMetrics, scrollTop + viewportHeight) + 1;
    const start = Math.max(0, visibleStart - ITEM_OVERSCAN);
    const end = Math.min(
      items.length,
      visibleEnd + ITEM_OVERSCAN
    );
    return { start, end };
  }, [items.length, rowMetrics, scrollTop, shouldVirtualize, viewportHeight]);

  const visibleItems = shouldVirtualize
    ? items.slice(range.start, range.end)
    : items;
  const estimatedViewportItems = useMemo(
    () => items.slice(viewportRange.start, viewportRange.end),
    [items, viewportRange.end, viewportRange.start]
  );
  const estimatedViewportSignature = itemListSignature(estimatedViewportItems);
  const viewportItems = shouldVirtualize
    ? estimatedViewportItems
    : (measuredViewportItems ?? estimatedViewportItems);
  const viewportSignature = itemListSignature(viewportItems);

  useEffect(() => {
    if (shouldVirtualize || viewportHeight <= 0) {
      setMeasuredViewportItems((current) => (current === null ? current : null));
      return;
    }

    const viewportBottom = scrollTop + viewportHeight;
    const next = items.filter((item) => {
      const row = rowRefs.current.get(item.path);
      if (!row || row.offsetHeight <= 0) {
        return false;
      }
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      return bottom > scrollTop && top < viewportBottom;
    });
    const visibleByDom = next.length > 0 ? next : estimatedViewportItems;
    const nextSignature = itemListSignature(visibleByDom);
    setMeasuredViewportItems((current) =>
      current && itemListSignature(current) === nextSignature ? current : visibleByDom
    );
  }, [
    estimatedViewportItems,
    estimatedViewportSignature,
    items,
    scrollTop,
    shouldVirtualize,
    viewportHeight
  ]);

  useEffect(() => {
    onVisibleItemsChange?.(viewportItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onVisibleItemsChange, viewportSignature]);

  if (items.length === 0) {
    return null;
  }

  const rows = visibleItems.map((item, offset) => {
    const index = range.start + offset;
    const author = item.frontMatter.author;
    // Resolve to stable strings so the memoized row only re-renders when the
    // display name or avatar URL actually changes (login stays referentially
    // identical until its profile loads).
    const authorProfile = author ? authorNames.get(author) : undefined;
    const authorName = authorProfile?.name || author;
    const authorAvatarUrl = authorProfile?.avatarUrl;
    return (
      <ItemRow
        key={item.path}
        item={item}
        authorName={authorName}
        authorAvatarUrl={authorAvatarUrl}
        selected={item.path === selectedPath}
        virtualized={shouldVirtualize}
        top={shouldVirtualize ? rowMetrics.offsets[index] : null}
        height={shouldVirtualize ? rowMetrics.heights[index] : null}
        onSelect={onSelect}
        registerRow={registerRow}
      />
    );
  });

  if (!shouldVirtualize) {
    return <>{rows}</>;
  }

  return (
    <div
      className="item-list-virtual-space"
      style={{ height: rowMetrics.totalHeight }}
    >
      {rows}
    </div>
  );
}

interface ItemRowProps {
  item: ItemDocument;
  authorName: string;
  authorAvatarUrl?: string;
  selected: boolean;
  virtualized: boolean;
  top: number | null;
  height: number | null;
  onSelect: (path: string) => void;
  registerRow: (path: string, node: HTMLButtonElement | null) => void;
}

const ItemRow = memo(function ItemRow({
  item,
  authorName,
  authorAvatarUrl,
  selected,
  virtualized,
  top,
  height,
  onSelect,
  registerRow
}: ItemRowProps) {
  const virtualStyle =
    virtualized && top !== null && height !== null
      ? ({
          height,
          transform: `translateY(${top}px)`
        } as CSSProperties)
      : undefined;
  const commentCount = item.frontMatter.comments_count ?? 0;
  const showComments = commentCount > 0;
  const showBookmark = item.frontMatter.local.favorite;
  const hasAuthor =
    Boolean(item.frontMatter.author) && item.frontMatter.author !== "unknown";
  const hasLabels = item.frontMatter.labels.length > 0;
  const showActions = showComments || showBookmark;
  const showActionsOnAuthor = showActions && hasAuthor && !hasLabels;
  const showActionsOnLabels = showActions && hasLabels;
  const showFooter = showActions && !showActionsOnAuthor && !showActionsOnLabels;
  const rowActions = showActions ? (
    <span className="item-row-actions">
      {showComments && (
        <span className="item-comments">
          <span className="yona-comment-icon" aria-hidden="true" />
          {commentCount}
        </span>
      )}
      {showBookmark && (
        <Bookmark className="small-bookmark" size={14} fill="currentColor" />
      )}
    </span>
  ) : null;
  return (
    <button
      type="button"
      className={[
        selected ? "item-card selected" : "item-card",
        virtualized ? "virtual-row" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      ref={(node) => registerRow(item.path, node)}
      style={virtualStyle}
      onClick={() => onSelect(item.path)}
    >
      <span className="item-meta">
        {kindIcon(item)}
        {item.frontMatter.repo && (
          <span className="item-repo">{item.frontMatter.repo}</span>
        )}
        <span className="item-number">#{item.frontMatter.number || "draft"}</span>
        {item.frontMatter.sync.status === "pending" && (
          <span className="item-sync-pending">Pending</span>
        )}
        <span className="item-time">{timeAgo(item.frontMatter.updated_at)}</span>
      </span>
      <span className="item-title">{item.frontMatter.title}</span>
      {hasAuthor && (
        <span className="item-author">
          {authorAvatarUrl && (
            <Avatar
              login={item.frontMatter.author}
              avatarUrl={authorAvatarUrl}
              size={16}
              showFallback={false}
            />
          )}
          <span className="item-author-name">{authorName}</span>
          {showActionsOnAuthor && rowActions}
        </span>
      )}
      {hasLabels && (
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
          {showActionsOnLabels && rowActions}
        </span>
      )}
      {showFooter && (
        <span className="item-footer">
          {rowActions}
        </span>
      )}
    </button>
  );
});
