import type { ToolMetadata } from "@langgraph-glove/tool-server";

const BOM_API_BASE = "https://api.weather.bom.gov.au/v1";

// ---------------------------------------------------------------------------
// Shared BOM location search — also used by RainForecastTool
// ---------------------------------------------------------------------------

export interface BomLocation {
  geohash: string;
  trimmedGeohash: string; // first 6 chars of geohash, used for forecasts
  name: string;
  state: string;
}

/**
 * Resolve a free-text location string to the first matching BOM location.
 * Throws if no match is found.
 */
export async function searchLocation(location: string): Promise<BomLocation> {
  const url = `${BOM_API_BASE}/locations?search=${encodeURIComponent(location)}`;
  const res = await fetch(url, { headers: { "User-Agent": "langgraph-glove/1.0" } });
  if (!res.ok) {
    throw new Error(`BOM location search failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { data: BomLocation[] };
  if (!body.data || body.data.length === 0) {
    throw new Error(`No Australian location found for "${location}"`);
  }
  const loc = body.data[0]!;
  return { ...loc, trimmedGeohash: loc.geohash.slice(0, 6) };
}

// ---------------------------------------------------------------------------
// Weather tool
// ---------------------------------------------------------------------------

/** JSON Schema metadata for the weather tool — consumed by introspection. */
export const weatherToolMetadata: ToolMetadata = {
  name: "weather_au",
  description:
    "Get the current weather conditions for a given location within Australia using the " +
    "Bureau of Meteorology (BOM) live API. Returns temperature, feels-like temperature, " +
    "humidity, wind speed/direction, and rain since 9 am.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City or suburb name within Australia, e.g. 'Sydney' or 'Melbourne'.",
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

interface BomObservationsResponse {
  data: {
    temp: number;
    temp_feels_like: number;
    humidity: number;
    wind: { speed_kilometre: number; direction: string };
    rain_since_9am: number | null;
    station: { name: string };
  };
}

export async function handleWeather(params: Record<string, unknown>): Promise<string> {
  const location = params["location"] as string;
  const unit = (params["unit"] as string | undefined) ?? "celsius";

  if (!location || typeof location !== "string") {
    throw new Error("weather_au: 'location' parameter is required and must be a string");
  }

  const loc = await searchLocation(location);

  const obsUrl = `${BOM_API_BASE}/locations/${loc.trimmedGeohash}/observations`;
  const obsRes = await fetch(obsUrl, { headers: { "User-Agent": "langgraph-glove/1.0" } });
  if (!obsRes.ok) {
    throw new Error(`BOM observations request failed: ${obsRes.status} ${obsRes.statusText}`);
  }
  const obs = await obsRes.json() as BomObservationsResponse;
  const d = obs.data;

  const fmt = (c: number) =>
    unit === "fahrenheit" ? `${Math.round(c * 9 / 5 + 32)}°F` : `${c}°C`;

  const lines = [
    `Current weather in ${loc.name}, ${loc.state} (station: ${d.station.name}):`,
    `  Temperature:  ${fmt(d.temp)} (feels like ${fmt(d.temp_feels_like)})`,
    `  Humidity:     ${d.humidity}%`,
    `  Wind:         ${d.wind.speed_kilometre} km/h from ${d.wind.direction}`,
  ];
  if (d.rain_since_9am !== null && d.rain_since_9am !== undefined) {
    lines.push(`  Rain since 9am: ${d.rain_since_9am} mm`);
  }

  return lines.join("\n");
}
