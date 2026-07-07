import { useEffect } from "react";
import { setAppBadgeCount } from "../services/appBadge";

export function useAppBadge(count: number) {
  useEffect(() => {
    void setAppBadgeCount(count).catch((cause) => {
      console.warn("Failed to update app badge", cause);
    });
  }, [count]);
}
