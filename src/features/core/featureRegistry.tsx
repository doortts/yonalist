import { inboxFeature } from "../inbox/InboxFeature";
import { notesFeature } from "../notes/NotesFeature";
import { settingsFeature } from "../settings/SettingsFeature";
import type { FeatureDefinition, FeatureId } from "./featureTypes";

export const featureRegistry: readonly FeatureDefinition[] = [
  inboxFeature,
  notesFeature,
  settingsFeature
];

const definitionsById: Record<FeatureId, FeatureDefinition> = {
  inbox: inboxFeature,
  notes: notesFeature,
  settings: settingsFeature
};

export function getFeatureDefinition(featureId: FeatureId): FeatureDefinition {
  return definitionsById[featureId];
}
