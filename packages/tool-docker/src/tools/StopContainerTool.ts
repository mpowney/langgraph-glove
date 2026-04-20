import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { containerManager } from "../ContainerManager.js";

export const stopContainerToolMetadata: ToolMetadata = {
  name: "docker_stop_container",
  description:
    "Use {name} to immediately stop and remove a docker container instead of waiting for its TTL " +
    "to expire. The container GUID will no longer be usable after this call.",
  parameters: {
    type: "object",
    properties: {
      containerId: {
        type: "string",
        description: "The container GUID returned by docker_create_container.",
      },
    },
    required: ["containerId"],
  },
};

export async function handleStopContainer(
  params: Record<string, unknown>,
): Promise<string> {
  const containerId = typeof params["containerId"] === "string" ? params["containerId"].trim() : "";
  if (!containerId) {
    throw new Error("docker_stop_container: 'containerId' parameter is required and must be a non-empty string");
  }

  const record = containerManager.get(containerId);
  if (!record) {
    throw new Error(
      `docker_stop_container: no container found with GUID "${containerId}". ` +
      "It may have already been stopped or expired.",
    );
  }

  const { dockerId, image } = record;
  await containerManager.remove(containerId);

  return [
    "## Container Stopped",
    "",
    `- **Container GUID:** ${containerId}`,
    `- **Docker ID:** ${dockerId}`,
    `- **Image:** ${image}`,
    "",
    "The container has been stopped and removed.",
  ].join("\n");
}
