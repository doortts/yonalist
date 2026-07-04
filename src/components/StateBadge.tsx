import {
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  MessagesSquare
} from "lucide-react";
import type { ItemKind } from "../domain/types";

interface StateBadgeProps {
  kind: ItemKind;
  state: string;
  draft?: boolean;
}

/**
 * GitHub-style state pill: a subject icon plus the state word, colored like
 * GitHub (open green, merged purple, closed red, draft gray).
 */
export function StateBadge({ kind, state, draft }: StateBadgeProps) {
  if (draft) {
    return (
      <span className="state-badge state-draft">
        <GitPullRequest size={14} />
        Draft
      </span>
    );
  }

  if (state === "merged") {
    return (
      <span className="state-badge state-merged">
        <GitMerge size={14} />
        Merged
      </span>
    );
  }

  if (state === "closed") {
    const Icon = kind === "pull" ? GitPullRequest : CircleSlash;
    return (
      <span className="state-badge state-closed">
        <Icon size={14} />
        Closed
      </span>
    );
  }

  const OpenIcon =
    kind === "pull"
      ? GitPullRequest
      : kind === "discussion"
        ? MessagesSquare
        : CircleDot;
  return (
    <span className="state-badge state-open">
      <OpenIcon size={14} />
      Open
    </span>
  );
}
