export function shouldRestoreMonacoOutlineFocus(
  hasTextFocus: boolean,
  hasPendingCaret: boolean
): boolean {
  return hasTextFocus || hasPendingCaret;
}
