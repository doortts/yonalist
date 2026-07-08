function keyFromDate(date: Date): string {
  if (Number.isNaN(date.valueOf())) {
    return "unknown";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}

export function localDateKey(iso: string): string {
  return keyFromDate(new Date(iso));
}

export function dateGroupLabel(key: string, now = new Date()): string {
  if (key === "unknown") {
    return key;
  }

  const todayKey = keyFromDate(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = keyFromDate(yesterday);

  if (key === todayKey) {
    return "Today";
  }
  if (key === yesterdayKey) {
    return "Yesterday";
  }

  const [year, month, day] = key.split(".");
  if (Number(year) === now.getFullYear()) {
    return `${month}.${day}`;
  }
  return key;
}
