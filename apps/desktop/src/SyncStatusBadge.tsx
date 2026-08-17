import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SyncStatus } from "../../../packages/contracts/generated/SyncStatus";

/**
 * What sync cannot do right now, where the user will see it without going
 * looking. Nothing is shown while everything works — a badge that is always
 * there is a badge nobody reads.
 *
 * The state is asked for rather than pushed: a folder that could not be
 * watched fails before this window is listening, so the answer has to be
 * there for whoever asks late.
 */
export function SyncStatusBadge({
  readStatus,
  subscribe
}: {
  readonly readStatus: () => Promise<SyncStatus>;
  /** Calls back whenever the state moved. Answers the way to stop. */
  readonly subscribe: (moved: () => void) => () => void;
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  const reload = useCallback(() => {
    void readStatus()
      .then(setStatus)
      // A window that cannot ask has nothing to say. It asks again on the
      // next thing that moves.
      .catch(() => undefined);
  }, [readStatus]);

  useEffect(() => {
    reload();
    return subscribe(reload);
  }, [reload, subscribe]);

  if (!status) return null;
  const trouble = [
    status.watchError && `폴더를 지켜보지 못하고 있어요: ${status.watchError}`,
    status.writeError && `폴더에 쓰지 못했어요: ${status.writeError}`,
    ...status.refused.map((file) => `${file.path} — ${file.reason}`)
  ].filter((line): line is string => Boolean(line));
  if (trouble.length === 0) return null;

  return (
    <div className="notes-sync-status-badge" role="status">
      <TriangleAlert size={14} aria-hidden="true" />
      <div className="notes-sync-status-message">
        <span>
          {status.refused.length > 0 && trouble.length === status.refused.length
            ? `읽지 못한 파일 ${status.refused.length}개`
            : "동기화에 문제가 있어요"}
        </span>
        {trouble.map((line) => (
          <span key={line} className="notes-sync-status-detail">{line}</span>
        ))}
        <span className="notes-sync-status-advice">
          이 파일들은 그대로 두었어요. 노트는 안전해요.
        </span>
      </div>
    </div>
  );
}
