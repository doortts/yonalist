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
  Provider: PassthroughFeatureProvider,
  renderPanes: ({ renderInboxPanes }) => renderInboxPanes()
};
