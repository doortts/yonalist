import type { FeatureId } from "./featureTypes";

export type FeatureTimingRecorder = (
  name: string,
  detail: Record<string, unknown>
) => void;

export interface FeatureActivationSample {
  activationId: number;
  featureId: FeatureId;
  startedAt: number;
}

export function beginFeatureActivation(
  activationId: number,
  featureId: FeatureId,
  startedAt: number,
  record: FeatureTimingRecorder
): FeatureActivationSample {
  record("feature_activation_start", { activationId, featureId });
  return { activationId, featureId, startedAt };
}

export function finishFeatureActivation(
  sample: FeatureActivationSample,
  visibleAt: number,
  record: FeatureTimingRecorder
) {
  record("feature_activation_visible", {
    activationId: sample.activationId,
    featureId: sample.featureId,
    durationMs: visibleAt - sample.startedAt
  });
}
