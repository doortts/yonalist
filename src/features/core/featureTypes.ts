import type { LucideIcon } from "lucide-react";
import type { ComponentType, PropsWithChildren, ReactNode } from "react";

export type FeatureId = "notes" | "settings";

export type FeatureNavigationSection = "workspace" | "app";

export interface FeatureNavigationContent {
  headerActions: ReactNode;
  content: ReactNode;
}

export interface FeaturePanes {
  navigation?: FeatureNavigationContent;
  middle?: ReactNode;
  detail: ReactNode;
}

export interface FeatureRenderContext {
  renderSettingsPanes: () => FeaturePanes;
}

export interface FeatureMetadata {
  id: FeatureId;
  label: string;
  icon: LucideIcon;
  section: FeatureNavigationSection;
  order: number;
  /**
   * When true the feature's panes stay mounted (hidden) while another feature
   * is active, instead of being torn down on every switch. Reserved for
   * features that own a live session whose in-memory state — drafts, scroll,
   * edit focus — must survive navigating away and back (Notes). Stateless,
   * App-state-driven features leave this false so their panes only mount while
   * active. Providers are always mounted regardless; this only governs panes.
   */
  keepMounted: boolean;
}

export interface FeatureRuntime {
  Provider: ComponentType<PropsWithChildren>;
  renderPanes: (context: FeatureRenderContext) => FeaturePanes;
}

export type FeatureDefinition = FeatureMetadata &
  (
    | { runtime: FeatureRuntime; loadRuntime?: never }
    | { runtime?: never; loadRuntime: () => Promise<FeatureRuntime> }
  );
