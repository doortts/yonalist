import { memo, type CSSProperties } from "react";
import type { PageSummary } from "../../../packages/contracts/generated/PageSummary";
import type { NotesStore } from "./notesStore";
import {
  NotesOutline,
  type PaneRestoreRequest
} from "./NotesOutline";
import type { OutlineTagToken } from "./OutlineTextField";
import type { NotesShellSnapshot } from "./storeSubscriptions";
import { useSplitResize } from "./useSplitResize";

export interface NotesDetailPanesProps {
  readonly store: NotesStore;
  readonly status: NotesShellSnapshot["status"];
  readonly error: string | null;
  readonly pendingWrites: number;
  readonly page: PageSummary | undefined;
  readonly splitOpen: boolean;
  readonly primaryZoomRootId: string | null;
  readonly secondaryZoomRootId: string | null;
  readonly primaryRestore: PaneRestoreRequest | null;
  readonly secondaryRestore: PaneRestoreRequest | null;
  readonly onPrimaryZoomChange: (nodeId: string | null) => void;
  readonly onSecondaryZoomChange: (nodeId: string | null) => void;
  readonly onOpenSplit: (nodeId: string) => void;
  readonly onCloseSplit: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
}

export const NotesDetailPanes = memo(function NotesDetailPanes({
  store,
  status,
  error,
  pendingWrites,
  page,
  splitOpen,
  primaryZoomRootId,
  secondaryZoomRootId,
  primaryRestore,
  secondaryRestore,
  onPrimaryZoomChange,
  onSecondaryZoomChange,
  onOpenSplit,
  onCloseSplit,
  onTagClick
}: NotesDetailPanesProps) {
  const splitResize = useSplitResize(splitOpen);
  return (
    <section className="detail-pane" aria-label="Detail">
      <div className="pane-titlebar-spacer" />
      <div
        className="detail-scroll"
        style={{ overflowY: splitOpen ? "hidden" : undefined }}
      >
        <div
          ref={splitResize.containerRef}
          className="notes-detail-split"
          data-split-open={splitOpen ? "true" : undefined}
          style={{
            "--notes-split-primary": `${splitResize.primaryPercent}%`
          } as CSSProperties}
        >
          <div
            className="notes-detail-pane"
            style={{ overflowY: splitOpen ? "auto" : undefined }}
          >
            <NotesOutline
              store={store}
              status={status}
              error={error}
              pendingWrites={pendingWrites}
              page={page}
              zoomRootId={primaryZoomRootId}
              onZoomRootChange={onPrimaryZoomChange}
              paneId="primary"
              restoreRequest={primaryRestore}
              onOpenSplit={onOpenSplit}
              onTagClick={onTagClick}
            />
          </div>
          {splitOpen && (
            <>
              <div
                className="notes-split-divider"
                role="separator"
                aria-label="Resize split"
                aria-orientation="vertical"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(splitResize.primaryPercent)}
                tabIndex={0}
                onPointerDown={splitResize.onPointerDown}
                onKeyDown={splitResize.onKeyDown}
              />
              <div className="notes-detail-pane" style={{ overflowY: "auto" }}>
                <NotesOutline
                  store={store}
                  status={status}
                  error={error}
                  pendingWrites={pendingWrites}
                  page={page}
                  zoomRootId={secondaryZoomRootId}
                  onZoomRootChange={onSecondaryZoomChange}
                  paneId="secondary"
                  restoreRequest={secondaryRestore}
                  onOpenSplit={onOpenSplit}
                  onTagClick={onTagClick}
                  onClose={onCloseSplit}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
});
