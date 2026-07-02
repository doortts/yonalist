import {
  Bell,
  Bookmark,
  CircleDot,
  Folder,
  GitPullRequest,
  Inbox,
  MessagesSquare,
  Settings,
  Wifi,
  WifiOff
} from "lucide-react";
import type { OwnerGroup } from "../services/githubItems";

export type ListFilter = "all" | "favorites" | "issues" | "pulls" | "discussions";

interface SidebarProps {
  online: boolean;
  onToggleOnline: () => void;
  filter: ListFilter;
  onFilterChange: (filter: ListFilter) => void;
  repositoryFilter: string | null;
  onRepositoryFilterChange: (key: string | null) => void;
  repositoryGroups: OwnerGroup[];
  repositoriesLoading: boolean;
  counts: Record<ListFilter, number>;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  notificationsOpen: boolean;
  onOpenNotifications: () => void;
  unreadNotificationCount: number;
}

const filterEntries: Array<{
  key: ListFilter;
  label: string;
  icon: typeof Inbox;
}> = [
  { key: "all", label: "All items", icon: Inbox },
  { key: "favorites", label: "Favorites", icon: Bookmark },
  { key: "issues", label: "Issues", icon: CircleDot },
  { key: "pulls", label: "Pull requests", icon: GitPullRequest },
  { key: "discussions", label: "Discussions", icon: MessagesSquare }
];

export function Sidebar({
  online,
  onToggleOnline,
  filter,
  onFilterChange,
  repositoryFilter,
  onRepositoryFilterChange,
  repositoryGroups,
  repositoriesLoading,
  counts,
  settingsOpen,
  onOpenSettings,
  notificationsOpen,
  onOpenNotifications,
  unreadNotificationCount
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="pane-titlebar-spacer" />
      <div className="sidebar-scroll">
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
        <h2>GitHub</h2>
        <button
          className={notificationsOpen ? "nav-item active" : "nav-item"}
          type="button"
          onClick={onOpenNotifications}
        >
          <Bell size={16} />
          <span>Notifications</span>
          {unreadNotificationCount > 0 && (
            <strong className="nav-badge">{unreadNotificationCount}</strong>
          )}
        </button>
      </section>

      <section className="nav-section">
        <h2>Inbox</h2>
        {filterEntries.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={
              filter === key && !settingsOpen && !notificationsOpen
                ? "nav-item active"
                : "nav-item"
            }
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
        {repositoriesLoading && repositoryGroups.length === 0 && (
          <p className="nav-note">Loading repositories...</p>
        )}
        {!repositoriesLoading && repositoryGroups.length === 0 && (
          <p className="nav-note">No repositories.</p>
        )}
        {repositoryGroups.map((group) => (
          <div className="nav-owner-group" key={group.owner}>
            <h3 className="nav-owner">{group.owner}</h3>
            {group.repositories.map((repository) => (
              <button
                className={
                  repositoryFilter === repository.fullName
                    ? "nav-item active"
                    : "nav-item"
                }
                type="button"
                aria-pressed={repositoryFilter === repository.fullName}
                key={repository.fullName}
                onClick={() =>
                  onRepositoryFilterChange(
                    repositoryFilter === repository.fullName
                      ? null
                      : repository.fullName
                  )
                }
              >
                <Folder size={16} />
                <span>{repository.name}</span>
                <strong>{repository.openIssuesCount}</strong>
              </button>
            ))}
          </div>
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
      </div>
    </aside>
  );
}
