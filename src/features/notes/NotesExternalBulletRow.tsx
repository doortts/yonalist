import {
  Bell,
  Check,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  Globe2,
  MessagesSquare,
  Tag
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import { useExternalSources } from "../../ExternalSourcesContext";
import {
  serializeExternalBulletKey,
  type ExternalBullet
} from "../../domain/externalSources";

interface NotesExternalBulletRowProps {
  bullet: ExternalBullet;
  completing: boolean;
  completionError: string | null;
}

const completionFailure = "Unable to complete external item.";

function ExternalBulletLead({ icon }: Pick<ExternalBullet, "icon">) {
  if (!icon) {
    return <span className="notes-external-bullet" aria-hidden="true" />;
  }

  let lead;
  switch (icon) {
    case "issue":
      lead = <CircleDot size={15} role="img" aria-label="Issue" />;
      break;
    case "pull-request":
      lead = <GitPullRequest size={15} role="img" aria-label="Pull Request" />;
      break;
    case "discussion":
      lead = <MessagesSquare size={15} role="img" aria-label="Discussion" />;
      break;
    case "release":
      lead = <Tag size={15} role="img" aria-label="Release" />;
      break;
    case "notification":
      lead = <Bell size={15} role="img" aria-label="Notification" />;
      break;
  }
  return <span className="notes-external-icon">{lead}</span>;
}

export function NotesExternalBulletRow({
  bullet,
  completing,
  completionError
}: NotesExternalBulletRowProps) {
  const externalSources = useExternalSources();
  const [selected, setSelected] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const completionGuardRef = useRef(false);
  const serializedKey = serializeExternalBulletKey(bullet.key);
  const visibleError = completionError ?? localError;

  useEffect(() => {
    if (bullet.completed) {
      setLocalError(null);
    }
  }, [bullet.completed]);

  const requestComplete = async () => {
    if (
      bullet.completed ||
      !bullet.capabilities.complete ||
      completing ||
      completionGuardRef.current
    ) {
      return;
    }
    completionGuardRef.current = true;
    setPending(true);
    setLocalError(null);
    try {
      await externalSources.complete(bullet.key);
    } catch {
      setLocalError(completionFailure);
    } finally {
      completionGuardRef.current = false;
      setPending(false);
    }
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void requestComplete();
    }
  };

  return (
    <li
      className="notes-external-row"
      data-external-bullet-key={serializedKey}
      data-selected={selected ? "true" : "false"}
      data-expanded={
        bullet.capabilities.expand && expanded ? "true" : "false"
      }
      data-completed={bullet.completed ? "true" : "false"}
      aria-busy={completing || pending}
    >
      <div className="notes-external-row-main">
        {bullet.capabilities.expand ? (
          <button
            className="notes-external-expand"
            type="button"
            aria-label={`${expanded ? "접기" : "펼치기"}: ${bullet.title}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <ExternalBulletLead icon={bullet.icon} />
        <button
          className="notes-external-title"
          type="button"
          aria-label={bullet.completed ? `${bullet.title}, 완료됨` : undefined}
          aria-pressed={selected}
          onClick={() => setSelected((current) => !current)}
          onKeyDown={handleTitleKeyDown}
        >
          {bullet.title}
        </button>
        {bullet.capabilities.openDetails && (
          <IconTooltip label="웹에서 열기">
            <button
              className="notes-external-details"
              type="button"
              aria-label={`웹에서 열기: ${bullet.title}`}
              onClick={() => externalSources.openDetails(bullet.key)}
            >
              <Globe2 size={15} aria-hidden="true" />
            </button>
          </IconTooltip>
        )}
        {bullet.capabilities.complete && !bullet.completed && (
          <button
            className="notes-external-complete"
            type="button"
            aria-label={`완료: ${bullet.title}`}
            aria-pressed="false"
            disabled={completing || pending}
            onClick={() => void requestComplete()}
          >
            <Check size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {bullet.note && (!bullet.capabilities.expand || expanded) && (
        <div className="notes-external-note">
          {bullet.note.split("\n").map((line, index) => (
            <span key={`${index}:${line}`}>{line}</span>
          ))}
        </div>
      )}
      {visibleError && (
        <div className="notes-external-completion-error" role="alert">
          <span>{visibleError}</span>
          <button type="button" onClick={() => void requestComplete()}>
            다시 시도
          </button>
        </div>
      )}
    </li>
  );
}
