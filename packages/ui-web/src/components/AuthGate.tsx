import React, { useState } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Field,
  Input,
  Button,
  Spinner,
  Divider,
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
} from "@fluentui/react-components";
import { KeyMultipleRegular } from "@fluentui/react-icons";

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
  success: {
    color: tokens.colorPaletteGreenForeground1,
  },
  passkeyButton: {
    justifyContent: "center",
  },
  divider: {
    marginTop: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXS,
  },
  actionsRow: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
});

interface AuthGateProps {
  loading: boolean;
  setupRequired: boolean;
  forcePasskeySetup: boolean;
  /** True when the account was created without a password — passkey registration is mandatory. */
  passkeySetupRequired: boolean;
  forcePrivilegeTokenSetup: boolean;
  minPasswordLength: number;
  passkeyRegistered: boolean;
  privilegeTokenRegistered: boolean;
  error: string | null;
  onLogin: (password: string) => Promise<boolean>;
  onSetup: (setupToken: string, password?: string) => Promise<boolean>;
  onLoginWithPasskey: () => Promise<boolean>;
  onRegisterPasskey: () => Promise<boolean>;
  onSkipPasskeySetup: () => void;
  onRegisterPrivilegeToken: (newToken: string, currentToken?: string) => Promise<boolean>;
  onSkipPrivilegeTokenSetup: () => void;
}

/** The three states of the auth gate. */
type AuthView = "login" | "setup" | "passkey-setup" | "privilege-token-setup";

