export type ResetProgressStepStatus = "pending" | "running" | "done" | "failed";

export type ResetProgressStatus = "idle" | "running" | "done" | "failed";

export interface ResetProgressItem {
  id: string;
  label: string;
  status: ResetProgressStepStatus;
  detail?: string;
}

export interface ResetProgressState {
  status: ResetProgressStatus;
  steps: ResetProgressItem[];
  message?: string;
}

export const idleResetProgress: ResetProgressState = {
  status: "idle",
  steps: []
};
