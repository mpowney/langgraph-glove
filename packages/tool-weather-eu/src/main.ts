/**
 * Entry point for the tool-weather-eu server.
 *
 * Transport and port are read from `config/tools.json` under the
 * `"weather-eu"` key.  Override config paths via:
 *
 *   GLOVE_CONFIG_DIR=./config  GLOVE_SECRETS_DIR=./secrets  node dist/main.js
 */

import { launchToolServer } from "@langgraph-glove/tool-server";
import { weatherToolMetadata, handleWeather } from "./tools/WeatherTool";

await launchToolServer({
  toolKey: "weather-eu",
  register(server) {
    server.register(weatherToolMetadata, handleWeather);
  },
});
