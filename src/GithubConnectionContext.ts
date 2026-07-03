import { createContext } from "react";
import type { GithubConnection } from "./hooks/useGithubAuth";

/** Current server connection for components that load authenticated assets. */
export const GithubConnectionContext = createContext<GithubConnection>({
  apiBaseUrl: "",
  webBaseUrl: "",
  token: ""
});
