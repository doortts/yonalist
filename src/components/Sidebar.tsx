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
import { featureRegistry } from "../features/core/featureRegistry";
import type { FeatureDefinition, FeatureId } from "../features/core/featureTypes";
import type { OwnerGroup } from "../services/githubItems";
import { LoadingDots } from "./LoadingDots";
import { IconTooltip, TooltipProvider } from "./ui/Tooltip";

export type ListFilter = "all" | "favorites" | "issues" | "pulls" | "discussions";

export interface SidebarProps {
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
  activeFeatureId?: FeatureId;
  featureEntries?: readonly FeatureDefinition[];
  onFeatureChange?: (featureId: FeatureId) => void;
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
  notificationsLoading,
  activeFeatureId,
  featureEntries = featureRegistry,
  onFeatureChange
}: SidebarProps) {
  const featureNavigationEnabled = activeFeatureId !== undefined && onFeatureChange !== undefined;
  const inboxActive =
    activeFeatureId === undefined
      ? !repositoryFilter && !settingsOpen && !notificationsOpen
      : activeFeatureId === "inbox" && !repositoryFilter && !settingsOpen && !notificationsOpen;
  const inboxWorkspaceActive =
    activeFeatureId === undefined
      ? !settingsOpen && !notificationsOpen
      : activeFeatureId === "inbox" && !settingsOpen && !notificationsOpen;
  const showInboxDetails =
    !settingsOpen &&
    (activeFeatureId === undefined || activeFeatureId === "inbox");
  const projectsActive =
    activeFeatureId === undefined
      ? !settingsOpen && !notificationsOpen
      : activeFeatureId === "inbox" && !settingsOpen && !notificationsOpen;
  const settingsActive = activeFeatureId === undefined ? settingsOpen : activeFeatureId === "settings";
  const workspaceTitle =
    activeFeatureId === "notes"
      ? "Notes"
      : settingsActive
        ? "Settings"
        : "GitHub Inbox";

  return (
    <TooltipProvider>
    <aside className="sidebar" aria-label="Navigation">
      <div className="pane-titlebar-spacer" />
      <div className="sidebar-scroll">
      <div className="brand-row">
        <div className="brand-copy">
          <p className="eyebrow">Yonalist</p>
          <h1>{workspaceTitle}</h1>
        </div>
        <div className="brand-actions">
          {loginRequired && (
            <IconTooltip label="Sign in required">
              <button
                className="icon-button login-required-button"
                type="button"
                aria-label="Login required"
                onClick={() => onOpenSettings()}
              >
                <LogIn size={17} />
              </button>
            </IconTooltip>
          )}
          {!online && (
            <IconTooltip label="오프라인 - 클릭하면 온라인으로 전환">
              <button
                className="icon-button"
                type="button"
                aria-label="Go online"
                onClick={onToggleOnline}
              >
                <WifiOff size={18} />
              </button>
            </IconTooltip>
          )}
        </div>
      </div>

      {!online && <span className="offline-badge">Offline</span>}

      <section className="nav-section nav-section-primary" aria-label="Main navigation">
        <button
          className={inboxWorkspaceActive ? "nav-item active" : "nav-item"}
          type="button"
          aria-pressed={inboxWorkspaceActive}
          onClick={() => onFilterChange(filter)}
        >
          <Inbox size={16} />
          <span>GitHub Inbox</span>
        </button>
        <button
          className={notificationsOpen ? "nav-item active" : "nav-item"}
          type="button"
          aria-pressed={notificationsOpen}
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
        {featureNavigationEnabled &&
          featureEntries
            .filter((entry) => entry.section === "workspace" && entry.id === "notes")
            .map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={activeFeatureId === id ? "nav-item active" : "nav-item"}
                type="button"
                aria-pressed={activeFeatureId === id}
                onClick={() => onFeatureChange?.(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
      </section>

      {showInboxDetails && (
        <>
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
              <IconTooltip label="Repository filter settings">
                <button
                  className="nav-section-icon-button"
                  type="button"
                  aria-label="Open repository filter settings"
                  onClick={onOpenProjectSettings}
                >
                  <Settings size={13} />
                </button>
              </IconTooltip>
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
        </>
      )}

      <section className="nav-section nav-section-app">
        <h2>App</h2>
        <button
          className={settingsActive ? "nav-item active" : "nav-item"}
          type="button"
          onClick={() => onOpenSettings()}
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </section>
      </div>
    </aside>
    </TooltipProvider>
  );
}
