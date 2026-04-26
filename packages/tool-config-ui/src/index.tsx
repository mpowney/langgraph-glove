import type { ToolPanelMeta, ToolPanelProps } from "./types.js";
import { ConfigAdmin } from "./ConfigAdmin.js";

export const meta: ToolPanelMeta = {
  serverKey: "config",
  matchStrategy: "exact",
  label: "Configuration",
  description: "Edit system settings and config",
};

function ConfigPanel(props: ToolPanelProps) {
  const base = props.adminApiBaseUrl?.replace(/\/$/, "") ?? "";
  const configToolUrl = `${base}/api/tools/_config`;

  return (
    <ConfigAdmin
      open={props.open}
      onClose={props.onClose}
      configToolUrl={configToolUrl}
      adminApiUrl={base}
      privilegeGrantId={props.privilegedGrantId ?? ""}
      conversationId={props.conversationId ?? ""}
      authToken={props.authToken}
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

export default ConfigPanel;
