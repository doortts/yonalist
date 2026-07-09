import { Menu } from "@base-ui/react/menu";
import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  Eye,
  GitPullRequestClosed,
  MessageSquare,
  Pencil,
  Send
} from "lucide-react";
import {
  type FocusEvent,
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type {
  DiscussionCloseReason,
  IssueCloseReason,
  ItemKind
} from "../domain/types";
import { MarkdownBody } from "./MarkdownBody";
import "./ui/composer-dock.css";

type ComposerMode = "write" | "preview";

export type ComposerCloseAction =
  | {
      kind: "issue";
      reason: IssueCloseReason;
      duplicateIssueId?: number;
    }
  | {
      kind: "discussion";
      reason: DiscussionCloseReason;
    }
  | {
      kind: "pull";
    };

export type CommentSubmitAction =
  | { type: "comment" }
  | { type: "comment-and-close"; close: ComposerCloseAction };

interface CommentComposerProps {
  draft: string;
  online: boolean;
  canClose?: boolean;
  closeKind?: ItemKind;
  disabled?: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: (action: CommentSubmitAction) => void;
}

const ISSUE_CLOSE_OPTIONS: Array<{
  reason: IssueCloseReason;
  label: string;
  description: string;
}> = [
  {
    reason: "completed",
    label: "Close as completed",
    description: "Done, closed, fixed, resolved"
  },
  {
    reason: "not_planned",
    label: "Close as not planned",
    description: "Won't fix, can't repro, stale"
  },
  {
    reason: "duplicate",
    label: "Close as duplicate",
    description: "Duplicate of another issue"
  }
];

const DISCUSSION_CLOSE_OPTIONS: Array<{
  reason: DiscussionCloseReason;
  label: string;
  description: string;
}> = [
  {
    reason: "resolved",
    label: "Close as resolved",
    description: "The discussion has been resolved"
  },
  {
    reason: "outdated",
    label: "Close as outdated",
    description: "The discussion is no longer relevant"
  },
  {
    reason: "duplicate",
    label: "Close as duplicate",
    description: "The discussion is a duplicate of another"
  }
];

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
  closeKind,
  disabled = false,
  onDraftChange,
  onSubmit
}: CommentComposerProps) {
  const [mode, setMode] = useState<ComposerMode>("write");
  const [issueCloseReason, setIssueCloseReason] =
    useState<IssueCloseReason>("completed");
  const [duplicateIssueId, setDuplicateIssueId] = useState<number | undefined>();
  const [discussionCloseReason, setDiscussionCloseReason] =
    useState<DiscussionCloseReason>("resolved");
  const [closeMenuOpen, setCloseMenuOpen] = useState(false);
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
  // Set when a toggle click lands the composer back on write, so the effect
  // below can hand focus to the textarea once it remounts. Only a deliberate
  // toggle sets it — the empty-draft force-back-to-write path leaves it false
  // and never steals focus.
  const restoreFocusRef = useRef(false);
  const hasDraft = draft.trim().length > 0;
  const effectiveCloseKind = closeKind ?? (canClose ? "issue" : undefined);
  // A draft, active focus, or having settled at the thread's end each expand the
  // composer; otherwise it stays a thin one-line docked bar.
  const expanded = hasDraft || focused || settled;
  const canSubmitClose = Boolean(closeAction()) && !disabled;

  useEffect(() => {
    if (!hasDraft && mode === "preview") {
      setMode("write");
    }
  }, [hasDraft, mode]);

  // After a toggle returns to write, the textarea has just remounted; restore
  // focus so the reader can keep typing without a second click.
  useEffect(() => {
    if (mode === "write" && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      textareaRef.current?.focus();
    }
  }, [mode]);

  function toggleMode() {
    const next = mode === "write" ? "preview" : "write";
    restoreFocusRef.current = next === "write";
    setMode(next);
  }

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
    onSubmit({ type: "comment" });
  }

  function submitAndClose() {
    const close = closeAction();
    if (disabled || !close) {
      return;
    }
    onSubmit({ type: "comment-and-close", close });
  }

  function closeAction(): ComposerCloseAction | null {
    if (effectiveCloseKind === "issue") {
      return {
        kind: "issue",
        reason: issueCloseReason,
        ...(issueCloseReason === "duplicate" &&
        duplicateIssueId !== undefined
          ? { duplicateIssueId }
          : {})
      };
    }
    if (effectiveCloseKind === "discussion") {
      return { kind: "discussion", reason: discussionCloseReason };
    }
    if (effectiveCloseKind === "pull") {
      return { kind: "pull" };
    }
    return null;
  }

  function selectIssueCloseReason(reason: IssueCloseReason) {
    if (reason === "duplicate") {
      const value = window.prompt("Duplicate issue number");
      const parsed = Number.parseInt(String(value ?? "").replace(/^#/, ""), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return;
      }
      setDuplicateIssueId(parsed);
    } else {
      setDuplicateIssueId(undefined);
    }
    setIssueCloseReason(reason);
    setCloseMenuOpen(false);
  }

  function closeButtonLabel(): string {
    if (!online) {
      return "Queue and close";
    }
    if (effectiveCloseKind === "discussion") {
      return "Close discussion";
    }
    if (effectiveCloseKind === "pull") {
      return "Close pull request";
    }
    return hasDraft ? "Close with comment" : "Close issue";
  }

  function renderCloseMenu() {
    if (effectiveCloseKind === "issue") {
      return (
        <Menu.Root open={closeMenuOpen} onOpenChange={setCloseMenuOpen}>
          <div className="composer-close-split">
            <button
              className="secondary-danger-button composer-close-main"
              type="button"
              disabled={!canSubmitClose}
              onClick={submitAndClose}
            >
              <CircleCheck size={17} />
              {closeButtonLabel()}
            </button>
            <Menu.Trigger
              className="secondary-danger-button composer-close-trigger"
              type="button"
              aria-label="Close options"
              disabled={!canSubmitClose}
              onClick={() => setCloseMenuOpen(true)}
            >
              <ChevronDown size={16} />
            </Menu.Trigger>
          </div>
          <Menu.Portal>
            <Menu.Positioner side="top" align="end" sideOffset={8}>
              <Menu.Popup className="composer-close-menu">
                {ISSUE_CLOSE_OPTIONS.map((option) => {
                  const selected = issueCloseReason === option.reason;
                  return (
                    <Menu.Item
                      key={option.reason}
                      className="composer-close-menu-item"
                      onClick={() => selectIssueCloseReason(option.reason)}
                    >
                      <span className="composer-close-check">
                        {selected && <Check size={18} />}
                      </span>
                      <span className="composer-close-option-icon">
                        {option.reason === "completed" ? (
                          <CircleCheck size={22} />
                        ) : (
                          <CircleSlash size={22} />
                        )}
                      </span>
                      <span className="composer-close-option-copy">
                        <strong>{option.label}</strong>
                        <span>{option.description}</span>
                      </span>
                      {option.reason === "duplicate" && (
                        <ChevronDown
                          className="composer-close-duplicate-arrow"
                          size={18}
                        />
                      )}
                    </Menu.Item>
                  );
                })}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      );
    }

    if (effectiveCloseKind === "discussion") {
      return (
        <Menu.Root open={closeMenuOpen} onOpenChange={setCloseMenuOpen}>
          <div className="composer-close-split">
            <button
              className="secondary-danger-button composer-close-main"
              type="button"
              disabled={!canSubmitClose}
              onClick={submitAndClose}
            >
              <MessageSquare size={17} />
              {closeButtonLabel()}
            </button>
            <Menu.Trigger
              className="secondary-danger-button composer-close-trigger"
              type="button"
              aria-label="Close options"
              disabled={!canSubmitClose}
              onClick={() => setCloseMenuOpen(true)}
            >
              <ChevronDown size={16} />
            </Menu.Trigger>
          </div>
          <Menu.Portal>
            <Menu.Positioner side="top" align="end" sideOffset={8}>
              <Menu.Popup className="composer-close-menu composer-close-menu-discussion">
                {DISCUSSION_CLOSE_OPTIONS.map((option) => {
                  const selected = discussionCloseReason === option.reason;
                  return (
                    <Menu.Item
                      key={option.reason}
                      className="composer-close-menu-item"
                      onClick={() => {
                        setDiscussionCloseReason(option.reason);
                        setCloseMenuOpen(false);
                      }}
                    >
                      <span className="composer-close-check">
                        {selected && <Check size={18} />}
                      </span>
                      <span className="composer-close-option-icon">
                        <MessageSquare size={22} />
                      </span>
                      <span className="composer-close-option-copy">
                        <strong>{option.label}</strong>
                        <span>{option.description}</span>
                      </span>
                    </Menu.Item>
                  );
                })}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      );
    }

    if (effectiveCloseKind === "pull") {
      return (
        <button
          className="secondary-danger-button composer-close-main composer-close-single"
          type="button"
          disabled={!canSubmitClose}
          onClick={submitAndClose}
        >
          <GitPullRequestClosed size={17} />
          {closeButtonLabel()}
        </button>
      );
    }

    return null;
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
        {/* A single mode switch that always points at the *opposite* surface
         * (write -> Preview, preview -> Write), mirroring GitHub's Preview<->Edit
         * swap. A two-tab tablist with only one meaningful choice would be
         * ARIA-noise, so this is a plain button; its visible label is the
         * action, so no aria-pressed (that would be a conflicting signal). It
         * inherits the overlay placement so appearing on first keystroke never
         * shifts the editing surface. */}
        {hasDraft && (
          <button
            type="button"
            className="composer-preview-toggle composer-tabs-overlay"
            onClick={toggleMode}
          >
            {mode === "write" ? (
              <>
                <Eye size={14} />
                Preview
              </>
            ) : (
              <>
                <Pencil size={14} />
                Write
              </>
            )}
          </button>
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

        {expanded && (
          <div className="composer-actions">
            <span>
              {online
                ? "Comments are queued first, then synced."
                : "Offline comment will wait in the outbox."}
            </span>
            <div className="composer-buttons">
              {renderCloseMenu()}
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
