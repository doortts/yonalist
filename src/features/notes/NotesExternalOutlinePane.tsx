import { Maximize2, Minimize2 } from "lucide-react";
import { useContext } from "react";
import { useExternalSources } from "../../ExternalSourcesContext";
import { PaneLayoutContext } from "../../PaneLayoutContext";
import {
  serializeExternalBulletKey,
  type ExternalSourcePageSnapshot
} from "../../domain/externalSources";
import { IconTooltip, TooltipProvider } from "../../components/ui/Tooltip";
import { NotesExternalBulletRow } from "./NotesExternalBulletRow";

interface NotesExternalOutlinePaneProps {
  page: ExternalSourcePageSnapshot;
}

export function NotesExternalOutlinePane({
  page
}: NotesExternalOutlinePaneProps) {
  const externalSources = useExternalSources();
  const paneLayout = useContext(PaneLayoutContext);
  const initialLoading =
    page.availability === "connecting" || (!page.loaded && page.loading);
  const disconnected = page.availability === "disconnected";
  const authenticationRequired =
    page.availability === "authentication-required";
  const offline = page.availability === "offline";

  return (
    <section
      className="notes-outline notes-external-outline"
      aria-label={`${page.title} outline`}
      aria-busy={page.loading}
    >
      <TooltipProvider>
        <header className="notes-outline-toolbar notes-external-toolbar">
          <h2>{page.title}</h2>
          {paneLayout && (
            <IconTooltip
              label={
                paneLayout.detailMaximized
                  ? "상세 최대화 해제"
                  : "상세 최대화"
              }
              side="bottom"
            >
              <button
                className="notes-export-trigger notes-maximize-toggle"
                type="button"
                aria-label="상세 최대화"
                aria-pressed={paneLayout.detailMaximized}
                onClick={paneLayout.toggleDetailMaximized}
              >
                {paneLayout.detailMaximized ? (
                  <Minimize2 size={16} aria-hidden="true" />
                ) : (
                  <Maximize2 size={16} aria-hidden="true" />
                )}
              </button>
            </IconTooltip>
          )}
        </header>

        <div className="notes-external-content">
          {disconnected ? (
            <p className="notes-pane-state">
              Connect GitHub to view notifications.
            </p>
          ) : authenticationRequired ? (
            <p className="notes-pane-state">
              GitHub authentication is required.
            </p>
          ) : (
            <>
              {offline && (
                <p className="notes-external-status" role="status">
                  {page.loaded
                    ? "Offline. Showing cached notifications."
                    : "Offline. No cached notifications."}
                </p>
              )}
              {initialLoading && (
                <p className="notes-pane-state" role="status">
                  Loading notifications...
                </p>
              )}
              {page.error && (
                <div className="notes-inline-error notes-external-error" role="alert">
                  <span>{page.error}</span>
                  <button
                    type="button"
                    onClick={() =>
                      void externalSources.refresh(page.providerId).catch(() => undefined)
                    }
                  >
                    다시 시도
                  </button>
                </div>
              )}
              {!initialLoading &&
                page.loaded &&
                page.items.length === 0 &&
                !page.error && (
                  <p className="notes-pane-state">No notifications.</p>
                )}
              {page.items.length > 0 && (
                <ol className="notes-external-list">
                  {page.items.map((bullet) => {
                    const serializedKey = serializeExternalBulletKey(bullet.key);
                    return (
                      <NotesExternalBulletRow
                        key={serializedKey}
                        bullet={bullet}
                        completing={page.completingKeys.has(serializedKey)}
                        completionError={
                          page.completionErrors[serializedKey] ?? null
                        }
                      />
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>
      </TooltipProvider>
    </section>
  );
}
