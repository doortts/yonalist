export interface ExternalBulletKey {
  readonly providerId: string;
  readonly connectionId: string;
  readonly remoteId: string;
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
