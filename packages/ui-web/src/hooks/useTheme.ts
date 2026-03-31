import { useState, useEffect } from "react";
import { webLightTheme, webDarkTheme, type Theme } from "@fluentui/react-components";

const DARK_MEDIA = "(prefers-color-scheme: dark)";

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia(DARK_MEDIA).matches ? webDarkTheme : webLightTheme,
  );

  useEffect(() => {
    const mq = window.matchMedia(DARK_MEDIA);
    const handler = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? webDarkTheme : webLightTheme);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return theme;
}
