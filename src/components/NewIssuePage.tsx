import { Send, X } from "lucide-react";
import type { FormEvent } from "react";

export interface RepositoryEntry {
  key: string;
  host: string;
  owner: string;
  repo: string;
  count: number;
}

export interface DraftIssue {
  title: string;
  body: string;
  repositoryKey: string;
}

interface NewIssuePageProps {
  draft: DraftIssue;
  repositories: RepositoryEntry[];
  online: boolean;
  onChange: (draft: DraftIssue) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}

export function NewIssuePage({
  draft,
  repositories,
  online,
  onChange,
  onSubmit,
  onClose
}: NewIssuePageProps) {
  return (
    <form className="issue-create-page" aria-label="New issue composer" onSubmit={onSubmit}>
      <header className="issue-create-header">
        <div>
          <p className="eyebrow">{draft.repositoryKey || "New draft"}</p>
          <h2>New issue</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close new issue"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div className="issue-create-body">
        {repositories.length > 1 && (
          <label className="issue-repo-field">
            <span>Repository</span>
            <select
              aria-label="Target repository"
              value={draft.repositoryKey}
              onChange={(event) =>
                onChange({ ...draft, repositoryKey: event.target.value })
              }
            >
              {repositories.map((repository) => (
                <option key={repository.key} value={repository.key}>
                  {repository.owner}/{repository.repo}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="issue-title-field">
          <span>Issue title</span>
          <input
            aria-label="Issue title"
            placeholder="Title"
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </label>
        <label className="issue-body-field">
          <span>Issue body</span>
          <textarea
            aria-label="Issue body"
            placeholder="Write the issue in Markdown..."
            value={draft.body}
            onChange={(event) => onChange({ ...draft, body: event.target.value })}
          />
        </label>
      </div>

      <footer className="issue-create-actions">
        <span>
          {online
            ? "This issue will be queued locally before syncing."
            : "Offline issue will wait in the outbox."}
        </span>
        <button className="primary-button" type="submit">
          <Send size={16} />
          Queue issue
        </button>
      </footer>
    </form>
  );
}
