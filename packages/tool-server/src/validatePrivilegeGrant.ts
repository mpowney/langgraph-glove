export async function validatePrivilegeGrant(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<void> {
  const grantId = typeof params["privilegeGrantId"] === "string"
    ? params["privilegeGrantId"].trim()
    : "";
  const conversationId = typeof params["conversationId"] === "string"
    ? params["conversationId"].trim()
    : "";

  if (!grantId) {
    throw new Error("Privileged context is missing. Please enable privileged access and try again.");
  }
  if (!conversationId) {
    throw new Error("Privileged context is missing. Please enable privileged access and try again.");
  }

  const base = adminApiUrl.endsWith("/") ? adminApiUrl.slice(0, -1) : adminApiUrl;
  const response = await fetch(`${base}/api/internal/validate-privilege-grant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId, conversationId }),
  });

  if (!response.ok) {
    throw new Error("Privileged access is missing, invalid, or expired. Please enable privileged access and try again.");
  }
}