import type { ToolMetadata } from "@langgraph-glove/tool-server";

/** JSON Schema metadata for the weather tool — consumed by introspection. */
export const weatherToolMetadata: ToolMetadata = {
  name: "weather_au",
  description:
    "Get the current weather conditions for a given location within Australia. Only locations in Australia are supported. " +
    "Returns temperature, conditions, humidity and wind speed.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name within Australia, e.g. 'Sydney' or 'Melbourne'.",
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature unit. Defaults to celsius.",
      },
    },
    required: ["location"],
  },
};

interface WeatherParams {
  location: string;
  unit?: string;
}

/** Weather condition descriptors for the mock response. */
const CONDITIONS = [
  "sunny",
  "partly cloudy",
  "overcast",
  "light rain",
  "heavy rain",
  "thunderstorms",
  "foggy",
  "snow showers",
] as const;

/**
 * Mock weather tool handler.
 *
 * In a real implementation this would call a weather API such as
 * OpenWeatherMap or WeatherAPI.  The mock returns plausible-looking data so
 * that the full RPC pipeline can be exercised without an external dependency.
 */
export async function handleWeather(params: Record<string, unknown>): Promise<string> {
  const location = params["location"] as string;
  const unit = (params["unit"] as string | undefined) ?? "celsius";

  if (!location || typeof location !== "string") {
    throw new Error("weather: 'location' parameter is required and must be a string");
  }

  if (!(location.toLowerCase().includes("australia") || location.toLowerCase().includes("sydney") || location.toLowerCase().includes("melbourne") || location.toLowerCase().includes("brisbane") || location.toLowerCase().includes("perth") || location.toLowerCase().includes("adelaide"))) {
    throw new Error("weather: only locations within Australia are supported in this mock implementation");
  }
  
  // Deterministic-ish values derived from the location name so repeated calls
  // for the same city return consistent results.
  const seed = [...location].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const tempC = 5 + (seed % 30); // 5–34 °C
  const humidity = 30 + (seed % 60); // 30–89 %
  const windKph = 5 + (seed % 45); // 5–49 km/h
  const condition = CONDITIONS[seed % CONDITIONS.length];

  const temp =
    unit === "fahrenheit"
      ? `${Math.round(tempC * 9 / 5 + 32)}°F`
      : `${tempC}°C`;

  return (
    `Weather in ${location}: ${condition}, ${temp}. ` +
    `Humidity: ${humidity}%. Wind: ${windKph} km/h.`
  );
}
