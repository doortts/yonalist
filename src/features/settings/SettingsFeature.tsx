import { Settings } from "lucide-react";
import type { PropsWithChildren } from "react";
import type { FeatureDefinition } from "../core/featureTypes";

function PassthroughFeatureProvider({ children }: PropsWithChildren) {
  return <>{children}</>;
}

export const settingsFeature: FeatureDefinition = {
  id: "settings",
  label: "Settings",
  icon: Settings,
  section: "app",
  order: 10,
  requiresGithubAuth: true,
  // Settings panes are stateless views of App-owned state; they mount only
  // while active.
  keepMounted: false,
  Provider: PassthroughFeatureProvider,
  renderPanes: ({ renderSettingsPanes }) => renderSettingsPanes()
};
