import { NotebookPen } from "lucide-react";
import { settingsFeature } from "../settings/SettingsFeature";
import type { FeatureDefinition, FeatureId } from "./featureTypes";

const notesFeature: FeatureDefinition = {
  id: "notes",
  label: "Yonalist",
  icon: NotebookPen,
  section: "workspace",
  order: 20,
  // Notes owns a live workspace session. Retain its runtime and mounted panes
  // after the first activation so drafts, scroll, and edit focus survive
  // navigation between Yonalist and Settings.
  keepMounted: true,
  loadRuntime: () =>
    import("../notes/NotesFeature").then(
      ({ notesFeatureRuntime }) => notesFeatureRuntime
    )
};

export const featureRegistry: readonly FeatureDefinition[] = [
  notesFeature,
  settingsFeature
];

const definitionsById: Record<FeatureId, FeatureDefinition> = {
  notes: notesFeature,
  settings: settingsFeature
};

export function getFeatureDefinition(featureId: FeatureId): FeatureDefinition {
  return definitionsById[featureId];
}
