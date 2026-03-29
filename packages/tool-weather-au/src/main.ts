/**
 * Entry point for the tool-weather-au server.
 *
 * Transport and port are read from `config/tools.json` under the
 * `"weather-au"` key.  Override config paths via:
 *
 *   GLOVE_CONFIG_DIR=./config  GLOVE_SECRETS_DIR=./secrets  node dist/main.js
 */

import { launchToolServer } from "@langgraph-glove/tool-server";
import { weatherToolMetadata, handleWeather } from "./tools/WeatherTool";
import { rainForecastToolMetadata, handleRainForecast } from "./tools/RainForecastTool";

await launchToolServer({
  toolKey: "weather-au",
  register(server) {
    server.register(weatherToolMetadata, handleWeather);
    server.register(rainForecastToolMetadata, handleRainForecast);
  },
});
