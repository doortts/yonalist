import { Menu } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import {
  Bookmark,
  Check,
  CircleDot,
  GitPullRequest,
  MessageSquare,
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
import { dateGroupLabel, localDateKey } from "../domain/dateGroups";
import {
  DEFAULT_ITEM_SORT,
  type ItemSort,
  type ItemSortDirection,
  type ItemSortField
} from "../domain/items";
import type { ItemDocument } from "../domain/types";
import { type AuthorProfile, useAuthorNames } from "../hooks/useAuthorNames";
import { timeAgo } from "../timeFormat";
import { Avatar } from "./Avatar";
import "./ItemListPane.css";
import "./ui/tabs.css";

export type ItemStateFilter = "open" | "closed";

const VIRTUALIZE_AT = 30;
const INITIAL_VIRTUAL_VIEWPORT_HEIGHT = 900;
// Virtualized rows use deterministic per-item heights so rows without labels do
// not reserve the optional label line. These are intentionally estimates, not
// measured layout, so scroll math stays cheap and stable.
const ITEM_ROW_HEIGHT_WITH_LABELS = 104;
const ITEM_ROW_HEIGHT_COMPACT = 80;
const ITEM_DATE_HEADER_HEIGHT = 34;
const ITEM_LABEL_EXTRA_LINE_HEIGHT = 22;
const ITEM_LABEL_TEXT_BUDGET_PER_LINE = 32;
const ITEM_OVERSCAN = 6;

const ITEM_SORT_OPTIONS: Array<{
  sort: ItemSort;
  label: string;
  ariaLabel: string;
}> = [
  {
    sort: { field: "created", direction: "desc" },
    label: "↓ Created",
    ariaLabel: "Created descending"
  },
  {
    sort: { field: "created", direction: "asc" },
    label: "↑ Created",
    ariaLabel: "Created ascending"
  },
  {
    sort: { field: "updated", direction: "desc" },
    label: "↓ Updated",
    ariaLabel: "Updated descending"
  },
  {
    sort: { field: "updated", direction: "asc" },
    label: "↑ Updated",
    ariaLabel: "Updated ascending"
  }
];

interface ItemStateCounts {
  open: number;
  closed: number;
}

interface ItemListPaneProps {
  items: ItemDocument[];
  selectedPath: string | null;
  stateFilter: ItemStateFilter;
  stateCounts?: ItemStateCounts;
  itemSort?: ItemSort;
  query: string;
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  online?: boolean;
  onItemSortChange?: (sort: ItemSort) => void;
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

function itemSortEquals(left: ItemSort, right: ItemSort): boolean {
  return left.field === right.field && left.direction === right.direction;
}

function sortFieldLabel(field: ItemSortField): string {
  return field === "created" ? "Created" : "Updated";
}

function sortDirectionArrow(direction: ItemSortDirection): string {
  return direction === "asc" ? "↑" : "↓";
}

function itemSortTriggerText(sort: ItemSort): string {
  return `${sortDirectionArrow(sort.direction)}${sortFieldLabel(sort.field)}`;
}

function itemSortAriaLabel(sort: ItemSort): string {
  return `Sort by ${sortFieldLabel(sort.field)} ${
    sort.direction === "asc" ? "ascending" : "descending"
  }`;
}

function itemDateValue(item: ItemDocument, sort: ItemSort): string {
  return sort.field === "created"
    ? item.frontMatter.created_at
    : item.frontMatter.updated_at;
}

type ItemListEntry =
  | { type: "date"; key: string; label: string }
  | { type: "item"; item: ItemDocument };

function buildItemListEntries(
  items: ItemDocument[],
  sort: ItemSort
): ItemListEntry[] {
  const entries: ItemListEntry[] = [];
  let previousDateKey: string | null = null;

  for (const item of items) {
    const key = localDateKey(itemDateValue(item, sort));
    if (key !== previousDateKey) {
      entries.push({ type: "date", key, label: dateGroupLabel(key) });
      previousDateKey = key;
    }
    entries.push({ type: "item", item });
  }

  return entries;
}

function estimatedVisibleLabelLines(labels: string[]): number {
  const visibleLabels = labels.slice(0, 4);
  if (visibleLabels.length === 0) {
    return 0;
  }
  const estimatedUnits = visibleLabels.reduce(
    (total, label) => total + Math.max(8, label.length + 4),
    0
  );
  return Math.max(
    1,
    Math.ceil(estimatedUnits / ITEM_LABEL_TEXT_BUDGET_PER_LINE)
  );
}

function virtualRowHeightForEntry(entry: ItemListEntry): number {
  if (entry.type === "date") {
    return ITEM_DATE_HEADER_HEIGHT;
  }
  const item = entry.item;
  const labelLines = estimatedVisibleLabelLines(item.frontMatter.labels);
  if (labelLines === 0) {
    return ITEM_ROW_HEIGHT_COMPACT;
  }
  return (
    ITEM_ROW_HEIGHT_WITH_LABELS +
    (labelLines - 1) * ITEM_LABEL_EXTRA_LINE_HEIGHT
  );
}

interface VirtualRowMetrics {
  heights: number[];
  offsets: number[];
  totalHeight: number;
}

function buildVirtualRowMetrics(entries: ItemListEntry[]): VirtualRowMetrics {
  const heights: number[] = [];
  const offsets: number[] = [];
  let totalHeight = 0;

  for (const entry of entries) {
    offsets.push(totalHeight);
    const height = virtualRowHeightForEntry(entry);
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
  itemSort = DEFAULT_ITEM_SORT,
  query,
  loading,
  error,
  demoMode,
  online = true,
  onItemSortChange,
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
  const [viewportHeight, setViewportHeight] = useState(
    INITIAL_VIRTUAL_VIEWPORT_HEIGHT
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
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
          <span className="item-state-sort-spacer" aria-hidden="true" />
          <Menu.Root open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
            <Menu.Trigger
              className="item-sort-trigger"
              type="button"
              aria-label={itemSortAriaLabel(itemSort)}
              onClick={() => setSortMenuOpen(true)}
            >
              {itemSortTriggerText(itemSort)}
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={6}>
                <Menu.Popup className="item-sort-menu">
                  {ITEM_SORT_OPTIONS.map((option) => {
                    const selected = itemSortEquals(itemSort, option.sort);
                    return (
                      <Menu.Item
                        key={`${option.sort.field}-${option.sort.direction}`}
                        className="item-sort-menu-item"
                        onClick={() => {
                          onItemSortChange?.(option.sort);
                          setSortMenuOpen(false);
                        }}
                      >
                        <span className="item-sort-menu-check" aria-hidden="true">
                          {selected && <Check size={15} />}
                        </span>
                        <span>{option.label}</span>
                      </Menu.Item>
                    );
                  })}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
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
          itemSort={itemSort}
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
    const measuredHeight = listRef.current?.clientHeight ?? 0;
    if (measuredHeight > 0) {
      setViewportHeight(measuredHeight);
    }
  }
}

interface ItemRowsProps {
  items: ItemDocument[];
  authorNames: ReadonlyMap<string, AuthorProfile>;
  itemSort: ItemSort;
  selectedPath: string | null;
  scrollTop: number;
  viewportHeight: number;
  onSelect: (path: string) => void;
  onVisibleItemsChange?: (items: ItemDocument[]) => void;
}

function ItemRows({
  items,
  authorNames,
  itemSort,
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
  const entries = useMemo(
    () => buildItemListEntries(items, itemSort),
    [items, itemSort]
  );
  const shouldVirtualize = items.length > VIRTUALIZE_AT && viewportHeight > 0;
  const rowMetrics = useMemo(() => buildVirtualRowMetrics(entries), [entries]);
  const viewportRange = useMemo(() => {
    if (viewportHeight <= 0) {
      return { start: 0, end: entries.length };
    }
    const start = rowIndexForOffset(rowMetrics, scrollTop);
    const end = Math.min(
      entries.length,
      Math.max(start + 1, rowIndexForOffset(rowMetrics, scrollTop + viewportHeight) + 1)
    );
    return { start, end };
  }, [entries.length, rowMetrics, scrollTop, viewportHeight]);
  const range = useMemo(() => {
    if (!shouldVirtualize) {
      return { start: 0, end: entries.length };
    }
    const visibleStart = rowIndexForOffset(rowMetrics, scrollTop);
    const visibleEnd = rowIndexForOffset(rowMetrics, scrollTop + viewportHeight) + 1;
    const start = Math.max(0, visibleStart - ITEM_OVERSCAN);
    const end = Math.min(
      entries.length,
      visibleEnd + ITEM_OVERSCAN
    );
    return { start, end };
  }, [entries.length, rowMetrics, scrollTop, shouldVirtualize, viewportHeight]);

  const visibleEntries = shouldVirtualize
    ? entries.slice(range.start, range.end)
    : entries;
  const estimatedViewportItems = useMemo(
    () =>
      entries
        .slice(viewportRange.start, viewportRange.end)
        .flatMap((entry) => (entry.type === "item" ? [entry.item] : [])),
    [entries, viewportRange.end, viewportRange.start]
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

  const rows = visibleEntries.map((entry, offset) => {
    const index = range.start + offset;
    if (entry.type === "date") {
      return (
        <ItemDateRow
          key={`date-${entry.key}-${index}`}
          label={entry.label}
          virtualized={shouldVirtualize}
          top={shouldVirtualize ? rowMetrics.offsets[index] : null}
          height={shouldVirtualize ? rowMetrics.heights[index] : null}
        />
      );
    }
    const item = entry.item;
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
        itemSort={itemSort}
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

interface ItemDateRowProps {
  label: string;
  virtualized: boolean;
  top: number | null;
  height: number | null;
}

function ItemDateRow({ label, virtualized, top, height }: ItemDateRowProps) {
  const virtualStyle =
    virtualized && top !== null && height !== null
      ? ({
          height,
          transform: `translateY(${top}px)`
        } as CSSProperties)
      : undefined;
  return (
    <div
      className={
        virtualized ? "item-date-row virtual-date-row" : "item-date-row"
      }
      style={virtualStyle}
    >
      <h3>{label}</h3>
    </div>
  );
}

interface ItemRowProps {
  item: ItemDocument;
  authorName: string;
  authorAvatarUrl?: string;
  itemSort: ItemSort;
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
  itemSort,
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
  const rowTime = itemDateValue(item, itemSort);
  const showComments = commentCount > 0;
  const showBookmark = item.frontMatter.local.favorite;
  const hasAuthor =
    Boolean(item.frontMatter.author) && item.frontMatter.author !== "unknown";
  const hasLabels = item.frontMatter.labels.length > 0;
  const showActions = showComments || showBookmark;
  const showActionsOnAuthor = showActions && hasAuthor;
  const showActionsOnLabels = showActions && !hasAuthor && hasLabels;
  const showFooter = showActions && !showActionsOnAuthor && !showActionsOnLabels;
  const rowActions = showActions ? (
    <span className="item-row-actions">
      {showComments && (
        <span className="item-comments">
          <MessageSquare className="yona-comment-icon" size={13} aria-hidden="true" />
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
        <span className="item-time">{timeAgo(rowTime)}</span>
      </span>
      <span className="item-title">{item.frontMatter.title}</span>
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
      {showFooter && (
        <span className="item-footer">
          {rowActions}
        </span>
      )}
    </button>
  );
});
