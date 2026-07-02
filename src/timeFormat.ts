const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Formats an ISO timestamp as a compact relative time like "5m ago". */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.valueOf())) {
    return "";
  }

  const elapsed = now.valueOf() - then.valueOf();
  if (elapsed < 0) {
    return then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (elapsed < MINUTE) {
    return "now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 30 * DAY) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }
  return then.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
