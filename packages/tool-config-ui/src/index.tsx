import type { ToolPanelProps } from "./types.js";
import { ConfigAdmin } from "./ConfigAdmin.js";
export { meta } from "./meta.js";

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
