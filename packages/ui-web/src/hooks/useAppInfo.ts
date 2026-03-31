import { useState, useEffect } from "react";
import type { AppInfo } from "../types";

export function useAppInfo(): AppInfo | null {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    fetch("/api/info")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AppInfo | null) => {
        if (data) setAppInfo(data);
      })
      .catch(() => {
        // Silently ignore — AppInfo is optional display metadata
      });
  }, []);

  return appInfo;
}
