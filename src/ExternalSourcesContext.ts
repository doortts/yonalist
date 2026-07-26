import { createContext, useContext } from "react";
import type {
  ExternalBulletKey,
  ExternalSourcePageSnapshot
} from "./domain/externalSources";
import type { GitHubNotification } from "./domain/notifications";

export interface GithubMaterializedRefreshRequest {
  readonly connectionId: string;
  readonly webBaseUrl: string;
  readonly items: readonly GitHubNotification[];
  readonly syncedAt: string;
}

export type GithubMaterializedRefreshOutcome =
  | "committed"
  | "skipped"
  | "failed";

export type GithubMaterializedRefreshHandler = (
  request: GithubMaterializedRefreshRequest
) => Promise<GithubMaterializedRefreshOutcome>;

export interface ExternalSourcesBoundary {
  readonly pages: readonly ExternalSourcePageSnapshot[];
  /** The one App-owned projection clock shared by GitHub source labels. */
  readonly projectionNowMs?: number;
  readonly githubProjectionRequested?: boolean;
  acquireGithubProjection?(): () => void;
  registerGithubMaterializedRefresh?(
    handler: GithubMaterializedRefreshHandler
  ): () => void;
  refresh(providerId: string): Promise<void>;
  complete(key: ExternalBulletKey): Promise<void>;
  openDetails(key: ExternalBulletKey, fallbackUrl?: string): void;
}

export const rejectUnavailableExternalSource = () =>
  Promise.reject<void>(new Error("External source is unavailable."));

const emptyExternalSources: ExternalSourcesBoundary = {
  pages: [],
  githubProjectionRequested: false,
  acquireGithubProjection: () => () => undefined,
  registerGithubMaterializedRefresh: () => () => undefined,
  refresh: rejectUnavailableExternalSource,
  complete: rejectUnavailableExternalSource,
  openDetails: () => undefined
};

export const ExternalSourcesContext =
  createContext<ExternalSourcesBoundary>(emptyExternalSources);

export function useExternalSources(): ExternalSourcesBoundary {
  return useContext(ExternalSourcesContext);
}
