import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { NoteId } from "../../domain/notes";
import {
  serializeExternalBulletKey,
  type ExternalSourcePageSnapshot
} from "../../domain/externalSources";
import { NotesExternalBulletRow } from "./NotesExternalBulletRow";
import type {
  GithubOutlineProjection,
  GithubOutlineRow
} from "./githubNotificationsOutline";

interface NotesExternalOutlinePaneProps {
  page: ExternalSourcePageSnapshot | null;
  projection: GithubOutlineProjection;
  renderStoredRow(nodeId: NoteId, depth: number): ReactNode;
  onRetry?(): void;
}

interface GithubDateGroup {
  readonly date: Extract<GithubOutlineRow, { kind: "date" }>;
  readonly children: readonly Exclude<
    GithubOutlineRow,
    { kind: "date" | "source-status" }
  >[];
}

function groupProjectionRows(rows: readonly GithubOutlineRow[]): {
  readonly statuses: readonly Extract<
    GithubOutlineRow,
    { kind: "source-status" }
  >[];
  readonly groups: readonly GithubDateGroup[];
} {
  const statuses: Extract<
    GithubOutlineRow,
    { kind: "source-status" }
  >[] = [];
  const groups: Array<{
    date: Extract<GithubOutlineRow, { kind: "date" }>;
    children: Exclude<
      GithubOutlineRow,
      { kind: "date" | "source-status" }
    >[];
  }> = [];
  let current: (typeof groups)[number] | null = null;

  for (const row of rows) {
    if (row.kind === "source-status") {
      statuses.push(row);
      continue;
    }
    if (row.kind === "date") {
      current = { date: row, children: [] };
      groups.push(current);
      continue;
    }
    current?.children.push(row);
  }

  return { statuses, groups };
}

export function NotesExternalOutlinePane({
  page,
  projection,
  renderStoredRow,
  onRetry
}: NotesExternalOutlinePaneProps) {
  const { groups, statuses } = groupProjectionRows(projection.rows);

  return (
    <>
      {statuses.map((row) => (
        <li
          className="notes-external-status-row"
          data-external-status={row.status}
          key={row.key}
          role="listitem"
        >
          <p
            className={
              row.status === "error"
                ? "notes-inline-error notes-external-error"
                : "notes-pane-state notes-external-status"
            }
            role={row.status === "error" ? "alert" : "status"}
          >
            <span>{row.message}</span>
            {row.status === "error" && onRetry && (
              <button type="button" onClick={onRetry}>
                다시 시도
              </button>
            )}
          </p>
        </li>
      ))}
      {groups.map(({ date, children }) => (
        <li
          className="notes-external-group"
          data-external-date-key={date.dateKey}
          data-collapsed={date.collapsed ? "true" : "false"}
          key={date.key}
          role="listitem"
        >
          <section
            role="group"
            aria-label={`Notifications for ${date.title}`}
          >
            <div className="notes-external-group-title">
              <ChevronRight
                aria-hidden="true"
                className="notes-external-group-chevron"
                data-expanded={date.collapsed ? undefined : "true"}
                size={15}
              />
              <span className="notes-external-bullet" aria-hidden="true" />
              <h3>{date.title}</h3>
            </div>
            {children.length > 0 && (
              <ol className="notes-external-children">
                {children.map((row) => {
                  if (row.kind === "stored") {
                    return renderStoredRow(row.nodeId, row.depth);
                  }
                  const serializedKey = serializeExternalBulletKey(
                    row.bullet.key
                  );
                  return (
                    <NotesExternalBulletRow
                      key={row.key}
                      bullet={row.bullet}
                      completing={
                        page?.completingKeys.has(serializedKey) ?? false
                      }
                      completionError={
                        page?.completionErrors[serializedKey] ?? null
                      }
                    />
                  );
                })}
              </ol>
            )}
          </section>
        </li>
      ))}
    </>
  );
}
