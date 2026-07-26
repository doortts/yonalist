import { memo, type ReactNode } from "react";

interface AppStatusBarProps {
  online: boolean;
  feedback?: ReactNode;
}

export const AppStatusBar = memo(function AppStatusBar({
  online,
  feedback
}: AppStatusBarProps) {
  return (
    <footer className="app-statusbar" aria-label="Status bar">
      <div className="statusbar-feedback">{feedback}</div>
      <div className="statusbar-actions">
        <span className="statusbar-state">
          {online ? "Online" : "Offline"}
        </span>
      </div>
    </footer>
  );
});
