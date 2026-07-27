import { LogIn, Settings, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import type { FeatureId } from "../features/core/featureTypes";
import { IconTooltip, TooltipProvider } from "./ui/Tooltip";

export type NotesNavigationStatus = "idle" | "loading" | "ready" | "failed";

export interface YonalistNavigationPaneProps {
  activeFeatureId: FeatureId;
  online: boolean;
  loginRequired: boolean;
  notesStatus: NotesNavigationStatus;
  headerActions: ReactNode;
  children: ReactNode;
  onOpenNotes: () => void;
  onOpenSettings: () => void;
  onRetryNotes: () => void;
  onToggleOnline: () => void;
}

export function YonalistNavigationPane({
  activeFeatureId, online, loginRequired, notesStatus, headerActions, children,
  onOpenNotes, onOpenSettings, onRetryNotes, onToggleOnline
}: YonalistNavigationPaneProps) {
  return (
    <TooltipProvider>
      <nav className="yonalist-navigation-pane" aria-label="Navigation" data-active-feature={activeFeatureId}>
        <div className="pane-titlebar-spacer" />
        <header className="yonalist-navigation-header">
          <h1>Yonalist</h1>
          <div className="yonalist-navigation-header-actions">
            {notesStatus === "ready" ? headerActions : null}
            {loginRequired && <IconTooltip label="Sign in required"><button className="icon-button login-required-button" type="button" aria-label="Login required" onClick={() => onOpenSettings()}><LogIn size={17} /></button></IconTooltip>}
            {!online && <IconTooltip label="오프라인 - 클릭하면 온라인으로 전환"><button className="icon-button" type="button" aria-label="Go online" onClick={onToggleOnline}><WifiOff size={18} /></button></IconTooltip>}
          </div>
        </header>
        <div className="yonalist-navigation-scroll">
          {!online && <span className="offline-badge">Offline</span>}
          {notesStatus === "ready" && children}
          {notesStatus === "idle" && <button className="text-button notes-runtime-open" type="button" onClick={onOpenNotes}>Yonalist 열기</button>}
          {notesStatus === "loading" && <p className="feature-runtime-loading" role="status">Loading Yonalist…</p>}
          {notesStatus === "failed" && <div className="feature-runtime-error" role="alert"><p>Yonalist를 열 수 없습니다.</p><button type="button" onClick={onRetryNotes}>다시 시도</button></div>}
        </div>
        <footer className="yonalist-navigation-footer">
          <button className={activeFeatureId === "settings" ? "nav-item active" : "nav-item"} type="button" aria-pressed={activeFeatureId === "settings"} onClick={() => onOpenSettings()}>
            <Settings size={16} aria-hidden="true" /><span>Settings</span>
          </button>
        </footer>
      </nav>
    </TooltipProvider>
  );
}
