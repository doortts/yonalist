import {
  GITHUB_NOTIFICATIONS_PROVIDER_ID,
  GITHUB_NOTIFICATIONS_PROVIDER_TITLE
} from "./githubNotificationsProvider";

export const builtinExternalSourceDescriptors = [
  {
    id: GITHUB_NOTIFICATIONS_PROVIDER_ID,
    title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE
  }
] as const;
