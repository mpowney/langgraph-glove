import React, { useState } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Field,
  Input,
  Button,
  Spinner,
} from "@fluentui/react-components";

const useStyles = makeStyles({
  page: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    background: `radial-gradient(circle at 20% 10%, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 45%)`,
    padding: tokens.spacingHorizontalL,
  },
  panel: {
    width: "min(560px, 100%)",
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow64,
    padding: tokens.spacingHorizontalXL,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  title: {
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

interface AuthGateProps {
  loading: boolean;
  setupRequired: boolean;
  minPasswordLength: number;
  error: string | null;
  onLogin: (password: string) => Promise<boolean>;
  onSetup: (setupToken: string, password: string) => Promise<boolean>;
}

export function AuthGate(props: AuthGateProps) {
  const styles = useStyles();
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submitLogin = async () => {
    setLocalError(null);
    if (!password.trim()) {
      setLocalError("Password is required");
      return;
    }
    await props.onLogin(password);
  };

  const submitSetup = async () => {
    setLocalError(null);
    if (!setupToken.trim()) {
      setLocalError("Setup token is required");
      return;
    }
    if (password.length < props.minPasswordLength) {
      setLocalError(`Password must be at least ${props.minPasswordLength} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setLocalError("Passwords do not match");
      return;
    }
    await props.onSetup(setupToken, password);
  };

  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <Text className={styles.title} weight="semibold">
          {props.setupRequired ? "Initial Setup" : "Sign In"}
        </Text>
        <Text>
          {props.setupRequired
            ? "Use the one-time setup token from the gateway logs, then set your password."
            : "Enter your password to unlock the admin and memory tools."}
        </Text>

        {props.setupRequired && (
          <Field label="Setup token" required>
            <Input
              value={setupToken}
              onChange={(_, data) => setSetupToken(data.value)}
              placeholder="Paste setup token"
            />
          </Field>
        )}

        <Field label="Password" required hint={props.setupRequired ? `Minimum ${props.minPasswordLength} characters` : undefined}>
          <Input
            type="password"
            value={password}
            onChange={(_, data) => setPassword(data.value)}
          />
        </Field>

        {props.setupRequired && (
          <Field label="Confirm password" required>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(_, data) => setConfirmPassword(data.value)}
            />
          </Field>
        )}

        {(localError || props.error) && <Text className={styles.error}>{localError ?? props.error}</Text>}

        <Button
          appearance="primary"
          onClick={props.setupRequired ? submitSetup : submitLogin}
          disabled={props.loading}
        >
          {props.loading ? <Spinner size="tiny" /> : (props.setupRequired ? "Set password" : "Sign in")}
        </Button>
      </section>
    </div>
  );
}
