import type { LucideIcon } from "lucide-react";
import type { ComponentType, PropsWithChildren, ReactNode } from "react";

export type FeatureId = "inbox" | "notes" | "settings";

export type FeatureNavigationSection = "workspace" | "app";

export interface FeaturePanes {
  middle: ReactNode;
  detail: ReactNode;
}

export interface FeatureRenderContext {
  renderInboxPanes: () => FeaturePanes;
  renderSettingsPanes: () => FeaturePanes;
}

export interface FeatureDefinition {
  id: FeatureId;
  label: string;
  icon: LucideIcon;
  section: FeatureNavigationSection;
  order: number;
  requiresGithubAuth: boolean;
  Provider: ComponentType<PropsWithChildren>;
  renderPanes: (context: FeatureRenderContext) => FeaturePanes;
}
