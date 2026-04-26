/** Shared panel contract — must stay identical to ui-web/src/types.ts ToolPanelProps */
export interface ToolPanelProps {
  open: boolean;
  onClose: () => void;
  adminApiBaseUrl?: string;
  authToken?: string;
  personalToken?: string;
  privilegedGrantId?: string;
  conversationId?: string;
  privilegedAccessActive?: boolean;
  privilegedAccessExpiresAt?: string;
  onEnablePrivilegedAccessWithToken?: (token: string) => Promise<boolean>;
  onEnablePrivilegedAccessWithPasskey?: () => Promise<boolean>;
  onDisablePrivilegedAccess?: () => void;
  privilegeTokenRegistered?: boolean;
  onRegisterPrivilegeToken?: (newToken: string, currentToken?: string) => Promise<boolean>;
  authError?: string | null;
  passkeyEnabled?: boolean;
}

/** Must stay identical to ui-web/src/types.ts ToolPanelMeta */
export interface ToolPanelMeta {
  serverKey: string;
  matchStrategy: "exact" | "prefix";
  label: string;
  description: string;
}
