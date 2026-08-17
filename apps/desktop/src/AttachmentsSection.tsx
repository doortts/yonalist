import { Paperclip } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SyncAttachment } from "../../../packages/contracts/generated/SyncAttachment";

/** What the folder holds, biggest first — the order that answers the question. */
const LIMIT = 500;

/** Long enough that a note deleted by accident can still be brought back. */
const KEPT_DAYS = 14;

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function formatSize(bytes: number): string {
  // Binary units throughout, thresholds included — mixing the two reports a
  // file as smaller than it is, in a list whose whole job is size.
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${bytes} bytes`;
}

/**
 * How long an unused file has left, in whole days. Counted from when the last
 * note stopped pointing at it — the app never deletes one on its own, so this
 * is what the user is deciding against rather than a countdown to a deletion.
 */
export function daysLeft(unreferencedAt: number, now: number): number {
  const elapsed = now - unreferencedAt * 1_000;
  return Math.max(0, KEPT_DAYS - Math.floor(elapsed / 86_400_000));
}

export function AttachmentsSection({
  readAttachments,
  deleteAttachment,
  openNode,
  now = () => Date.now()
}: {
  readonly readAttachments: (limit: number) => Promise<readonly SyncAttachment[]>;
  readonly deleteAttachment: (contentHash: string) => Promise<boolean>;
  readonly openNode: (pageId: string, nodeId: string) => void;
  readonly now?: () => number;
}) {
  const [rows, setRows] = useState<readonly SyncAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await readAttachments(LIMIT));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, [readAttachments]);

  // What the row says about where it is. A note in the trash is on no page,
  // and sending the user to Home for it would be a lie.
  const place = (row: SyncAttachment): string => {
    if (row.nodeId === "") return "Not used by any note";
    if (row.trashed) return "In the trash";
    const under = row.parentTitle && row.parentTitle !== row.pageTitle
      ? ` › ${row.parentTitle}`
      : "";
    return `${row.pageTitle || "Home"}${under}`;
  };

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (contentHash: string) => {
    setBusy(true);
    setError(null);
    try {
      const removed = await deleteAttachment(contentHash);
      if (!removed) {
        // Something started using it again between the list being drawn and
        // the button being pressed. Saying so is better than a row that
        // silently stays.
        setError("That file is being used by a note again, so it was kept.");
      }
      await reload();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0 && error === null) return null;

  return (
    <section className="settings-section" aria-label="Attachments">
      <div className="settings-section-title">
        <Paperclip size={18} aria-hidden="true" />
        <h3>Attachments</h3>
      </div>
      {error && <p className="notes-inline-error" role="alert">{error}</p>}
      <p className="settings-copy">
        Every picture in your notes, biggest first. A file no note uses any
        more is kept for {KEPT_DAYS} days in case you bring the note back.
      </p>
      <ul className="settings-attachment-list">
        {rows.map((row) => (
          <li key={`${row.contentHash}:${row.nodeId}`}>
            {row.nodeId === "" || row.pageId === "" ? (
              // Nothing to follow: either no note points at these bytes, or
              // the note that does is in the trash and sits on no page.
              <span className="settings-attachment-name">{row.name}</span>
            ) : (
              <button
                type="button"
                className="settings-attachment-name"
                onClick={() => openNode(row.pageId, row.nodeId)}
              >
                {row.name}
              </button>
            )}
            <span className="settings-copy">{formatSize(row.byteLength)}</span>
            <span className="settings-copy">{place(row)}</span>
            {row.references > 1 && (
              <span className="settings-copy">Used by {row.references} notes</span>
            )}
            {row.references === 0 && row.unreferencedAt !== null && (
              <>
                <span className="settings-copy">
                  {daysLeft(row.unreferencedAt, now())} days left
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(row.contentHash)}
                >
                  Delete now
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
