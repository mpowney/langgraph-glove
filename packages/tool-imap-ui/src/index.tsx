import React from "react";
import type { ToolPanelMeta, ToolPanelProps } from "./types.js";
import { ImapStatusDrawer } from "./ImapStatusDrawer.js";

export const meta: ToolPanelMeta = {
  serverKey: "imap-",
  matchStrategy: "prefix",
  label: "IMAP",
  description: "Monitor IMAP crawl indexing progress",
};

function ImapPanel(props: ToolPanelProps) {
  return (
    <ImapStatusDrawer
      open={props.open}
      onClose={props.onClose}
      apiBaseUrl={props.adminApiBaseUrl}
      authToken={props.authToken}
      privilegedGrantId={props.privilegedGrantId ?? ""}
      conversationId={props.conversationId ?? ""}
      privilegedAccessActive={props.privilegedAccessActive ?? false}
      privilegedAccessExpiresAt={props.privilegedAccessExpiresAt}
      onEnablePrivilegedAccessWithToken={props.onEnablePrivilegedAccessWithToken ?? (() => Promise.resolve(false))}
      onEnablePrivilegedAccessWithPasskey={props.onEnablePrivilegedAccessWithPasskey}
      onDisablePrivilegedAccess={props.onDisablePrivilegedAccess ?? (() => undefined)}
      privilegeTokenRegistered={props.privilegeTokenRegistered ?? false}
      onRegisterPrivilegeToken={props.onRegisterPrivilegeToken ?? (() => Promise.resolve(false))}
      authError={props.authError}
      passkeyEnabled={props.passkeyEnabled}
    />
  );
}

export default ImapPanel;
