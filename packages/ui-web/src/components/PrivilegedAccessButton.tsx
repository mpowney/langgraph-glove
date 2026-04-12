import React, { useEffect, useMemo, useState } from "react";
import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Button,
  Spinner,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Field,
  Input,
  Divider,
} from "@fluentui/react-components";

const useStyles = makeStyles({
  // Used when rendered on a brand-colour background (e.g. AppHeader)
  chipBase: {
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
  },
  chipOnBrandInactive: {
    backgroundColor: "rgba(255, 255, 255, 0.16)",
    color: tokens.colorNeutralForegroundOnBrand,
  },
  chipOnBrandActive: {
    backgroundColor: "rgba(31, 138, 62, 0.28)",
    color: tokens.colorNeutralForegroundOnBrand,
  },
  // Used when rendered on a neutral/light background (e.g. ConfigAdmin drawer)
  chipDefaultInactive: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  chipDefaultActive: {
    backgroundColor: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground2,
  },
  popover: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    minWidth: "300px",
  },
});

export interface PrivilegedAccessButtonProps {
  privilegedAccessActive: boolean;
  privilegedAccessExpiresAt?: string;
  onEnablePrivilegedAccessWithToken: (token: string) => Promise<boolean>;
  onEnablePrivilegedAccessWithPasskey?: () => Promise<boolean>;
  onDisablePrivilegedAccess: () => void;
  privilegeTokenRegistered: boolean;
  onRegisterPrivilegeToken: (newToken: string, currentToken?: string) => Promise<boolean>;
  authError?: string | null;
  passkeyEnabled?: boolean;
  /**
   * When true, renders the trigger button styled for placement on a brand-coloured
   * background (as in the app header). Defaults to false.
   */
  onBrand?: boolean;
}

