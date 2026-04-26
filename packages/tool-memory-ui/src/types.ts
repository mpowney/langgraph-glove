export interface MemoryToolHealth {
  available: boolean;
  reason?: string;
  tools?: string[];
}

export type MemoryRetentionTier = "hot" | "warm" | "cold";

export interface MemorySummary {
  id: string;
  slug: string;
  title: string;
  scope: string;
  tags: string[];
  status: string;
  retentionTier: MemoryRetentionTier;
  storagePath: string;
  revision: number;
  personal: boolean;
  createdAt: string;
  updatedAt: string;
  lastIndexedAt?: string;
}

export interface MemoryDocument extends MemorySummary {
  content: string;
}

export interface MemorySearchResultItem {
  memory: MemorySummary;
  score: number;
  excerpts: string[];
}

export interface MemorySearchResult {
  query: string;
  retrievalMode: "vector-hybrid" | "lexical-fallback";
  embeddingModelKey: string;
  indexingStrategy: "immediate" | "deferred";
  results: MemorySearchResultItem[];
}

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
