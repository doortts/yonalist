import { createContext, useContext } from "react";
import type {
  ExternalBulletKey,
  ExternalSourcePageSnapshot
} from "./domain/externalSources";

export interface ExternalSourcesBoundary {
  readonly pages: readonly ExternalSourcePageSnapshot[];
  readonly activeProviderId: string | null;
  selectProvider(providerId: string | null): void;
  refresh(providerId: string): Promise<void>;
  complete(key: ExternalBulletKey): Promise<void>;
  openDetails(key: ExternalBulletKey): void;
}

export const rejectUnavailableExternalSource = () =>
  Promise.reject<void>(new Error("External source is unavailable."));

const emptyExternalSources: ExternalSourcesBoundary = {
  pages: [],
  activeProviderId: null,
  selectProvider: () => undefined,
  refresh: rejectUnavailableExternalSource,
  complete: rejectUnavailableExternalSource,
  openDetails: () => undefined
};

export const ExternalSourcesContext =
  createContext<ExternalSourcesBoundary>(emptyExternalSources);

export function useExternalSources(): ExternalSourcesBoundary {
  return useContext(ExternalSourcesContext);
}