export function PrivilegedAccessButton({
  privilegedAccessActive,
  privilegedAccessExpiresAt,
  onEnablePrivilegedAccessWithToken,
  onEnablePrivilegedAccessWithPasskey,
  onDisablePrivilegedAccess,
  privilegeTokenRegistered,
  onRegisterPrivilegeToken,
  authError,
  passkeyEnabled = false,
  onBrand = false,
}: PrivilegedAccessButtonProps) {
  const styles = useStyles();

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isEnabling, setIsEnabling] = useState(false);
  const [currentTokenDraft, setCurrentTokenDraft] = useState("");
  const [newTokenDraft, setNewTokenDraft] = useState("");
  const [confirmNewTokenDraft, setConfirmNewTokenDraft] = useState("");
  const [isUpdatingToken, setIsUpdatingToken] = useState(false);
  const [changeTokenDialogOpen, setChangeTokenDialogOpen] = useState(false);
  const [changeTokenError, setChangeTokenError] = useState<string | null>(null);
  const [changeTokenNotice, setChangeTokenNotice] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  // Drive the countdown display
  useEffect(() => {
    if (!privilegedAccessActive || !privilegedAccessExpiresAt) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [privilegedAccessActive, privilegedAccessExpiresAt]);

  const countdown = useMemo(() => {
    if (!privilegedAccessActive || !privilegedAccessExpiresAt) return null;
    const deltaMs = Date.parse(privilegedAccessExpiresAt) - nowMs;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return "expiring";
    const totalSeconds = Math.ceil(deltaMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }, [privilegedAccessActive, privilegedAccessExpiresAt, nowMs]);

  const handleEnableWithToken = async () => {
    const token = tokenDraft.trim();
    if (!token) {
      setError("Privilege token is required");
      return;
    }
    setError(null);
    setNotice(null);
    setIsEnabling(true);
    const ok = await onEnablePrivilegedAccessWithToken(token);
    setIsEnabling(false);
    if (!ok) {
      setError(authError ?? "Unable to enable privileged access");
      return;
    }
    setTokenDraft("");
    setNotice("Privileged access enabled for 10 minutes.");
    setPopoverOpen(false);
  };

  const handleEnableWithPasskey = async () => {
    if (!onEnablePrivilegedAccessWithPasskey) return;
    setError(null);
    setNotice(null);
    setIsEnabling(true);
    const ok = await onEnablePrivilegedAccessWithPasskey();
    setIsEnabling(false);
    if (!ok) {
      setError(authError ?? "Passkey activation failed");
      return;
    }
    setTokenDraft("");
    setNotice("Privileged access enabled for 10 minutes.");
    setPopoverOpen(false);
  };

  const handleUpdateToken = async () => {
    const currentToken = currentTokenDraft.trim();
    const newToken = newTokenDraft.trim();
    const confirmNewToken = confirmNewTokenDraft.trim();

    if (!currentToken) {
      setChangeTokenError("Current privilege token is required");
      return;
    }
    if (!newToken) {
      setChangeTokenError("New privilege token is required");
      return;
    }
    if (newToken !== confirmNewToken) {
      setChangeTokenError("New privilege token values do not match");
      return;
    }

    setChangeTokenError(null);
    setChangeTokenNotice(null);
    setIsUpdatingToken(true);
    const ok = await onRegisterPrivilegeToken(newToken, currentToken);
    setIsUpdatingToken(false);
    if (!ok) {
      setChangeTokenError(authError ?? "Unable to update privilege token");
      return;
    }
    setCurrentTokenDraft("");
    setNewTokenDraft("");
    setConfirmNewTokenDraft("");
    setChangeTokenError(null);
    setChangeTokenNotice("Privilege token updated.");
    setChangeTokenDialogOpen(false);
    setNotice("Privilege token updated.");
  };

  const chipClass = mergeClasses(
    styles.chipBase,
    onBrand
      ? (privilegedAccessActive ? styles.chipOnBrandActive : styles.chipOnBrandInactive)
      : (privilegedAccessActive ? styles.chipDefaultActive : styles.chipDefaultInactive)
  );

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(_, data) => {
        if (!data.open) {
          setPopoverOpen(false);
          setError(null);
          return;
        }
        setPopoverOpen(true);
      }}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          onClick={() => setPopoverOpen(true)}
          style={onBrand ? { color: tokens.colorNeutralForegroundOnBrand } : undefined}
          aria-label={privilegedAccessActive ? "Privileged access active" : "Enable privileged access"}
        >
          <Text size={100} className={chipClass}>
            {privilegedAccessActive
              ? `Privileged access active${countdown ? ` (${countdown})` : ""}`
              : "Privileged access inactive"}
          </Text>
        </Button>
      </PopoverTrigger>
      <PopoverSurface>
        <div className={styles.popover}>
          <Text weight="semibold">Privileged access</Text>
          <Text size={200} style={{ maxWidth: "320px" }}>
            Enable a 10-minute privileged window before running admin tools.
          </Text>
          {!privilegeTokenRegistered && (
            <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
              Privilege token is not registered yet. Complete setup registration first.
            </Text>
          )}
          {privilegedAccessActive ? (
            <>
              <Text size={200}>
                Privileged access is active{countdown ? ` (${countdown} remaining)` : ""}.
              </Text>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button appearance="secondary" onClick={onDisablePrivilegedAccess}>
                  Disable now
                </Button>
              </div>
            </>
          ) : (
            <>
              <Field label="Privilege token">
                <Input
                  type="password"
                  value={tokenDraft}
                  onChange={(_, data) => setTokenDraft(data.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleEnableWithToken(); }}
                  placeholder="Enter privilege token"
                />
              </Field>
              <div style={{ display: "flex", gap: tokens.spacingHorizontalS, justifyContent: "flex-end" }}>
                {passkeyEnabled && onEnablePrivilegedAccessWithPasskey && (
                  <Button
                    appearance="secondary"
                    onClick={() => { void handleEnableWithPasskey(); }}
                    disabled={isEnabling}
                  >
                    Use passkey
                  </Button>
                )}
                <Button
                  appearance="primary"
                  onClick={() => { void handleEnableWithToken(); }}
                  disabled={isEnabling || !privilegeTokenRegistered}
                >
                  {isEnabling ? <Spinner size="tiny" /> : "Enable"}
                </Button>
              </div>
            </>
          )}

          {privilegeTokenRegistered && !privilegedAccessActive && (
            <>
              <Divider />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Text size={200} weight="semibold">Change registered privilege token</Text>
                <Dialog
                  open={changeTokenDialogOpen}
                  onOpenChange={(_, data) => {
                    setChangeTokenDialogOpen(data.open);
                    if (!data.open) {
                      setChangeTokenError(null);
                      setChangeTokenNotice(null);
                    }
                  }}
                >
                  <DialogTrigger disableButtonEnhancement>
                    <Button
                      appearance="secondary"
                      onClick={() => {
                        setChangeTokenDialogOpen(true);
                        setChangeTokenError(null);
                        setChangeTokenNotice(null);
                      }}
                    >
                      Change token
                    </Button>
                  </DialogTrigger>
                  <DialogSurface>
                    <DialogBody>
                      <DialogTitle>Change privilege token</DialogTitle>
                      <DialogContent>
                        <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS }}>
                          <Field label="Current token">
                            <Input
                              type="password"
                              value={currentTokenDraft}
                              onChange={(_, data) => setCurrentTokenDraft(data.value)}
                              autoFocus
                            />
                          </Field>
                          <Field label="New token">
                            <Input
                              type="password"
                              value={newTokenDraft}
                              onChange={(_, data) => setNewTokenDraft(data.value)}
                            />
                          </Field>
                          <Field label="Confirm new token">
                            <Input
                              type="password"
                              value={confirmNewTokenDraft}
                              onChange={(_, data) => setConfirmNewTokenDraft(data.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") void handleUpdateToken(); }}
                            />
                          </Field>
                          {changeTokenError && (
                            <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                              {changeTokenError}
                            </Text>
                          )}
                          {changeTokenNotice && (
                            <Text size={200} style={{ color: tokens.colorPaletteGreenForeground1 }}>
                              {changeTokenNotice}
                            </Text>
                          )}
                        </div>
                      </DialogContent>
                      <DialogActions>
                        <DialogTrigger disableButtonEnhancement>
                          <Button appearance="secondary">Cancel</Button>
                        </DialogTrigger>
                        <Button
                          appearance="primary"
                          onClick={() => { void handleUpdateToken(); }}
                          disabled={isUpdatingToken}
                        >
                          {isUpdatingToken ? <Spinner size="tiny" /> : "Update token"}
                        </Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
              </div>
            </>
          )}
          {error && (
            <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
              {error}
            </Text>
          )}
          {notice && (
            <Text size={200} style={{ color: tokens.colorPaletteGreenForeground1 }}>
              {notice}
            </Text>
          )}
        </div>
      </PopoverSurface>
    </Popover>
  );
}
