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

const unavailable = () =>
  Promise.reject<void>(new Error("External source is unavailable."));

const emptyExternalSources: ExternalSourcesBoundary = {
  pages: [],
  activeProviderId: null,
  selectProvider: () => undefined,
  refresh: unavailable,
  complete: unavailable,
  openDetails: () => undefined
};

export const ExternalSourcesContext =
  createContext<ExternalSourcesBoundary>(emptyExternalSources);

export function useExternalSources(): ExternalSourcesBoundary {
  return useContext(ExternalSourcesContext);
}
