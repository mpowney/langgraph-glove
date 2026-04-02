import type { ToolMetadata } from "@langgraph-glove/tool-server";

/** JSON Schema metadata for the US weather tool — consumed by introspection. */
export const weatherToolMetadata: ToolMetadata = {
  name: "weather_us",
  description:
    "Use {name} to get the current weather conditions for a given location within the United States. Only US locations are supported. " +
    "Returns temperature, conditions, humidity and wind speed.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name within the US, e.g. 'New York, NY' or 'Los Angeles'.",
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature unit. Defaults to fahrenheit.",
      },
    },
    required: ["location"],
  },
};

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
  "tornado warning",
  "humid and hot",
] as const;

/** US cities and states used for location validation. */
const US_KEYWORDS = [
  "usa", "united states", "u.s.", "america",
  // States
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
  "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina",
  "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia",
  "wisconsin", "wyoming",
  // Common state abbreviations (as suffix patterns)
  ", al", ", ak", ", az", ", ar", ", ca", ", co", ", ct", ", de",
  ", fl", ", ga", ", hi", ", id", ", il", ", in", ", ia", ", ks",
  ", ky", ", la", ", me", ", md", ", ma", ", mi", ", mn", ", ms",
  ", mo", ", mt", ", ne", ", nv", ", nh", ", nj", ", nm", ", ny",
  ", nc", ", nd", ", oh", ", ok", ", or", ", pa", ", ri", ", sc",
  ", sd", ", tn", ", tx", ", ut", ", vt", ", va", ", wa", ", wv",
  ", wi", ", wy",
  // Major cities
  "new york", "los angeles", "chicago", "houston", "phoenix",
  "philadelphia", "san antonio", "san diego", "dallas", "san jose",
  "austin", "jacksonville", "fort worth", "columbus", "charlotte",
  "indianapolis", "san francisco", "seattle", "denver", "nashville",
  "oklahoma city", "el paso", "washington dc", "boston", "las vegas",
  "portland", "memphis", "louisville", "baltimore", "milwaukee",
];

/**
 * Mock US weather tool handler.
 *
 * Returns plausible-looking data so the full RPC pipeline can be exercised
 * without an external dependency. Values are deterministic per location name.
 */
export async function handleWeather(params: Record<string, unknown>): Promise<string> {
  const location = params["location"] as string;
  const unit = (params["unit"] as string | undefined) ?? "fahrenheit";

  if (!location || typeof location !== "string") {
    throw new Error("weather_us: 'location' parameter is required and must be a string");
  }

  const locationLower = location.toLowerCase();
  const isUS = US_KEYWORDS.some((kw) => locationLower.includes(kw));
  if (!isUS) {
    throw new Error("weather_us: only locations within the United States are supported in this mock implementation");
  }

  // Deterministic-ish values derived from the location name so repeated calls
  // for the same city return consistent results.
  const seed = [...location].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const tempF = 20 + (seed % 90); // 20–109 °F
  const tempC = Math.round(((tempF - 32) * 5) / 9);
  const humidity = 20 + (seed % 70); // 20–89 %
  const windMph = 2 + (seed % 40); // 2–41 mph
  const condition = CONDITIONS[seed % CONDITIONS.length];

  const temp = unit === "celsius" ? `${tempC}°C` : `${tempF}°F`;

  return (
    `Weather in ${location}: ${condition}, ${temp}. ` +
    `Humidity: ${humidity}%. Wind: ${windMph} mph.`
  );
}
