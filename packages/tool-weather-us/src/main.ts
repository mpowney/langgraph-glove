/**
 * Entry point for the tool-weather-us server.
 *
 * Transport and port are read from `config/tools.json` under the
 * `"weather-us"` key.  Override config paths via:
 *
 *   GLOVE_CONFIG_DIR=./config  GLOVE_SECRETS_DIR=./secrets  node dist/main.js
 */

import { launchToolServer } from "@langgraph-glove/tool-server";
import { weatherToolMetadata, handleWeather } from "./tools/WeatherTool.js";

await launchToolServer({
  toolKey: "weather-us",
  register(server) {
    server.register(weatherToolMetadata, handleWeather);
  },
});
