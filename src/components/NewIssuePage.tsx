import { Send, X, ChevronDown, Check } from "lucide-react";
import type { FormEvent } from "react";
import { Select } from "@base-ui/react/select";
import "./ui/select.css";

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
            <Select.Root
              value={draft.repositoryKey}
              onValueChange={(value) =>
                onChange({ ...draft, repositoryKey: value ?? "" })
              }
            >
              <Select.Trigger
                className="select-trigger"
                aria-label="Target repository"
              >
                <Select.Value className="select-value">
                  {(value) => {
                    const selected = repositories.find(
                      (repository) => repository.key === value
                    );
                    return selected
                      ? `${selected.owner}/${selected.repo}`
                      : "";
                  }}
                </Select.Value>
                <Select.Icon className="select-icon">
                  <ChevronDown size={16} />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner
                  className="select-positioner"
                  sideOffset={4}
                  alignItemWithTrigger={false}
                >
                  <Select.Popup className="select-popup">
                    {repositories.map((repository) => (
                      <Select.Item
                        key={repository.key}
                        value={repository.key}
                        className="select-item"
                      >
                        <Select.ItemIndicator className="select-item-indicator">
                          <Check size={14} />
                        </Select.ItemIndicator>
                        <Select.ItemText className="select-item-text">
                          {repository.owner}/{repository.repo}
                        </Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
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
