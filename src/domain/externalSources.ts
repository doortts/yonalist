export interface ExternalBulletKey {
  readonly providerId: string;
  readonly connectionId: string;
  readonly remoteId: string;
}

export interface GithubNotificationsPluginState {
  readonly collapsedGroups: string[];
}

export type GithubNotificationsPluginMeta =
  | {
      readonly kind: "date";
      readonly dateKey: string;
    }
  | {
      readonly kind: "notification";
      readonly notificationKey: string;
      readonly notificationType: string;
      readonly url: string;
      readonly updatedAt: string;
      readonly unread: boolean;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) => typeof key === "string" && expected.includes(key)
    )
  );
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999) {
    return false;
  }
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isDateKey(value: unknown): value is string {
  const match =
    typeof value === "string"
      ? /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(value)
      : null;
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isCalendarDate(year, month, day);
}

export function isGithubNotificationsPluginState(
  value: unknown
): value is GithubNotificationsPluginState {
  const collapsedGroups = isPlainRecord(value)
    ? value.collapsedGroups
    : undefined;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["collapsedGroups"]) ||
    !Array.isArray(collapsedGroups) ||
    Object.getPrototypeOf(collapsedGroups) !== Array.prototype ||
    Object.keys(collapsedGroups).length !== collapsedGroups.length
  ) {
    return false;
  }
  return (
    collapsedGroups.every(isDateKey) &&
    collapsedGroups.every(
      (group, index) => index === 0 || collapsedGroups[index - 1]! < group
    )
  );
}

function parseCanonicalStringTuple(
  value: string,
  length: number
): string[] | null {
  try {
    const key = JSON.parse(value) as unknown;
    return Array.isArray(key) &&
      Object.getPrototypeOf(key) === Array.prototype &&
      key.length === length &&
      key.every((part) => typeof part === "string") &&
      JSON.stringify(key) === value
        ? key
        : null;
  } catch {
    return null;
  }
}

function isNonemptyId(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

export function isSafeExternalHttpUrl(value: string): boolean {
  const authority = value.startsWith("https://")
    ? value.slice("https://".length)
    : value.startsWith("http://")
      ? value.slice("http://".length)
      : null;
  if (authority === null || authority.length === 0 || authority.startsWith("/")) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.host.length > 0
    );
  } catch {
    return false;
  }
}

function isAppTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(
      value
    );
  return (
    match !== null &&
    isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59
  );
}

function isSerializedGithubNotificationKey(value: string): boolean {
  const key = parseCanonicalStringTuple(value, 3);
  if (
    key === null ||
    key[0] !== "github" ||
    !isNonemptyId(key[2]!)
  ) {
    return false;
  }
  const connection = parseCanonicalStringTuple(key[1]!, 2);
  return (
    connection !== null &&
    isNonemptyId(connection[1]!) &&
    connection[0]!.trim() === connection[0] &&
    !connection[0]!.endsWith("/") &&
    isSafeExternalHttpUrl(connection[0]!)
  );
}

export function isGithubNotificationsPluginMeta(
  value: unknown
): value is GithubNotificationsPluginMeta {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (value.kind === "date") {
    return hasExactKeys(value, ["kind", "dateKey"]) && isDateKey(value.dateKey);
  }
  if (
    value.kind !== "notification" ||
    !hasExactKeys(value, [
      "kind",
      "notificationKey",
      "notificationType",
      "url",
      "updatedAt",
      "unread"
    ]) ||
    typeof value.notificationKey !== "string" ||
    typeof value.notificationType !== "string" ||
    typeof value.url !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.unread !== "boolean"
  ) {
    return false;
  }
  return (
    isSerializedGithubNotificationKey(value.notificationKey) &&
    value.notificationType.length > 0 &&
    !/\s/.test(value.notificationType) &&
    isSafeExternalHttpUrl(value.url) &&
    isAppTimestamp(value.updatedAt)
  );
}

export type ExternalBulletIcon =
  | "issue"
  | "pull-request"
  | "discussion"
  | "release"
  | "notification";

export interface ExternalBullet {
  readonly icon?: ExternalBulletIcon;
  readonly externalUrl?: string;
  readonly key: ExternalBulletKey;
  readonly parentKey: ExternalBulletKey | null;
  readonly title: string;
  readonly note: string;
  readonly updatedAt: string;
  readonly completed: boolean;
  readonly capabilities: {
    readonly expand: boolean;
    readonly openDetails: boolean;
    readonly complete: boolean;
    readonly uncomplete: boolean;
    readonly edit: false;
    readonly move: false;
    readonly delete: false;
    readonly createChild: false;
  };
}

export type ExternalSourceAvailability =
  | "disconnected"
  | "authentication-required"
  | "connecting"
  | "online"
  | "offline";

export interface ExternalSourcePageSnapshot {
  readonly providerId: string;
  readonly connectionId: string | null;
  readonly title: string;
  readonly availability: ExternalSourceAvailability;
  readonly items: readonly ExternalBullet[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly syncedAt: string | null;
  readonly completingKeys: ReadonlySet<string>;
  readonly completionErrors: Readonly<Record<string, string>>;
}

export function serializeExternalBulletKey(key: ExternalBulletKey): string {
  return JSON.stringify([key.providerId, key.connectionId, key.remoteId]);
}

export function parseGithubNotificationKey(
  value: string
): ExternalBulletKey | null {
  if (!isSerializedGithubNotificationKey(value)) {
    return null;
  }
  const key = parseCanonicalStringTuple(value, 3)!;
  return {
    providerId: key[0]!,
    connectionId: key[1]!,
    remoteId: key[2]!
  };
}

export interface ExternalSourceProjectionInput<T, TSettings> {
  readonly items: readonly T[];
  readonly connectionId: string;
  readonly settings: TSettings;
  readonly now: Date;
}

export interface ExternalSourceProvider<T, TSettings = unknown> {
  readonly id: string;
  readonly title: string;
  decodeItem(value: unknown): T | null;
  keyOf(item: T, connectionId: string): ExternalBulletKey;
  canComplete(item: T): boolean;
  normalizeSettings(value: unknown): TSettings;
  project(
    input: ExternalSourceProjectionInput<T, TSettings>
  ): readonly ExternalBullet[];
  load(input: {
    signal: AbortSignal;
    publishPartial(items: readonly T[]): void;
  }): Promise<readonly T[]>;
  markComplete?(input: {
    key: ExternalBulletKey;
    item: T;
    signal: AbortSignal;
  }): Promise<T>;
  openDetails?(key: ExternalBulletKey): void;
}
