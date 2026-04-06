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
    throw new Error("privilegeGrantId is required for privileged config tool execution");
  }
  if (!conversationId) {
    throw new Error("conversationId is required for privileged config tool execution");
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
    throw new Error("Unauthorized: privileged access grant is missing, invalid, or expired");
  }
}
