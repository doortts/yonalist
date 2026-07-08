import type { PointerEvent } from "react";
import { Columns2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { startNativeWindowDrag } from "../windowDrag";
import { IconTooltip } from "./ui/Tooltip";

export interface PaneToggleControls {
  sidebarCollapsed: boolean;
  listCollapsed: boolean;
  onToggleSidebar: () => void;
  onToggleList: () => void;
}

interface TitleBarProps {
  /**
   * When provided, the title bar renders the sidebar/list collapse toggles.
   * Omitted on standalone shells (e.g. the auth restore screen) that have no
   * resizable panes to control.
   */
  paneToggles?: PaneToggleControls;
}

/**
 * The sidebar keeps enough drag room for the macOS traffic lights. Content
 * panes get only a slim drag strip so their headers can sit near the top.
 *
 * The pane collapse toggles live in their own fixed strip that clears the
 * traffic lights, so they stay reachable even when the sidebar is collapsed
 * to zero width (the collapsed pane itself is removed from the layout).
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
        <div
          className="pane-toggle-group"
          role="group"
          aria-label="Pane layout"
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
                <PanelLeftOpen size={16} />
              ) : (
                <PanelLeftClose size={16} />
              )}
            </button>
          </IconTooltip>
          <IconTooltip
            label={paneToggles.listCollapsed ? "목록 펼치기" : "목록 접기"}
            side="bottom"
          >
            <button
              className="pane-toggle"
              type="button"
              aria-label="목록 접기/펼치기"
              aria-pressed={paneToggles.listCollapsed}
              onClick={paneToggles.onToggleList}
            >
              <Columns2 size={16} />
            </button>
          </IconTooltip>
        </div>
      )}
    </>
  );
}
