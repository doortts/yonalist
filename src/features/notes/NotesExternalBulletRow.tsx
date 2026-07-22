import { Check, ChevronRight, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
      data-expanded={expanded ? "true" : "false"}
      data-completed={bullet.completed ? "true" : "false"}
    >
      <div className="notes-external-row-main">
        <button
          className="notes-external-expand"
          type="button"
          aria-label={`${expanded ? "접기" : "펼치기"}: ${bullet.title}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <span className="notes-external-bullet" aria-hidden="true" />
        <button
          className="notes-external-title"
          type="button"
          aria-pressed={selected}
          onClick={() => setSelected((current) => !current)}
          onKeyDown={handleTitleKeyDown}
        >
          {bullet.title}
        </button>
        {bullet.capabilities.openDetails && (
          <button
            className="notes-external-details"
            type="button"
            onClick={() => externalSources.openDetails(bullet.key)}
          >
            <ExternalLink size={13} aria-hidden="true" />
            상세보기
          </button>
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
      {expanded && bullet.note && (
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
