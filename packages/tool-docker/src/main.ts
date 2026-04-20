/**
 * Entry point for the tool-docker server.
 *
 * Transport and port are read from `config/tools.json` under the
 * `"docker"` key.  Override config paths via:
 *
 *   GLOVE_CONFIG_DIR=./config  GLOVE_SECRETS_DIR=./secrets  node dist/main.js
 */

import { launchToolServer } from "@langgraph-glove/tool-server";
import { dockerHealthToolMetadata, handleDockerHealth } from "./tools/DockerHealthTool.js";
import { createContainerToolMetadata, handleCreateContainer } from "./tools/CreateContainerTool.js";
import { execContainerToolMetadata, handleExecContainer } from "./tools/ExecContainerTool.js";
import { containerTtlToolMetadata, handleContainerTtl } from "./tools/ContainerTtlTool.js";
import { stopContainerToolMetadata, handleStopContainer } from "./tools/StopContainerTool.js";
import { listContainersToolMetadata, handleListContainers } from "./tools/ListContainersTool.js";
import { containerManager } from "./ContainerManager.js";

const adminApiUrl = process.env["GLOVE_ADMIN_API_URL"] ?? "http://127.0.0.1:8081";

const server = await launchToolServer({
  toolKey: "docker",
  register(server) {
    server.register(dockerHealthToolMetadata, handleDockerHealth);
    server.register(createContainerToolMetadata, (params) => handleCreateContainer(params, adminApiUrl));
    server.register(execContainerToolMetadata, handleExecContainer);
    server.register(containerTtlToolMetadata, handleContainerTtl);
    server.register(stopContainerToolMetadata, handleStopContainer);
    server.register(listContainersToolMetadata, handleListContainers);
  },
});

// Ensure all containers are stopped and removed on shutdown
const origStop = server.stop.bind(server);
server.stop = async () => {
  await containerManager.removeAll();
  await origStop();
};
