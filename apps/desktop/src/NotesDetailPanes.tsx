import { memo, type CSSProperties } from "react";
import type { NotesStore } from "./notesStore";
import {
  NotesOutline,
  type PaneRestoreRequest
} from "./NotesOutline";
import { JournalReferences } from "./JournalReferences";
import type { OutlineTagToken } from "./outline/OutlineTextField";
import type { NotesShellSnapshot } from "./store/storeSubscriptions";
import { useSplitResize } from "./useSplitResize";

export interface NotesDetailPanesProps {
  readonly store: NotesStore;
  readonly status: NotesShellSnapshot["status"];
  readonly error: string | null;
  readonly pendingWrites: number;
  readonly page: { readonly id: string; readonly title: string } | undefined;
  readonly splitOpen: boolean;
  readonly primaryZoomRootId: string | null;
  readonly secondaryZoomRootId: string | null;
  readonly primaryRestore: PaneRestoreRequest | null;
  readonly secondaryRestore: PaneRestoreRequest | null;
  readonly onPrimaryZoomChange: (nodeId: string | null) => void;
  readonly onSecondaryZoomChange: (nodeId: string | null) => void;
  readonly onHome: () => void;
  readonly onOpenSplit: (nodeId: string) => void;
  readonly onCloseSplit: () => void;
  readonly onTagClick: (token: OutlineTagToken) => void;
  readonly onDateClick: (date: string, anchor: DOMRect) => void;
  readonly onOpenPage: (pageId: string) => void;
  readonly onSelectionCountChange: (
    paneId: "primary" | "secondary",
    count: number
  ) => void;
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
  onHome,
  onOpenSplit,
  onCloseSplit,
  onTagClick,
  onDateClick,
  onOpenPage,
  onSelectionCountChange
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
              onHome={onHome}
              paneId="primary"
              restoreRequest={primaryRestore}
              onOpenSplit={onOpenSplit}
              onTagClick={onTagClick}
              onDateClick={onDateClick}
              onSelectionCountChange={onSelectionCountChange}
            />
            {page && (
              <JournalReferences
                store={store}
                pageId={page.id}
                onOpenPage={onOpenPage}
              />
            )}
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
                  onHome={onHome}
                  paneId="secondary"
                  restoreRequest={secondaryRestore}
                  onOpenSplit={onOpenSplit}
                  onTagClick={onTagClick}
              onDateClick={onDateClick}
                  onClose={onCloseSplit}
                  onSelectionCountChange={onSelectionCountChange}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
});
