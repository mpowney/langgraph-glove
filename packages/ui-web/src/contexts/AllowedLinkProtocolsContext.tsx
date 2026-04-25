import React, { createContext, useContext } from "react";

export const DEFAULT_ALLOWED_LINK_PROTOCOLS = ["http", "https", "sandbox"] as const;

const AllowedLinkProtocolsContext = createContext<string[]>([...DEFAULT_ALLOWED_LINK_PROTOCOLS]);

interface AllowedLinkProtocolsProviderProps {
  protocols: string[];
  children: React.ReactNode;
}

export function AllowedLinkProtocolsProvider({
  protocols,
  children,
}: AllowedLinkProtocolsProviderProps) {
  return (
    <AllowedLinkProtocolsContext.Provider value={protocols}>
      {children}
    </AllowedLinkProtocolsContext.Provider>
  );
}

export function useAllowedLinkProtocols(): string[] {
  return useContext(AllowedLinkProtocolsContext);
}
