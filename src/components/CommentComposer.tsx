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

type ComposerSurface = "flow" | "dock";

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
  const [dockExpanded, setDockExpanded] = useState(false);
  const [flowVisible, setFlowVisible] = useState(
    () => typeof IntersectionObserver === "undefined"
  );
  const flowFormRef = useRef<HTMLFormElement | null>(null);
  const flowTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dockTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Set when a toggle click lands the composer back on write, so the effect
  // below can hand focus to the textarea once it remounts. Only a deliberate
  // toggle sets it — the empty-draft force-back-to-write path leaves it false
  // and never steals focus.
  const restoreFocusRef = useRef(false);
  const focusDockRef = useRef(false);
  const hasDraft = draft.trim().length > 0;
  const effectiveCloseKind = closeKind ?? (canClose ? "issue" : undefined);
  const canSubmitClose = Boolean(closeAction()) && !disabled;
  const dockVisible = !flowVisible;
  const dockFull = dockExpanded || hasDraft;

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
      const textarea =
        dockVisible && dockFull ? dockTextareaRef.current : flowTextareaRef.current;
      textarea?.focus();
    }
  }, [dockFull, dockVisible, mode]);

  useLayoutEffect(() => {
    if (dockFull && focusDockRef.current) {
      focusDockRef.current = false;
      dockTextareaRef.current?.focus();
    }
  }, [dockFull]);

  function toggleMode() {
    const next = mode === "write" ? "preview" : "write";
    restoreFocusRef.current = next === "write";
    setMode(next);
  }

  useLayoutEffect(() => {
    // The in-flow composer auto-grows. The floating dock leaves height to CSS
    // so its collapsed slice stays stable and its expanded textarea can be
    // resized by the user without React immediately overwriting that height.
    if (dockTextareaRef.current) {
      dockTextareaRef.current.style.height = "";
    }
    for (const textarea of [flowTextareaRef.current]) {
      if (!textarea) {
        continue;
      }
      if (mode !== "write") {
        textarea.style.height = "";
        continue;
      }
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [dockFull, dockVisible, draft, mode]);

  useLayoutEffect(() => {
    const flowForm = flowFormRef.current;
    if (!flowForm || typeof IntersectionObserver === "undefined") {
      setFlowVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) {
          setFlowVisible(entry.isIntersecting);
        }
      },
      {
        root: findScrollParent(flowForm),
        rootMargin: "0px 0px -48px 0px",
        threshold: 0
      }
    );
    observer.observe(flowForm);
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

  function expandDock() {
    focusDockRef.current = true;
    setDockExpanded(true);
  }

  function handleDockBlur(event: FocusEvent<HTMLFormElement>) {
    if (
      !hasDraft &&
      !event.currentTarget.contains(event.relatedTarget as Node | null)
    ) {
      setDockExpanded(false);
    }
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

  function renderSurface(
    surface: ComposerSurface,
    options: { accessible: boolean; full: boolean }
  ) {
    const textareaRef = surface === "dock" ? dockTextareaRef : flowTextareaRef;
    const textareaId = `comment-draft-${surface}`;
    return (
      <>
        {hasDraft && options.full && (
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

        {mode === "write" || !options.full ? (
          <textarea
            ref={textareaRef}
            id={textareaId}
            aria-label={options.accessible ? "Write a comment" : undefined}
            placeholder="Write a comment..."
            value={draft}
            disabled={disabled}
            rows={options.full ? 4 : 1}
            onFocus={surface === "dock" ? expandDock : undefined}
            onChange={(event) => {
              if (surface === "dock") {
                setDockExpanded(true);
              }
              onDraftChange(event.target.value);
            }}
          />
        ) : (
          <div
            className="comment-preview"
            aria-label={options.accessible ? "Comment preview" : undefined}
          >
            {options.accessible && hasDraft ? (
              <MarkdownBody body={draft} />
            ) : options.accessible ? (
              <p className="comment-preview-empty">Nothing to preview.</p>
            ) : null}
          </div>
        )}

        {options.full && (
          <div className="composer-actions">
            <span>
              {online
                ? "Comments are queued first, then synced."
                : "Offline comment will wait in the outbox."}
            </span>
            <div className="composer-buttons">
              {options.accessible && renderCloseMenu()}
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
      </>
    );
  }

  return (
    <>
      <form
        ref={flowFormRef}
        className="comment-composer comment-composer-flow is-expanded"
        data-expanded="true"
        aria-hidden={dockVisible ? "true" : undefined}
        onSubmit={submit}
      >
        {renderSurface("flow", { accessible: !dockVisible, full: true })}
      </form>

      {dockVisible && (
        <form
          className={`comment-composer comment-composer-dock ${
            dockFull ? "is-expanded" : "is-collapsed"
          }`}
          data-expanded={dockFull ? "true" : "false"}
          onSubmit={submit}
          onBlur={handleDockBlur}
        >
          {renderSurface("dock", { accessible: true, full: dockFull })}
        </form>
      )}
    </>
  );
}
