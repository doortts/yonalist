import { LogIn, Settings, WifiOff } from "lucide-react";
import { featureRegistry } from "../features/core/featureRegistry";
import type {
  FeatureDefinition,
  FeatureId
} from "../features/core/featureTypes";
import { IconTooltip, TooltipProvider } from "./ui/Tooltip";

export interface SidebarProps {
  online: boolean;
  loginRequired: boolean;
  onToggleOnline: () => void;
  activeFeatureId: FeatureId;
  featureEntries?: readonly FeatureDefinition[];
  onFeatureChange: (featureId: FeatureId) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  online,
  loginRequired,
  onToggleOnline,
  activeFeatureId,
  featureEntries = featureRegistry,
  onFeatureChange,
  onOpenSettings
}: SidebarProps) {
  const activeFeature = featureEntries.find(
    (feature) => feature.id === activeFeatureId
  );

  return (
    <TooltipProvider>
      <aside className="sidebar" aria-label="Navigation">
        <div className="pane-titlebar-spacer" />
        <div className="sidebar-scroll">
          <div className="brand-row">
            <div className="brand-copy">
              <p className="eyebrow">Yonalist</p>
              <h1>{activeFeature?.label ?? "Yonalist"}</h1>
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

          <section
            className="nav-section nav-section-primary"
            aria-label="Main navigation"
          >
            {featureEntries
              .filter((entry) => entry.section === "workspace")
              .map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={
                    activeFeatureId === id ? "nav-item active" : "nav-item"
                  }
                  type="button"
                  aria-pressed={activeFeatureId === id}
                  onClick={() => onFeatureChange(id)}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
          </section>

          <section className="nav-section nav-section-app">
            <h2>App</h2>
            <button
              className={
                activeFeatureId === "settings"
                  ? "nav-item active"
                  : "nav-item"
              }
              type="button"
              aria-pressed={activeFeatureId === "settings"}
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
