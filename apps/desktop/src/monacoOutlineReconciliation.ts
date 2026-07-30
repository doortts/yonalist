export function runMonacoOutlineReconciliation(
  compositionActive: boolean,
  reconcile: () => void
): boolean {
  if (compositionActive) return false;
  reconcile();
  return true;
}
