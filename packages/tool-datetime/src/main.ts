/**
 * Entry point for the tool-datetime server.
 *
 * Transport and port are read from `config/tools.json` under the
 * `"datetime"` key.  Override config paths via:
 *
 *   GLOVE_CONFIG_DIR=./config  GLOVE_SECRETS_DIR=./secrets  node dist/main.js
 */

import { launchToolServer } from "@langgraph-glove/tool-server";
import {
  calculateDateToolMetadata,
  calculateTimeToolMetadata,
  dateTimeToolMetadata,
  handleCalculateDate,
  handleCalculateTime,
  handleDateTime,
} from "./tools/DateTimeTool";

await launchToolServer({
  toolKey: "datetime",
  register(server) {
    server.register(dateTimeToolMetadata, handleDateTime);
    server.register(calculateDateToolMetadata, handleCalculateDate);
    server.register(calculateTimeToolMetadata, handleCalculateTime);
  },
});
