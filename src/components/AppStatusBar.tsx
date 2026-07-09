import { Inbox } from "lucide-react";
import { IconTooltip } from "./ui/Tooltip";

export interface StatusBarMetrics {
  listFetchDurationMs: number | null;
  detailDisplayDurationMs: number | null;
  prefetch: {
    enabled: boolean;
    visible: number;
    queued: number;
    active: number;
    cached: number;
    completed: number;
    totalDurationMs: number;
    lastDurationMs: number | null;
  };
  caches: Array<{
    label: string;
    entries: number;
    bytes: number;
  }>;
}

interface AppStatusBarProps {
  outboxCount: number;
  online: boolean;
  syncing: boolean;
  metrics: StatusBarMetrics;
  onOpenOutbox: () => void;
}

export function AppStatusBar({
  outboxCount,
  online,
  syncing,
  metrics,
  onOpenOutbox
}: AppStatusBarProps) {
  return (
    <footer className="app-statusbar" aria-label="Status bar">
      <div className="statusbar-metrics" aria-label="Performance metrics">
        <span>{`List ${formatMs(metrics.listFetchDurationMs)}`}</span>
        <span>{`Item ${formatMs(metrics.detailDisplayDurationMs)}`}</span>
        <span>{prefetchLabel(metrics.prefetch)}</span>
        <span title={cacheLabel(metrics.caches)}>
          {cacheLabel(metrics.caches)}
        </span>
      </div>
      <div className="statusbar-actions">
        <span className="statusbar-state">
          {syncing ? "Syncing" : online ? "Online" : "Offline"}
        </span>
        <IconTooltip label="Outbox stores offline issues and comments waiting to sync to GitHub.">
          <button
            className="status-outbox-button"
            type="button"
            aria-label={`Open outbox, ${outboxCount} pending ${
              outboxCount === 1 ? "change" : "changes"
            }`}
            onClick={onOpenOutbox}
          >
            <Inbox size={14} />
            <span>Outbox {outboxCount}</span>
          </button>
        </IconTooltip>
      </div>
    </footer>
  );
}

function formatMs(value: number | null): string {
  return value === null ? "--" : `${Math.round(value)}ms`;
}

function prefetchLabel(metrics: StatusBarMetrics["prefetch"]): string {
  if (!metrics.enabled) {
    return `Prefetch off · ${metrics.visible} visible`;
  }
  const parts = [
    `${metrics.visible} visible`,
    `${metrics.completed} done`,
    `${metrics.active} active`,
    `${metrics.queued} queued`
  ];
  if (metrics.lastDurationMs !== null) {
    parts.push(`last ${formatMs(metrics.lastDurationMs)}`);
  }
  return `Prefetch ${parts.join(" · ")}`;
}

function cacheLabel(caches: StatusBarMetrics["caches"]): string {
  if (caches.length === 0) {
    return "Cache --";
  }
  return `Cache ${caches
    .map((cache) => `${cache.label} ${cache.entries}/${formatBytes(cache.bytes)}`)
    .join(" · ")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${formatUnit(bytes / 1024)} KB`;
  }
  return `${formatUnit(bytes / (1024 * 1024))} MB`;
}

function formatUnit(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
