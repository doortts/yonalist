import {
  Bell,
  Bookmark,
  CircleDot,
  Folder,
  GitPullRequest,
  Inbox,
  LogIn,
  MessagesSquare,
  Settings,
  WifiOff
} from "lucide-react";
import type { OwnerGroup } from "../services/githubItems";
import { LoadingDots } from "./LoadingDots";

export type ListFilter = "all" | "favorites" | "issues" | "pulls" | "discussions";

interface SidebarProps {
  online: boolean;
  loginRequired: boolean;
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
  onOpenProjectSettings: () => void;
  notificationsOpen: boolean;
  onOpenNotifications: () => void;
  unreadNotificationCount: number;
  notificationsLoading: boolean;
}

const filterEntries: Array<{
  key: ListFilter;
  label: string;
  icon: typeof Inbox;
}> = [
  { key: "favorites", label: "Favorites", icon: Bookmark },
  { key: "all", label: "All items", icon: Inbox },
  { key: "issues", label: "Issues", icon: CircleDot },
  { key: "pulls", label: "Pull requests", icon: GitPullRequest },
  { key: "discussions", label: "Discussions", icon: MessagesSquare }
];

export function Sidebar({
  online,
  loginRequired,
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
  onOpenProjectSettings,
  notificationsOpen,
  onOpenNotifications,
  unreadNotificationCount,
  notificationsLoading
}: SidebarProps) {
  const inboxActive = !repositoryFilter && !settingsOpen && !notificationsOpen;
  const projectsActive = !settingsOpen && !notificationsOpen;

  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="pane-titlebar-spacer" />
      <div className="sidebar-scroll">
      <div className="brand-row">
        <div className="brand-copy">
          <p className="eyebrow">Yonalist</p>
          <h1>GitHub Inbox</h1>
        </div>
        <div className="brand-actions">
          {loginRequired && (
            <button
              className="icon-button login-required-button"
              type="button"
              aria-label="Login required"
              title="Sign in required"
              onClick={() => onOpenSettings()}
            >
              <LogIn size={17} />
            </button>
          )}
          {!online && (
            <button
              className="icon-button"
              type="button"
              aria-label="Go online"
              title="오프라인 — 클릭하면 온라인으로 전환"
              onClick={onToggleOnline}
            >
              <WifiOff size={18} />
            </button>
          )}
        </div>
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
          {notificationsLoading ? (
            <LoadingDots ariaLabel="Refreshing notifications" />
          ) : (
            unreadNotificationCount > 0 && (
              <strong className="nav-badge">{unreadNotificationCount}</strong>
            )
          )}
        </button>
      </section>

      <section className="nav-section">
        <h2>Inbox</h2>
        {filterEntries.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={inboxActive && filter === key ? "nav-item active" : "nav-item"}
            type="button"
            aria-pressed={inboxActive && filter === key}
            onClick={() => onFilterChange(key)}
          >
            <Icon size={16} />
            <span>{label}</span>
            <strong>{counts[key]}</strong>
          </button>
        ))}
      </section>

      <section className="nav-section">
        <div className="nav-section-heading">
          <h2>Repository</h2>
          <button
            className="nav-section-icon-button"
            type="button"
            aria-label="Open repository filter settings"
            title="Repository filter settings"
            onClick={onOpenProjectSettings}
          >
            <Settings size={13} />
          </button>
        </div>
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
                  projectsActive && repositoryFilter === repository.fullName
                    ? "nav-item active"
                    : "nav-item"
                }
                type="button"
                aria-pressed={projectsActive && repositoryFilter === repository.fullName}
                key={repository.fullName}
                onClick={() => onRepositoryFilterChange(repository.fullName)}
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
          onClick={() => onOpenSettings()}
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </section>
      </div>
    </aside>
  );
}
