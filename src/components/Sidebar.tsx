import {
  Bookmark,
  CircleDot,
  Folder,
  GitPullRequest,
  Inbox,
  Settings,
  Wifi,
  WifiOff
} from "lucide-react";
import type { PointerEvent } from "react";
import { startNativeWindowDrag } from "../windowDrag";

export type ListFilter = "all" | "favorites" | "issues" | "pulls";

export interface RepositoryEntry {
  key: string;
  host: string;
  owner: string;
  repo: string;
  count: number;
}

interface SidebarProps {
  online: boolean;
  onToggleOnline: () => void;
  filter: ListFilter;
  onFilterChange: (filter: ListFilter) => void;
  repositoryFilter: string | null;
  onRepositoryFilterChange: (key: string | null) => void;
  repositories: RepositoryEntry[];
  counts: Record<ListFilter, number>;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}

const filterEntries: Array<{
  key: ListFilter;
  label: string;
  icon: typeof Inbox;
}> = [
  { key: "all", label: "All items", icon: Inbox },
  { key: "favorites", label: "Favorites", icon: Bookmark },
  { key: "issues", label: "Issues", icon: CircleDot },
  { key: "pulls", label: "Pull requests", icon: GitPullRequest }
];

export function Sidebar({
  online,
  onToggleOnline,
  filter,
  onFilterChange,
  repositoryFilter,
  onRepositoryFilterChange,
  repositories,
  counts,
  settingsOpen,
  onOpenSettings
}: SidebarProps) {
  function handleWindowDragStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    void startNativeWindowDrag();
  }

  return (
    <aside className="sidebar" aria-label="Navigation">
      <div
        className="window-drag-region"
        data-tauri-drag-region
        aria-label="Window drag region"
        onPointerDown={handleWindowDragStart}
      />
      <div className="brand-row">
        <div>
          <p className="eyebrow">Yonalist</p>
          <h1>GitHub Inbox</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={online ? "Go offline" : "Go online"}
          onClick={onToggleOnline}
        >
          {online ? <Wifi size={18} /> : <WifiOff size={18} />}
        </button>
      </div>

      {!online && <span className="offline-badge">Offline</span>}

      <section className="nav-section">
        <h2>Inbox</h2>
        {filterEntries.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={filter === key && !settingsOpen ? "nav-item active" : "nav-item"}
            type="button"
            aria-pressed={filter === key}
            onClick={() => onFilterChange(key)}
          >
            <Icon size={16} />
            <span>{label}</span>
            <strong>{counts[key]}</strong>
          </button>
        ))}
      </section>

      <section className="nav-section">
        <h2>Projects</h2>
        {repositories.map((repository) => (
          <button
            className={
              repositoryFilter === repository.key ? "nav-item active" : "nav-item"
            }
            type="button"
            aria-pressed={repositoryFilter === repository.key}
            key={repository.key}
            onClick={() =>
              onRepositoryFilterChange(
                repositoryFilter === repository.key ? null : repository.key
              )
            }
          >
            <Folder size={16} />
            <span>
              {repository.owner}/{repository.repo}
            </span>
            <strong>{repository.count}</strong>
          </button>
        ))}
      </section>

      <section className="nav-section">
        <h2>App</h2>
        <button
          className={settingsOpen ? "nav-item active" : "nav-item"}
          type="button"
          onClick={onOpenSettings}
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </section>
    </aside>
  );
}
