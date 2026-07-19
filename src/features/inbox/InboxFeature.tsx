import { Inbox } from "lucide-react";
import type { PropsWithChildren } from "react";
import type { FeatureDefinition } from "../core/featureTypes";

function PassthroughFeatureProvider({ children }: PropsWithChildren) {
  return <>{children}</>;
}

export const inboxFeature: FeatureDefinition = {
  id: "inbox",
  label: "Inbox",
  icon: Inbox,
  section: "workspace",
  order: 10,
  requiresGithubAuth: true,
  // Inbox panes are pure views of App-owned state, so they cost nothing to
  // rebuild on activation; they mount only while active.
  keepMounted: false,
  runtime: {
    Provider: PassthroughFeatureProvider,
    renderPanes: ({ renderInboxPanes }) => renderInboxPanes()
  }
};
