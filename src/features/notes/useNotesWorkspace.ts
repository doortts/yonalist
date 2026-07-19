/**
 * Stable public facade for the Notes workspace hook.
 *
 * Runtime orchestration stays internal so consumers depend on one small API
 * boundary while the implementation is split without changing import paths.
 */
export * from "./notesWorkspaceRuntime";
