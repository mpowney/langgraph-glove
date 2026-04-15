import React from "react";
import {
  FluentProvider,
  Spinner,
  makeStyles,
  Text,
  tokens,
} from "@fluentui/react-components";
import { useAppInfo } from "./hooks/useAppInfo";
import { useTheme } from "./hooks/useTheme";
import { useAuth } from "./hooks/useAuth";
import { useTopology } from "./hooks/useTopology";
import { AuthGate } from "./components/AuthGate";
import { AppHeader } from "./components/AppHeader";
import { TopologyMap } from "./components/TopologyMap";

function resolveAuthApiBaseUrl(rawApiUrl: string | undefined): string | null {
  if (!rawApiUrl?.trim()) return null;

  try {
    const url = new URL(rawApiUrl);
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(url.hostname)) {
      url.hostname = window.location.hostname;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return rawApiUrl;
  }
}

const useStyles = makeStyles({
  shell: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100dvh",
    overflow: "hidden",
    background:
      "radial-gradient(circle at 7% 7%, rgba(255, 145, 0, 0.14), transparent 30%), radial-gradient(circle at 92% 90%, rgba(0, 170, 156, 0.12), transparent 33%)",
  },
  loading: {
    flex: 1,
    display: "grid",
    placeItems: "center",
    gap: tokens.spacingVerticalM,
  },
  error: {
    padding: tokens.spacingHorizontalL,
  },
});

function App() {
  const styles = useStyles();
  const theme = useTheme();
  const appInfo = useAppInfo();
  const resolvedAdminApiBaseUrl = resolveAuthApiBaseUrl(appInfo?.apiUrl) ?? "";
  const adminApiBaseUrl = import.meta.env.DEV ? "" : resolvedAdminApiBaseUrl;
  const authApiBaseUrl = adminApiBaseUrl;

  const auth = useAuth(authApiBaseUrl);
  const topology = useTopology(adminApiBaseUrl, auth.token);

  if (authApiBaseUrl !== null && (!auth.authenticated || auth.setupRequired || auth.loading)) {
    return (
      <FluentProvider theme={theme}>
        <AuthGate
          loading={auth.loading}
          setupRequired={auth.setupRequired}
          error={auth.error}
          onLogin={auth.login}
          onLoginWithPasskey={auth.loginWithPasskey}
          onRefresh={auth.refreshStatus}
        />
      </FluentProvider>
    );
  }

  return (
    <FluentProvider theme={theme}>
      <div className={styles.shell}>
        <AppHeader
          title={appInfo?.name ?? "LangGraph Glove Observability"}
          subtitle={appInfo?.description ?? "Graph topology map"}
          generatedAt={topology.topology?.generatedAt}
          onRefresh={() => void topology.refresh()}
          onLogout={() => void auth.logout()}
          loading={topology.loading}
        />

        {topology.loading && !topology.topology ? (
          <div className={styles.loading}>
            <Spinner size="large" />
            <Text>Loading topology...</Text>
          </div>
        ) : null}

        {topology.error ? (
          <Text className={styles.error}>Failed to load topology: {topology.error}</Text>
        ) : null}

        {topology.topology ? <TopologyMap payload={topology.topology} /> : null}
      </div>
    </FluentProvider>
  );
}

export default App;
