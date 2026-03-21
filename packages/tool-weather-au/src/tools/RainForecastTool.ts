import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { searchLocation } from "./WeatherTool.js";

const BOM_API_BASE = "https://api.weather.bom.gov.au/v1";

// ---------------------------------------------------------------------------
// Rain forecast tool
// ---------------------------------------------------------------------------

export const rainForecastToolMetadata: ToolMetadata = {
  name: "rain_forecast_au",
  description:
    "Get the forecast amount of rain expected to fall in the next 24 hours for a given " +
    "location within Australia, using the Bureau of Meteorology (BOM) live API. " +
    "Returns the expected rainfall range (mm), maximum chance of rain, and an hour-by-hour summary.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City or suburb name within Australia, e.g. 'Sydney' or 'Melbourne'.",
      },
    },
    required: ["location"],
  },
};

interface HourlyEntry {
  time: string;
  rain: {
    amount: { min: number; max: number; units: string };
    chance: number;
  };
  short_text?: string;
}

export async function handleRainForecast(params: Record<string, unknown>): Promise<string> {
  const location = params["location"] as string;
  if (!location || typeof location !== "string") {
    throw new Error("rain_forecast_au: 'location' parameter is required and must be a string");
  }

  const loc = await searchLocation(location);

  const url = `${BOM_API_BASE}/locations/${loc.trimmedGeohash}/forecasts/hourly`;
  const res = await fetch(url, { headers: { "User-Agent": "langgraph-glove/1.0" } });
  if (!res.ok) {
    throw new Error(`BOM hourly forecast request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { data: HourlyEntry[] };

  // Take up to the next 24 hourly periods.
  const hours = body.data.slice(0, 24);
  if (hours.length === 0) {
    throw new Error(`BOM returned no hourly forecast data for "${loc.name}, ${loc.state}"`);
  }

  let totalMin = 0;
  let totalMax = 0;
  let maxChance = 0;

  // Hours with meaningful rainfall (>0 max) for the summary.
  const rainyHours: string[] = [];

  for (const h of hours) {
    const rain = h.rain;
    totalMin += rain?.amount?.min ?? 0;
    totalMax += rain?.amount?.max ?? 0;
    const chance = rain?.chance ?? 0;
    if (chance > maxChance) maxChance = chance;

    if ((rain?.amount?.max ?? 0) > 0 || chance >= 30) {
      const localTime = new Date(h.time).toLocaleTimeString("en-AU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Australia/Sydney", // BOM times are UTC; use a broad AU tz for display
      });
      const desc = h.short_text ? ` (${h.short_text})` : "";
      rainyHours.push(
        `  ${localTime}: ${rain?.amount?.min ?? 0}–${rain?.amount?.max ?? 0} mm, ${chance}% chance${desc}`
      );
    }
  }

  const units = hours[0]?.rain?.amount?.units ?? "mm";

  const lines = [
    `24-hour rain forecast for ${loc.name}, ${loc.state}:`,
    `  Total expected: ${totalMin.toFixed(1)}–${totalMax.toFixed(1)} ${units}`,
    `  Max chance of rain: ${maxChance}%`,
  ];

  if (rainyHours.length > 0) {
    lines.push("  Hours with rain or ≥30% chance:");
    lines.push(...rainyHours);
  } else {
    lines.push("  No significant rainfall expected in the next 24 hours.");
  }

  return lines.join("\n");
}
