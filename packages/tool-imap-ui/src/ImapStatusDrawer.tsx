import React from "react";
import {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import { ImapStatusSection } from "./ImapStatusSection.js";
import { PrivilegedAccessButton } from "@langgraph-glove/ui-shared";

const useStyles = makeStyles({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalL,
  },
  sectionLabel: {
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    paddingBottom: tokens.spacingVerticalXXS,
  },
});

interface ImapStatusDrawerProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl?: string;
  authToken?: string;
  privilegedGrantId: string;
  conversationId: string;
  privilegedAccessActive: boolean;
  privilegedAccessExpiresAt?: string;
  onEnablePrivilegedAccessWithToken: (token: string) => Promise<boolean>;
  onEnablePrivilegedAccessWithPasskey?: () => Promise<boolean>;
  onDisablePrivilegedAccess: () => void;
  privilegeTokenRegistered: boolean;
  onRegisterPrivilegeToken: (newToken: string, currentToken?: string) => Promise<boolean>;
  authError?: string | null;
  passkeyEnabled?: boolean;
}

export function ImapStatusDrawer({
  open,
  onClose,
  apiBaseUrl,
  authToken,
  privilegedGrantId,
  conversationId,
  privilegedAccessActive,
  privilegedAccessExpiresAt,
  onEnablePrivilegedAccessWithToken,
  onEnablePrivilegedAccessWithPasskey,
  onDisablePrivilegedAccess,
  privilegeTokenRegistered,
  onRegisterPrivilegeToken,
  authError,
  passkeyEnabled,
}: ImapStatusDrawerProps) {
  const styles = useStyles();

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
      position="end"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss24Regular />}
              onClick={onClose}
              aria-label="Close IMAP crawl status"
            />
          }
        >
          IMAP Crawl Status
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.section}>
          <Text size={100} weight="semibold" className={styles.sectionLabel}>
            Privileged access
          </Text>
          <PrivilegedAccessButton
            privilegedAccessActive={privilegedAccessActive}
            privilegedAccessExpiresAt={privilegedAccessExpiresAt}
            onEnablePrivilegedAccessWithToken={onEnablePrivilegedAccessWithToken}
            onEnablePrivilegedAccessWithPasskey={onEnablePrivilegedAccessWithPasskey}
            onDisablePrivilegedAccess={onDisablePrivilegedAccess}
            privilegeTokenRegistered={privilegeTokenRegistered}
            onRegisterPrivilegeToken={onRegisterPrivilegeToken}
            authError={authError}
            passkeyEnabled={passkeyEnabled}
          />
        </div>

        <ImapStatusSection
          open={open}
          apiBaseUrl={apiBaseUrl}
          authToken={authToken}
          privilegedGrantId={privilegedGrantId}
          conversationId={conversationId}
        />
      </DrawerBody>
    </OverlayDrawer>
  );
}
