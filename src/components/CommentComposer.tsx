import { Tabs } from "@base-ui/react/tabs";
import { Eye, Pencil, Send } from "lucide-react";
import {
  type FocusEvent,
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { MarkdownBody } from "./MarkdownBody";
import "./ui/composer-tabs.css";
import "./ui/composer-dock.css";

type ComposerMode = "write" | "preview";

export type CommentSubmitAction = "comment" | "comment-and-close";

interface CommentComposerProps {
  draft: string;
  online: boolean;
  canClose?: boolean;
  disabled?: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: (action: CommentSubmitAction) => void;
}

/**
 * Walks up from `node` to the nearest scrollable ancestor. The settle observer
 * uses it as its root so "the composer reached its natural flow position"
 * aligns with the bottom of the detail scroll container rather than the
 * browser viewport.
 */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export function CommentComposer({
  draft,
  online,
  canClose = false,
  disabled = false,
  onDraftChange,
  onSubmit
}: CommentComposerProps) {
  const [mode, setMode] = useState<ComposerMode>("write");
  // Focus lives anywhere within the composer; `settled` means the dock sentinel
  // (rendered just *before* the composer's natural flow position) has scrolled
  // into the detail viewport — i.e. the reader hit the end of the thread.
  const [focused, setFocused] = useState(false);
  // Without an IntersectionObserver we cannot detect the settle point, so fall
  // back to treating the composer as settled — it stays usably expanded rather
  // than stranded in the collapsed bar with no way to reach the buttons.
  const [settled, setSettled] = useState(
    () => typeof IntersectionObserver === "undefined"
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasDraft = draft.trim().length > 0;
  // A draft, active focus, or having settled at the thread's end each expand the
  // composer; otherwise it stays a thin one-line docked bar.
  const expanded = hasDraft || focused || settled;

  useEffect(() => {
    if (!hasDraft && mode === "preview") {
      setMode("write");
    }
  }, [hasDraft, mode]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    // Collapsed (or previewing) leaves the height to CSS so the bar stays a
    // single line; only the expanded write surface auto-grows to its content.
    if (!expanded || mode !== "write") {
      textarea.style.height = "";
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft, mode, expanded]);

  // Register the settle observer in the layout phase (before passive effects).
  // When this composer is embedded in a detail view that also observes its own
  // sentinel (e.g. the sticky title), setting up here first keeps observer
  // registration deterministic instead of racing sibling passive effects.
  useLayoutEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) {
          setSettled(entry.isIntersecting);
        }
      },
      {
        root: findScrollParent(sentinel),
        // The collapsed bar (~55px) is sticky and paints over the bottom edge of
        // the scroll container. Inset the observation rect's bottom so the
        // sentinel only counts as visible once it has risen most of the way past
        // that bar — i.e. the reader is genuinely at the thread's end, not just
        // peeking behind the docked bar. Kept below the ~55px bar height on
        // purpose: while collapsed the only content beneath the sentinel is the
        // bar itself, so a full 55–56px inset would keep the sentinel from ever
        // clearing it and the composer could never expand at the bottom.
        rootMargin: "0px 0px -44px 0px",
        threshold: 0
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

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

  function handleBlur(event: FocusEvent<HTMLFormElement>) {
    // Only treat focus leaving the whole composer as a blur; moving between the
    // textarea, tabs, and buttons keeps it expanded.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocused(false);
    }
  }

  return (
    <>
      {/* The settle sentinel marks the end of the thread's content flow,
       * immediately *before* the sticky composer. Because the composer's flow
       * box stacks below this anchor, expanding/collapsing it grows or shrinks
       * the document *below* the sentinel and never moves the sentinel itself.
       * That keeps the observed geometry independent of the height it toggles,
       * so there is no feedback loop (an after-the-form sentinel rode on the
       * composer height and flickered expand<->collapse near the bottom). */}
      <div
        ref={sentinelRef}
        className="composer-dock-sentinel"
        aria-hidden="true"
      />
      <form
        className={`comment-composer ${expanded ? "is-expanded" : "is-collapsed"}`}
        data-expanded={expanded ? "true" : "false"}
        onSubmit={submit}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
      >
        <Tabs.Root
          className="composer-tabs-root"
          value={mode}
          onValueChange={(value) => setMode(value as ComposerMode)}
        >
          {hasDraft && (
            <Tabs.List
              className="composer-preview-toggle-row composer-tabs-overlay"
              activateOnFocus
            >
              <Tabs.Tab
                value="write"
                className={(state) =>
                  state.active
                    ? "composer-preview-toggle active"
                    : "composer-preview-toggle"
                }
              >
                <Pencil size={14} />
                Write
              </Tabs.Tab>
              <Tabs.Tab
                value="preview"
                className={(state) =>
                  state.active
                    ? "composer-preview-toggle active"
                    : "composer-preview-toggle"
                }
              >
                <Eye size={14} />
                Preview
              </Tabs.Tab>
            </Tabs.List>
          )}

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
        </Tabs.Root>

        {expanded && (
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
                className={
                  online ? "primary-button comment-button" : "primary-button"
                }
                type="submit"
                disabled={!hasDraft || disabled}
              >
                <Send size={16} />
                {online ? "Comment" : "Queue comment"}
              </button>
            </div>
          </div>
        )}
      </form>
    </>
  );
}
