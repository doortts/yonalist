import { ListTree, Maximize2 } from "lucide-react";

export function WindowChrome({
  sidebarCollapsed, detailMaximized, onToggleSidebar, onToggleDetail
}: {
  readonly sidebarCollapsed: boolean;
  readonly detailMaximized: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleDetail: () => void;
}) {
  return (
    <>
      <div className="app-titlebar" data-tauri-drag-region aria-label="Window drag region" />
      <div className="app-content-drag-strip" data-tauri-drag-region aria-label="Window drag strip" />
      <div
        className="pane-toggle-group"
        role="group"
        aria-label="Pane layout"
        data-position={sidebarCollapsed ? "pane-start" : "sidebar-end"}
        style={{
          left: sidebarCollapsed
            ? "86px"
            : "calc(var(--shell-inset, 8px) + var(--sidebar-width, 336px) - 36px)"
        }}
      >
        <button
          className="pane-toggle"
          type="button"
          aria-label="Toggle sidebar"
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tooltip={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={sidebarCollapsed}
          onClick={onToggleSidebar}
        >
          <ListTree size={16} aria-hidden="true" />
        </button>
      </div>
      <div
        className="pane-toggle-group"
        role="group"
        aria-label="Detail layout"
        data-position="detail-end"
        style={{ right: 12 }}
      >
        <button
          className="pane-toggle"
          type="button"
          aria-label="Maximize detail"
          title={detailMaximized ? "Restore detail" : "Maximize detail"}
          data-tooltip={detailMaximized ? "Restore detail" : "Maximize detail"}
          data-tooltip-align="right"
          aria-pressed={detailMaximized}
          onClick={onToggleDetail}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
