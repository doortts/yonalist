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

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
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

function isSerializedGithubNotificationKey(value: string): boolean {
  try {
    const key = JSON.parse(value) as unknown;
    return (
      Array.isArray(key) &&
      Object.getPrototypeOf(key) === Array.prototype &&
      key.length === 3 &&
      key.every(
        (part) => typeof part === "string" && part.trim().length > 0
      ) &&
      key[0] === "github" &&
      JSON.stringify(key) === value
    );
  } catch {
    return false;
  }
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
  try {
    const url = new URL(value.url);
    return (
      isSerializedGithubNotificationKey(value.notificationKey) &&
      value.notificationType.trim().length > 0 &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      Number.isFinite(Date.parse(value.updatedAt))
    );
  } catch {
    return false;
  }
}

export type ExternalBulletIcon =
  | "issue"
  | "pull-request"
  | "discussion"
  | "release"
  | "notification";

export interface ExternalBullet {
  readonly icon?: ExternalBulletIcon;
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