export function AuthGate(props: AuthGateProps) {
  const styles = useStyles();
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [privilegeToken, setPrivilegeToken] = useState("");
  const [confirmPrivilegeToken, setConfirmPrivilegeToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [passkeySuccess, setPasskeySuccess] = useState(false);
  const [passwordAccordionOpen, setPasswordAccordionOpen] = useState(false);
  const [view, setView] = useState<AuthView>(
    props.forcePasskeySetup
      ? "passkey-setup"
      : (props.forcePrivilegeTokenSetup
        ? "privilege-token-setup"
        : (props.setupRequired ? "setup" : "login")),
  );

  // Keep local auth view aligned with backend auth state transitions.
  React.useEffect(() => {
    if (props.forcePasskeySetup && view !== "passkey-setup") {
      setView("passkey-setup");
      return;
    }

    if (props.forcePrivilegeTokenSetup && view !== "privilege-token-setup") {
      setView("privilege-token-setup");
      return;
    }

    if (props.setupRequired && view !== "setup") {
      setView("setup");
      setPasskeySuccess(false);
      return;
    }

    if (!props.setupRequired && view === "setup") {
      setView("login");
    }
  }, [props.forcePasskeySetup, props.forcePrivilegeTokenSetup, props.setupRequired, view]);

  const submitLogin = async () => {
    setLocalError(null);
    if (!password.trim()) {
      setLocalError("Password is required");
      return;
    }
    await props.onLogin(password);
  };

  const submitSetup = async (mode: "password-only" | "password-and-passkey" | "passkey-only") => {
    setLocalError(null);
    if (!setupToken.trim()) {
      setLocalError("Setup token is required");
      return;
    }

    const needsPassword = mode !== "passkey-only";
    if (needsPassword) {
      if (password.length < props.minPasswordLength) {
        setLocalError(`Password must be at least ${props.minPasswordLength} characters`);
        return;
      }
      if (password !== confirmPassword) {
        setLocalError("Passwords do not match");
        return;
      }
    }

    const ok = await props.onSetup(setupToken, needsPassword ? password : undefined);
    if (!ok) return;

    if (mode !== "password-only") {
      const passkeyOk = await props.onRegisterPasskey();
      if (!passkeyOk) {
        setView("passkey-setup");
        return;
      }
      return;
    }

    // User explicitly chose password-only setup from this screen.
    props.onSkipPasskeySetup();
  };

  const submitPasskeyRegister = async () => {
    setLocalError(null);
    const ok = await props.onRegisterPasskey();
    if (ok) setPasskeySuccess(true);
  };

  const submitPrivilegeTokenSetup = async () => {
    setLocalError(null);
    const token = privilegeToken.trim();
    if (!token) {
      setLocalError("Privilege token is required");
      return;
    }
    if (token !== confirmPrivilegeToken.trim()) {
      setLocalError("Privilege token values do not match");
      return;
    }

    const ok = await props.onRegisterPrivilegeToken(token);
    if (!ok) return;

    setPrivilegeToken("");
    setConfirmPrivilegeToken("");
    setView("login");
  };

  if (view === "privilege-token-setup") {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <Text className={styles.title} weight="semibold">Set privilege token</Text>
          <Text>
            Create a privilege token used to explicitly enable short-lived privileged admin access.
          </Text>

          <Field label="Privilege token" required>
            <Input
              type="password"
              value={privilegeToken}
              onChange={(_, data) => setPrivilegeToken(data.value)}
              placeholder="Enter privilege token"
            />
          </Field>

          <Field label="Confirm privilege token" required>
            <Input
              type="password"
              value={confirmPrivilegeToken}
              onChange={(_, data) => setConfirmPrivilegeToken(data.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submitPrivilegeTokenSetup(); }}
              placeholder="Re-enter privilege token"
            />
          </Field>

          {(localError || props.error) && (
            <Text className={styles.error}>{localError ?? props.error}</Text>
          )}

          <Button
            appearance="primary"
            onClick={() => { void submitPrivilegeTokenSetup(); }}
            disabled={props.loading || !privilegeToken.trim() || !confirmPrivilegeToken.trim()}
          >
            {props.loading ? <Spinner size="tiny" /> : "Register privilege token"}
          </Button>

          <Button
            appearance="subtle"
            onClick={props.onSkipPrivilegeTokenSetup}
            disabled={props.loading}
          >
            Skip for now
          </Button>
        </section>
      </div>
    );
  }

  if (view === "passkey-setup") {
    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <Text className={styles.title} weight="semibold">Register a passkey</Text>
          <Text>
            {props.passkeySetupRequired
              ? "Your account has no password. Register a passkey to be able to sign in after this session expires."
              : "Your account is ready. Optionally register a passkey (fingerprint, Face ID, or security key) so you can sign in without a password next time."}
          </Text>

          {passkeySuccess && (
            <Text className={styles.success}>
              Passkey registered successfully! You can now sign in with it.
            </Text>
          )}

          {(localError || props.error) && (
            <Text className={styles.error}>{localError ?? props.error}</Text>
          )}

          {!passkeySuccess && (
            <Button
              appearance="primary"
              icon={<KeyMultipleRegular />}
              className={styles.passkeyButton}
              onClick={submitPasskeyRegister}
              disabled={props.loading}
            >
              {props.loading ? <Spinner size="tiny" /> : "Register passkey"}
            </Button>
          )}

          {/* Hide skip when passkey is mandatory (no password set) unless already registered */}
          {(!props.passkeySetupRequired || passkeySuccess) && (
            <Button
              appearance="subtle"
              onClick={props.onSkipPasskeySetup}
              disabled={props.loading}
            >
              {passkeySuccess ? "Continue to app" : "Skip for now"}
            </Button>
          )}
        </section>
      </div>
    );
  }

  if (view === "setup") {
    const hasAnyPasswordInput = password.length > 0 || confirmPassword.length > 0;
    const passwordReady =
      password.length >= props.minPasswordLength
      && password === confirmPassword
      && password.trim().length > 0;

    return (
      <div className={styles.page}>
        <section className={styles.panel}>
          <Text className={styles.title} weight="semibold">Initial Setup</Text>
          <Text>
            Use the one-time setup token from the gateway logs. Password is optional when using a passkey.
          </Text>

          <Field label="Setup token" required>
            <Input
              value={setupToken}
              onChange={(_, data) => setSetupToken(data.value)}
              placeholder="Paste setup token"
            />
          </Field>

          <Accordion
            collapsible
            openItems={passwordAccordionOpen ? ["password"] : []}
            onToggle={(_, data) => {
              const openItems = Array.isArray(data.openItems)
                ? data.openItems.map((item) => String(item))
                : [];
              setPasswordAccordionOpen(openItems.includes("password"));
            }}
          >
            <AccordionItem value="password">
              <AccordionHeader>Specify password (optional)</AccordionHeader>
              <AccordionPanel>
                <Field label="Password" hint={`Minimum ${props.minPasswordLength} characters`}>
                  <Input
                    type="password"
                    value={password}
                    onChange={(_, data) => setPassword(data.value)}
                  />
                </Field>

                <Field label="Confirm password">
                  <Input
                    type="password"
                    value={confirmPassword}
                    onChange={(_, data) => setConfirmPassword(data.value)}
                  />
                </Field>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>

          {(localError || props.error) && (
            <Text className={styles.error}>{localError ?? props.error}</Text>
          )}

          <div className={styles.actionsRow}>
            {passwordAccordionOpen && (
              <Button
                appearance="primary"
                onClick={() => { void submitSetup("password-only"); }}
                disabled={props.loading || !passwordReady}
              >
                {props.loading ? <Spinner size="tiny" /> : "Use password only"}
              </Button>
            )}

            <Button
              appearance="secondary"
              icon={<KeyMultipleRegular />}
              onClick={() => {
                const mode = passwordAccordionOpen && passwordReady
                  ? "password-and-passkey"
                  : "passkey-only";
                void submitSetup(mode);
              }}
              disabled={props.loading}
            >
              {props.loading ? <Spinner size="tiny" /> : "Set up with passkey"}
            </Button>

            {passwordAccordionOpen && hasAnyPasswordInput && !passwordReady && (
              <Text className={styles.error}>
                To use password, enter matching values with at least {props.minPasswordLength} characters.
              </Text>
            )}
          </div>
        </section>
      </div>
    );
  }

  // login view
  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <Text className={styles.title} weight="semibold">Sign In</Text>
        <Text>Enter your password to unlock the admin and memory tools.</Text>

        {props.passkeyRegistered && (
          <>
            <Button
              appearance="primary"
              icon={<KeyMultipleRegular />}
              className={styles.passkeyButton}
              onClick={() => {
                setLocalError(null);
                void props.onLoginWithPasskey();
              }}
              disabled={props.loading}
            >
              {props.loading ? <Spinner size="tiny" /> : "Sign in with passkey"}
            </Button>
            <Divider className={styles.divider}>or use password</Divider>
          </>
        )}

        <Field label="Password" required>
          <Input
            type="password"
            value={password}
            onChange={(_, data) => setPassword(data.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submitLogin(); }}
          />
        </Field>

        {(localError || props.error) && (
          <Text className={styles.error}>{localError ?? props.error}</Text>
        )}

        <Button
          appearance={props.passkeyRegistered ? "secondary" : "primary"}
          onClick={submitLogin}
          disabled={props.loading}
        >
          {props.loading ? <Spinner size="tiny" /> : "Sign in with password"}
        </Button>
      </section>
    </div>
  );
}
