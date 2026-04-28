import { ConfidentialClientApplication } from "@azure/msal-node";
import { getObservabilityAuthenticationScope } from "@microsoft/agents-a365-runtime";

export interface EntraClientCredentialConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface A365TokenResolver {
  (agentId: string, tenantId: string): Promise<string>;
}

/**
 * Builds an Agent365 token resolver using Entra app credentials (MSAL).
 *
 * The resolver always requests the official Agent365 observability scope.
 */
export function createMsalTokenResolver(config: EntraClientCredentialConfig): A365TokenResolver {
  const cca = new ConfidentialClientApplication({
    auth: {
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
  });

  return async (_agentId: string, _tenantId: string): Promise<string> => {
    const response = await cca.acquireTokenByClientCredential({
      scopes: getObservabilityAuthenticationScope(),
    });

    const token = response?.accessToken?.trim();
    if (!token) {
      throw new Error("MSAL token resolver did not return an access token for Agent365 observability scope");
    }

    return token;
  };
}
