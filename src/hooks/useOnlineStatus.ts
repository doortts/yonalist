import { useCallback, useEffect, useState } from "react";

/**
 * Tracks connectivity from browser online/offline events while still letting
 * the user force offline mode manually for Yonalist and GN testing.
 */
export function useOnlineStatus(initialOnline?: boolean) {
  const [online, setOnline] = useState(
    initialOnline ?? (typeof navigator === "undefined" ? true : navigator.onLine)
  );

  useEffect(() => {
    function handleOnline() {
      setOnline(true);
    }
    function handleOffline() {
      setOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const toggleOnline = useCallback(() => {
    setOnline((current) => !current);
  }, []);

  return { online, toggleOnline };
}
