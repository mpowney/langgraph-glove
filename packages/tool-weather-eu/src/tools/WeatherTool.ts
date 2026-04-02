import type { ToolMetadata } from "@langgraph-glove/tool-server";

/** JSON Schema metadata for the European weather tool — consumed by introspection. */
export const weatherToolMetadata: ToolMetadata = {
  name: "weather_eu",
  description:
    "Use {name} to get the current weather conditions for a given location within Europe. Only locations in Europe are supported. " +
    "Returns temperature, conditions, humidity and wind speed.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name within Europe, e.g. 'London' or 'Paris'.",
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
  "drizzle",
  "hail",
] as const;

/** European cities used for location validation. */
const EU_KEYWORDS = [
  "uk", "england", "scotland", "wales", "ireland",
  "france", "germany", "spain", "italy", "portugal",
  "netherlands", "belgium", "switzerland", "austria",
  "sweden", "norway", "denmark", "finland", "poland",
  "czech", "slovakia", "hungary", "romania", "bulgaria",
  "greece", "croatia", "serbia", "ukraine", "europe",
  // Common cities
  "london", "paris", "berlin", "madrid", "rome", "amsterdam",
  "brussels", "vienna", "stockholm", "oslo", "copenhagen",
  "helsinki", "warsaw", "prague", "budapest", "bucharest",
  "athens", "zagreb", "lisbon", "barcelona", "munich",
  "hamburg", "frankfurt", "milan", "naples", "zurich",
  "geneva", "edinburgh", "dublin", "glasgow", "manchester",
  "birmingham", "lyon", "marseille", "toulouse", "nice",
];

/**
 * Mock European weather tool handler.
 *
 * Returns plausible-looking data so the full RPC pipeline can be exercised
 * without an external dependency. Values are deterministic per location name.
 */
export async function handleWeather(params: Record<string, unknown>): Promise<string> {
  const location = params["location"] as string;
  const unit = (params["unit"] as string | undefined) ?? "celsius";

  if (!location || typeof location !== "string") {
    throw new Error("weather_eu: 'location' parameter is required and must be a string");
  }

  const locationLower = location.toLowerCase();
  const isEuropean = EU_KEYWORDS.some((kw) => locationLower.includes(kw));
  if (!isEuropean) {
    throw new Error("weather_eu: only locations within Europe are supported in this mock implementation");
  }

  // Deterministic-ish values derived from the location name so repeated calls
  // for the same city return consistent results.
  const seed = [...location].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const tempC = -5 + (seed % 30); // -5–24 °C (cooler European range)
  const humidity = 40 + (seed % 50); // 40–89 %
  const windKph = 5 + (seed % 55); // 5–59 km/h
  const condition = CONDITIONS[seed % CONDITIONS.length];

  const temp =
    unit === "fahrenheit"
      ? `${Math.round((tempC * 9) / 5 + 32)}°F`
      : `${tempC}°C`;

  return (
    `Weather in ${location}: ${condition}, ${temp}. ` +
    `Humidity: ${humidity}%. Wind: ${windKph} km/h.`
  );
}
