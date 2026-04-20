import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { containerManager, TTL_INDEFINITE } from "../ContainerManager.js";

export const listContainersToolMetadata: ToolMetadata = {
  name: "docker_list_containers",
  description:
    "Use {name} to list all docker containers currently managed by this tool server, " +
    "including the parameters used to create them and their remaining TTL.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export async function handleListContainers(
  _params: Record<string, unknown>,
): Promise<string> {
  const records = containerManager.list();

  if (records.length === 0) {
    return [
      "## Managed Docker Containers",
      "",
      "No containers are currently running.",
    ].join("\n");
  }

  const lines = ["## Managed Docker Containers", ""];

  for (const record of records) {
    const remaining = containerManager.remainingMs(record.id);

    let ttlDesc: string;
    if (remaining === TTL_INDEFINITE) {
      ttlDesc = "Indefinite";
    } else if (remaining !== null && remaining > 0) {
      const totalSeconds = Math.floor(remaining / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      ttlDesc = minutes > 0 ? `${minutes}m ${seconds}s remaining` : `${seconds}s remaining`;
    } else {
      ttlDesc = "Expired (pending removal)";
    }

    lines.push(`### ${record.id}`);
    lines.push(`- **Docker ID:** ${record.dockerId}`);
    lines.push(`- **Image:** ${record.image}`);
    lines.push(`- **TTL:** ${ttlDesc}`);
    lines.push(`- **Created:** ${new Date(record.createdAt).toISOString()}`);
    if (record.cliParams.length > 0) {
      lines.push(`- **CLI params:** ${record.cliParams.join(" ")}`);
    }
    if (record.composeUsed) {
      lines.push("- **Created via:** docker compose");
    }
    lines.push("");
  }

  return lines.join("\n");
}
