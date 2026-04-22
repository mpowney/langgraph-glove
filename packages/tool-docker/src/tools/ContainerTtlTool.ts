import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { containerManager, TTL_INDEFINITE } from "../ContainerManager.js";
import { isDockerContainerPresent } from "./DockerContainerState.js";

export const containerTtlToolMetadata: ToolMetadata = {
  name: "docker_container_ttl",
  description:
    "Use {name} to check how long a docker container has remaining before it is automatically " +
    "stopped and removed. Returns the remaining TTL in a human-readable format.",
  parameters: {
    type: "object",
    properties: {
      containerId: {
        type: "string",
        description: "The tool-managed container reference returned by docker_create_container.",
      },
    },
    required: ["containerId"],
  },
};

export async function handleContainerTtl(
  params: Record<string, unknown>,
): Promise<string> {
  const containerId = typeof params["containerId"] === "string" ? params["containerId"].trim() : "";
  if (!containerId) {
    throw new Error("docker_container_ttl: 'containerId' parameter is required and must be a non-empty string");
  }

  const record = containerManager.get(containerId);
  if (!record) {
    throw new Error(
      `docker_container_ttl: no container found with reference "${containerId}". ` +
      "It may have expired or been stopped. Use docker_list_containers to see available containers.",
    );
  }

  const present = await isDockerContainerPresent(record.dockerId);
  if (!present) {
    await containerManager.remove(containerId);
    throw new Error(
      `docker_container_ttl: container reference "${containerId}" is stale because the underlying container no longer exists. ` +
      "Use docker_list_containers to refresh references or create a new container.",
    );
  }

  const remaining = containerManager.remainingMs(containerId);

  const lines = [
    "## Container TTL",
    "",
    `- **Container Reference:** ${containerId}`,
    `- **Image:** ${record.image}`,
  ];

  if (remaining === TTL_INDEFINITE) {
    lines.push("- **TTL:** Indefinite (no automatic expiry)");
  } else if (remaining !== null && remaining > 0) {
    const totalSeconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const formatted =
      minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    lines.push(`- **Remaining TTL:** ${formatted}`);
  } else {
    lines.push("- **Remaining TTL:** Expired (pending removal)");
  }

  return lines.join("\n");
}
