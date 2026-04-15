import React, { useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  Input,
  makeStyles,
  Text,
  tokens,
} from "@fluentui/react-components";

interface AuthGateProps {
  loading: boolean;
  setupRequired: boolean;
  error: string | null;
  onLogin: (password: string) => Promise<boolean>;
  onLoginWithPasskey: () => Promise<boolean>;
  onRefresh: () => Promise<void>;
}

const useStyles = makeStyles({
  root: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    padding: tokens.spacingHorizontalXXL,
    background:
      "radial-gradient(circle at 10% 10%, rgba(255, 132, 0, 0.14), transparent 48%), radial-gradient(circle at 90% 80%, rgba(0, 184, 169, 0.16), transparent 40%)",
  },
  card: {
    width: "min(560px, 100%)",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  form: {
    display: "grid",
    gap: tokens.spacingVerticalM,
  },
  message: {
    marginTop: tokens.spacingVerticalM,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
});

export function AuthGate(props: AuthGateProps) {
  const styles = useStyles();
  const [password, setPassword] = useState("");

  if (props.setupRequired) {
    return (
      <div className={styles.root}>
        <Card className={styles.card}>
          <CardHeader header={<Text weight="semibold">Observability Requires Account Setup</Text>} />
          <Text className={styles.message}>
            Complete onboarding in ui-web first. Once onboarding is finished, return here and sign in with the same credentials.
          </Text>
          <div className={styles.actions}>
            <Button appearance="primary" onClick={() => void props.onRefresh()} disabled={props.loading}>
              Recheck Setup Status
            </Button>
          </div>
          {props.error ? <Text>{props.error}</Text> : null}
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <Card className={styles.card}>
        <CardHeader header={<Text weight="semibold">Sign In</Text>} />
        <Text>Use the same credentials as ui-web.</Text>
        <div className={styles.form}>
          <Input
            type="password"
            value={password}
            onChange={(_, data) => setPassword(data.value)}
            placeholder="Password"
          />
          <div className={styles.actions}>
            <Button
              appearance="primary"
              onClick={() => void props.onLogin(password)}
              disabled={props.loading || !password.trim()}
            >
              Sign In With Password
            </Button>
            <Button onClick={() => void props.onLoginWithPasskey()} disabled={props.loading}>
              Sign In With Passkey
            </Button>
          </div>
          {props.error ? <Text>{props.error}</Text> : null}
        </div>
      </Card>
    </div>
  );
}
