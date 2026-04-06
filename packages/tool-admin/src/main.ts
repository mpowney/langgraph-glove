/**
 * Entry point for the tool-admin server.
 *
 * Transport and connection details are read from `config/tools.json` under the
 * `"admin"` key.  Override config paths via:
 *
 *   GLOVE_CONFIG_DIR=./config  GLOVE_SECRETS_DIR=./secrets  node dist/main.js
 */

import { launchToolServer } from "@langgraph-glove/tool-server";
import { updateConfigToolMetadata, handleUpdateConfig } from "./tools/UpdateConfigTool";
import { restartProcessToolMetadata, handleRestartProcess } from "./tools/RestartProcessTool";
import { shellCommandToolMetadata, handleShellCommand } from "./tools/ShellCommandTool";

const adminApiUrl = process.env["GLOVE_ADMIN_API_URL"] ?? "http://127.0.0.1:8081";

await launchToolServer({
  toolKey: "admin",
  register(server) {
    server.register(updateConfigToolMetadata, (params) => handleUpdateConfig(params, adminApiUrl));
    server.register(restartProcessToolMetadata, (params) => handleRestartProcess(params, adminApiUrl));
    server.register(shellCommandToolMetadata, (params) => handleShellCommand(params, adminApiUrl));
  },
});
