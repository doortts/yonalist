import { Eye, Pencil, Send } from "lucide-react";
import {
  type FormEvent,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { MarkdownBody } from "./MarkdownBody";

export type CommentSubmitAction = "comment" | "comment-and-close";

interface CommentComposerProps {
  draft: string;
  online: boolean;
  canClose?: boolean;
  disabled?: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: (action: CommentSubmitAction) => void;
}

export function CommentComposer({
  draft,
  online,
  canClose = false,
  disabled = false,
  onDraftChange,
  onSubmit
}: CommentComposerProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasDraft = draft.trim().length > 0;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || mode !== "write") {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft, mode]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!hasDraft || disabled) {
      return;
    }
    onSubmit("comment");
  }

  function submitAndClose() {
    if (!hasDraft || disabled) {
      return;
    }
    onSubmit("comment-and-close");
  }

  return (
    <form className="comment-composer" onSubmit={submit}>
      <div className="composer-tabs" role="tablist" aria-label="Comment editor">
        <button
          type="button"
          className={mode === "write" ? "composer-tab active" : "composer-tab"}
          aria-selected={mode === "write"}
          role="tab"
          onClick={() => setMode("write")}
        >
          <Pencil size={14} />
          Write
        </button>
        <button
          type="button"
          className={mode === "preview" ? "composer-tab active" : "composer-tab"}
          aria-selected={mode === "preview"}
          role="tab"
          onClick={() => setMode("preview")}
        >
          <Eye size={14} />
          Preview
        </button>
      </div>

      {mode === "write" ? (
        <textarea
          ref={textareaRef}
          id="comment-draft"
          aria-label="Write a comment"
          placeholder="Write a comment..."
          value={draft}
          disabled={disabled}
          rows={4}
          onChange={(event) => onDraftChange(event.target.value)}
        />
      ) : (
        <div className="comment-preview" aria-label="Comment preview">
          {hasDraft ? (
            <MarkdownBody body={draft} />
          ) : (
            <p className="comment-preview-empty">Nothing to preview.</p>
          )}
        </div>
      )}

      <div className="composer-actions">
        <span>
          {online
            ? "Comments are queued first, then synced."
            : "Offline comment will wait in the outbox."}
        </span>
        <div className="composer-buttons">
          {canClose && (
            <button
              className="secondary-danger-button"
              type="button"
              disabled={!hasDraft || disabled}
              onClick={submitAndClose}
            >
              {online ? "Comment and close" : "Queue and close"}
            </button>
          )}
          <button
            className={online ? "primary-button comment-button" : "primary-button"}
            type="submit"
            disabled={!hasDraft || disabled}
          >
            <Send size={16} />
            {online ? "Comment" : "Queue comment"}
          </button>
        </div>
      </div>
    </form>
  );
}
