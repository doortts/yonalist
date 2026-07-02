import { useCallback, useEffect, useState } from "react";
import {
  availableUrls,
  displayLabel,
  isDefaultUrl,
  loadServersState,
  persistServersState,
  personalTokenFor,
  removeUrl,
  resetServers,
  selectUrl,
  upsertServer,
  usesPersonalToken,
  type GithubServersState
} from "../services/githubServers";

export interface UseGithubServersResult {
  state: GithubServersState;
  urls: string[];
  selectedUrl: string;
  labelOf: (url: string) => string;
  isDefault: (url: string) => boolean;
  tokenOf: (url: string) => string | null;
  usesToken: (url: string) => boolean;
  select: (url: string) => void;
  upsert: (input: { url: string; alias?: string; personalToken?: string }) => void;
  remove: (url: string) => void;
  reset: () => void;
}

export function useGithubServers(): UseGithubServersResult {
  const [state, setState] = useState<GithubServersState>(() => loadServersState());

  useEffect(() => {
    persistServersState(state);
  }, [state]);

  const select = useCallback((url: string) => {
    setState((current) => selectUrl(current, url));
  }, []);

  const upsert = useCallback(
    (input: { url: string; alias?: string; personalToken?: string }) => {
      setState((current) => upsertServer(current, input));
    },
    []
  );

  const remove = useCallback((url: string) => {
    setState((current) => removeUrl(current, url));
  }, []);

  const reset = useCallback(() => {
    setState(resetServers());
  }, []);

  return {
    state,
    urls: availableUrls(state),
    selectedUrl: state.selectedUrl,
    labelOf: (url) => displayLabel(state, url),
    isDefault: isDefaultUrl,
    tokenOf: (url) => personalTokenFor(state, url),
    usesToken: (url) => usesPersonalToken(state, url),
    select,
    upsert,
    remove,
    reset
  };
}
