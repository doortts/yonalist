import type { PointerEvent } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { startNativeWindowDrag } from "../windowDrag";
import { IconTooltip } from "./ui/Tooltip";
import { SidebarPaneIcon, SidebarPaneOpenIcon } from "./ui/PaneIcons";

export interface PaneToggleControls {
  sidebarCollapsed: boolean;
  detailMaximized: boolean;
  onToggleSidebar: () => void;
  onToggleMaximize: () => void;
  /**
   * Whether the fixed detail-maximize toggle is rendered in its top-right
   * corner. It is suppressed while a detail header is on screen, because the
   * same action is offered inline in that header (avoiding an overlap with the
   * header's own actions). Header-less shells (settings, new issue, empty
   * detail) keep it, so the control is always reachable.
   */
  showDetailMaximizeToggle: boolean;
}

interface TitleBarProps {
  /**
   * When provided, the title bar renders the sidebar collapse toggle and the
   * detail maximize toggle. Omitted on standalone shells (e.g. the auth restore
   * screen) that have no resizable panes to control.
   */
  paneToggles?: PaneToggleControls;
}

/**
 * The sidebar keeps enough drag room for the macOS traffic lights. Content
 * panes get only a slim drag strip so their headers can sit near the top.
 *
 * The pane controls live in two fixed strips (not drag regions):
 *  - The sidebar toggle rides the sidebar's right edge while it is open, then
 *    drops to the left of the now-frontmost pane (past the traffic lights) once
 *    the sidebar collapses.
 *  - The detail maximize toggle stays pinned to the window's right edge.
 */
export function TitleBar({ paneToggles }: TitleBarProps = {}) {
  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    void startNativeWindowDrag();
  }

  return (
    <>
      <div
        className="app-titlebar"
        data-tauri-drag-region
        aria-label="Window drag region"
        onPointerDown={handlePointerDown}
      />
      <div
        className="app-content-drag-strip"
        data-tauri-drag-region
        aria-label="Window drag strip"
        onPointerDown={handlePointerDown}
      />
      {paneToggles && (
        <>
          <div
            className="pane-toggle-group"
            role="group"
            aria-label="Pane layout"
            data-position={paneToggles.sidebarCollapsed ? "pane-start" : "sidebar-end"}
            // Open: tucked inside the sidebar's right edge, away from the traffic
            // lights. Collapsed: the sidebar is gone, so it rides the right edge
            // of the now-frontmost pane with a traffic-light-safe fallback.
            style={{
              left: paneToggles.sidebarCollapsed
                ? "max(78px, calc(var(--list-width, 420px) - 36px))"
                : "calc(var(--sidebar-width, 280px) - 36px)"
            }}
            // The buttons must not initiate a native window drag; keep pointer
            // events from reaching the surrounding drag regions.
            onPointerDown={(event) => event.stopPropagation()}
          >
            <IconTooltip
              label={paneToggles.sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
              side="bottom"
            >
              <button
                className="pane-toggle"
                type="button"
                aria-label="사이드바 접기/펼치기"
                aria-pressed={paneToggles.sidebarCollapsed}
                onClick={paneToggles.onToggleSidebar}
              >
                {paneToggles.sidebarCollapsed ? (
                  <SidebarPaneOpenIcon size={16} />
                ) : (
                  <SidebarPaneIcon size={16} />
                )}
              </button>
            </IconTooltip>
          </div>
          {paneToggles.showDetailMaximizeToggle && (
            <div
              className="pane-toggle-group"
              role="group"
              aria-label="Detail layout"
              data-position="detail-end"
              style={{ right: "12px" }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <IconTooltip
                label={paneToggles.detailMaximized ? "본문 최대화 해제" : "본문만 크게 보기"}
                side="bottom"
              >
                <button
                  className="pane-toggle"
                  type="button"
                  aria-label="상세 최대화"
                  aria-pressed={paneToggles.detailMaximized}
                  onClick={paneToggles.onToggleMaximize}
                >
                  {paneToggles.detailMaximized ? (
                    <Minimize2 size={16} />
                  ) : (
                    <Maximize2 size={16} />
                  )}
                </button>
              </IconTooltip>
            </div>
          )}
        </>
      )}
    </>
  );
}
