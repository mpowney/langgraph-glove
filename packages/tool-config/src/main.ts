/**
 * Entry point for the tool-config server.
 *
 * Reads transport config from `config/tools.json` under the `"config"` key.
 * Override config paths via:
 *
 *   GLOVE_CONFIG_DIR=./config  GLOVE_SECRETS_DIR=./secrets  node dist/main.js
 */

import { launchToolServer } from "@langgraph-glove/tool-server";
import { ConfigStore } from "./ConfigStore";
import {
  configListFilesMetadata,
  handleConfigListFiles,
  configReadFileMetadata,
  handleConfigReadFile,
  configWriteFileMetadata,
  handleConfigWriteFile,
  configValidateFileMetadata,
  handleConfigValidateFile,
  configListHistoryMetadata,
  handleConfigListHistory,
  configGetVersionMetadata,
  handleConfigGetVersion,
  resolveDbPath,
} from "./tools/ConfigTool";
import {
  secretsListFilesMetadata,
  handleSecretsListFiles,
  secretsListMetadata,
  handleSecretsList,
  secretsGetMetadata,
  handleSecretsGet,
  secretsUpsertMetadata,
  handleSecretsUpsert,
} from "./tools/SecretsTool";

const adminApiUrl = process.env["GLOVE_ADMIN_API_URL"] ?? "http://127.0.0.1:8081";
const store = new ConfigStore(resolveDbPath());

await launchToolServer({
  toolKey: "config",
  register(server) {
    server.register(configListFilesMetadata, (params) =>
      handleConfigListFiles(params, adminApiUrl),
    );
    server.register(configReadFileMetadata, (params) =>
      handleConfigReadFile(params, adminApiUrl),
    );
    server.register(configWriteFileMetadata, (params) =>
      handleConfigWriteFile(params, adminApiUrl, store),
    );
    server.register(configValidateFileMetadata, (params) =>
      handleConfigValidateFile(params, adminApiUrl),
    );
    server.register(configListHistoryMetadata, (params) =>
      handleConfigListHistory(params, adminApiUrl, store),
    );
    server.register(configGetVersionMetadata, (params) =>
      handleConfigGetVersion(params, adminApiUrl, store),
    );
    server.register(secretsListFilesMetadata, (params) =>
      handleSecretsListFiles(params, adminApiUrl),
    );
    server.register(secretsListMetadata, (params) =>
      handleSecretsList(params, adminApiUrl),
    );
    server.register(secretsGetMetadata, (params) =>
      handleSecretsGet(params, adminApiUrl),
    );
    server.register(secretsUpsertMetadata, (params) =>
      handleSecretsUpsert(params, adminApiUrl),
    );
  },
});
