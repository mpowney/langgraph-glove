import type { ToolMetadata } from "@langgraph-glove/tool-server";
import Holidays, { type HolidaysTypes } from "date-holidays";

/** Holiday types considered "public" for reporting purposes. */
const PUBLIC_HOLIDAY_TYPES: HolidaysTypes.HolidayType[] = ["public", "bank"];

export const dateTimeToolMetadata: ToolMetadata = {
  name: "datetime_info",
  description:
    "Use {name} to get comprehensive date and time information relevant to making decisions. " +
    "Reports the current date and time in both local time and GMT/UTC, identifies whether today, " +
    "yesterday, and tomorrow are public holidays (including state-specific holidays, e.g. Melbourne " +
    "vs Sydney in Australia), provides week number, day of year, time zone offset, and the next " +
    "upcoming public holiday. Supply the IANA timezone (e.g. 'Australia/Melbourne'), a two-letter " +
    "ISO 3166-1 country code (e.g. 'AU'), and an optional ISO 3166-2 state code (e.g. 'VIC' for " +
    "Victoria) to get localised holiday information.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "IANA timezone name for the user's location, e.g. 'Australia/Melbourne', " +
          "'Australia/Sydney', 'America/New_York', 'Europe/London'. " +
          "Defaults to 'UTC' when omitted.",
      },
      country: {
        type: "string",
        description:
          "ISO 3166-1 alpha-2 country code, e.g. 'AU', 'US', 'GB'. " +
          "Required for public holiday lookups.",
      },
      state: {
        type: "string",
        description:
          "ISO 3166-2 subdivision code (state/territory/province) without the country prefix, " +
          "e.g. 'VIC' for Victoria (AU), 'NSW' for New South Wales (AU), 'CA' for California (US). " +
          "Enables state-specific public holidays such as Melbourne Cup Day in Victoria.",
      },
    },
  },
};

interface DateTimeParams {
  timezone?: string;
  country?: string;
  state?: string;
}

type ArithmeticOperation = "add" | "subtract";
type DateUnit = "day" | "days" | "week" | "weeks" | "month" | "months" | "year" | "years";
type TimeUnit =
  | "hour"
  | "hours"
  | "minute"
  | "minutes"
  | "second"
  | "seconds"
  | "millisecond"
  | "milliseconds";

interface DateCalculationParams {
  dateTime?: string;
  operation?: ArithmeticOperation;
  amount?: number;
  unit?: DateUnit;
}

interface TimeCalculationParams {
  dateTime?: string;
  operation?: ArithmeticOperation;
  amount?: number;
  unit?: TimeUnit;
}

export const calculateDateToolMetadata: ToolMetadata = {
  name: "calculate_date",
  description:
    "Use {name} to add or subtract calendar date units from a datetime. " +
    "Provide an optional ISO datetime string; when omitted, the current datetime is used.",
  parameters: {
    type: "object",
    properties: {
      dateTime: {
        type: "string",
        description:
          "Optional base datetime in ISO 8601 format (for example '2026-04-10T09:30:00Z'). " +
          "If omitted, the current datetime is used.",
      },
      operation: {
        type: "string",
        enum: ["add", "subtract"],
        description: "Whether to add to or subtract from the base datetime. Defaults to 'add'.",
      },
      amount: {
        type: "number",
        description: "Amount of the selected unit to add or subtract.",
      },
      unit: {
        type: "string",
        enum: ["day", "days", "week", "weeks", "month", "months", "year", "years"],
        description: "Calendar unit for date arithmetic.",
      },
    },
    required: ["amount", "unit"],
  },
};

export const calculateTimeToolMetadata: ToolMetadata = {
  name: "calculate_time",
  description:
    "Use {name} to add or subtract clock time units from a datetime. " +
    "Provide an optional ISO datetime string; when omitted, the current datetime is used.",
  parameters: {
    type: "object",
    properties: {
      dateTime: {
        type: "string",
        description:
          "Optional base datetime in ISO 8601 format (for example '2026-04-10T09:30:00Z'). " +
          "If omitted, the current datetime is used.",
      },
      operation: {
        type: "string",
        enum: ["add", "subtract"],
        description: "Whether to add to or subtract from the base datetime. Defaults to 'add'.",
      },
      amount: {
        type: "number",
        description: "Amount of the selected unit to add or subtract.",
      },
      unit: {
        type: "string",
        enum: [
          "hour",
          "hours",
          "minute",
          "minutes",
          "second",
          "seconds",
          "millisecond",
          "milliseconds",
        ],
        description: "Clock-time unit for time arithmetic.",
      },
    },
    required: ["amount", "unit"],
  },
};

/** Format a holiday entry into a short human-readable description. */
function formatHolidayDetail(h: HolidaysTypes.Holiday): string {
  const suffix = h.substitute ? " (substitute day)" : "";
  return `**${h.name}** (${h.type}${suffix})`;
}

/** Return the ISO week number (1-53) for a given Date. */
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number; Sunday is 7
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Return the day of the year (1-366) for a given Date. */
function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}

/** Format a Date in the given IANA timezone as a human-readable string. */
function formatInTimezone(date: Date, timezone: string): string {
  return date.toLocaleString("en-AU", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  });
}

/** Return the UTC offset string (e.g. "+11:00") for a timezone at the given moment. */
function utcOffset(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
}

/** Get the local date (midnight) in the given timezone offset from a UTC Date. */
function localDateString(date: Date, timezone: string): string {
  return date.toLocaleDateString("en-AU", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Parse a "DD/MM/YYYY" locale date string into a JS Date (midnight UTC). */
function parseDMY(dmy: string): Date {
  const [day, month, year] = dmy.split("/").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function parseBaseDateTime(value: unknown): Date {
  if (value === undefined || value === null || value === "") {
    return new Date();
  }

  if (typeof value !== "string") {
    throw new Error("'dateTime' must be a string in ISO 8601 format when provided");
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("'dateTime' is invalid. Provide a valid ISO 8601 datetime string");
  }

  return parsed;
}

function parseOperation(value: unknown): ArithmeticOperation {
  if (value === undefined) return "add";
  if (value === "add" || value === "subtract") return value;
  throw new Error("'operation' must be either 'add' or 'subtract'");
}

function parseAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("'amount' is required and must be a finite number");
  }
  return value;
}

function normalizeDateUnit(value: unknown): "day" | "week" | "month" | "year" {
  if (value === "day" || value === "days") return "day";
  if (value === "week" || value === "weeks") return "week";
  if (value === "month" || value === "months") return "month";
  if (value === "year" || value === "years") return "year";
  throw new Error("'unit' must be one of: day(s), week(s), month(s), year(s)");
}

function normalizeTimeUnit(value: unknown): "hour" | "minute" | "second" | "millisecond" {
  if (value === "hour" || value === "hours") return "hour";
  if (value === "minute" || value === "minutes") return "minute";
  if (value === "second" || value === "seconds") return "second";
  if (value === "millisecond" || value === "milliseconds") return "millisecond";
  throw new Error(
    "'unit' must be one of: hour(s), minute(s), second(s), millisecond(s)",
  );
}

function formatCalculationResult(
  title: string,
  base: Date,
  operation: ArithmeticOperation,
  amount: number,
  unit: string,
  result: Date,
): string {
  return [
    `## ${title}`,
    `- **Base datetime (ISO 8601 UTC):** ${base.toISOString()}`,
    `- **Calculation:** ${operation} ${amount} ${unit}`,
    `- **Result datetime (ISO 8601 UTC):** ${result.toISOString()}`,
  ].join("\n");
}

export async function handleDateTime(params: Record<string, unknown>): Promise<string> {
  const { timezone = "UTC", country, state } = params as DateTimeParams;

  // Validate timezone
  let validatedTimezone = "UTC";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    validatedTimezone = timezone;
  } catch {
    // Fall back to UTC and note the error below
  }

  const now = new Date();
  const tzIsValid = validatedTimezone === timezone;

  // --- Date/time strings ---
  const localDateTime = formatInTimezone(now, validatedTimezone);
  const gmtDateTime = now.toLocaleString("en-AU", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  });

  const offset = utcOffset(now, validatedTimezone);
  const isoNow = now.toISOString();

  // Day info in the local timezone
  const localDayName = now.toLocaleDateString("en-AU", {
    timeZone: validatedTimezone,
    weekday: "long",
  });
  const isWeekend = ["Saturday", "Sunday"].includes(localDayName);

  // We need "today", "yesterday", and "tomorrow" as Date objects at midnight UTC
  // but adjusted so that we reflect the local calendar date in the given timezone.
  const localDateStr = localDateString(now, validatedTimezone);
  const todayUTC = parseDMY(localDateStr);
  const yesterdayUTC = new Date(todayUTC.getTime() - 86400000);
  const tomorrowUTC = new Date(todayUTC.getTime() + 86400000);

  const weekNum = isoWeekNumber(todayUTC);
  const doy = dayOfYear(todayUTC);
  const daysUntilYearEnd =
    (isLeapYear(todayUTC.getUTCFullYear()) ? 366 : 365) - doy;

  // --- Public holidays ---
  let holidayLines: string[] = [];
  let nextHolidayLine = "";

  if (country) {
    try {
      const hdOpts: HolidaysTypes.Options = {
        types: PUBLIC_HOLIDAY_TYPES,
        timezone: validatedTimezone,
      };
      const hd = state
        ? new Holidays(country.toUpperCase(), state.toUpperCase(), hdOpts)
        : new Holidays(country.toUpperCase(), hdOpts);

      const checkHoliday = (date: Date, label: string): string | null => {
        const result = hd.isHoliday(date);
        if (!result || result.length === 0) return null;
        return `${label}: ${formatHolidayDetail(result[0]!)}`;
      };

      const todayHoliday = checkHoliday(todayUTC, "Today");
      const yesterdayHoliday = checkHoliday(yesterdayUTC, "Yesterday");
      const tomorrowHoliday = checkHoliday(tomorrowUTC, "Tomorrow");

      if (todayHoliday) holidayLines.push(todayHoliday);
      if (yesterdayHoliday) holidayLines.push(yesterdayHoliday);
      if (tomorrowHoliday) holidayLines.push(tomorrowHoliday);

      // Find the next upcoming public holiday after today
      const upcomingHolidays = hd
        .getHolidays(todayUTC.getUTCFullYear())
        .filter((h) => h.start > todayUTC && PUBLIC_HOLIDAY_TYPES.includes(h.type))
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      // Also check next year if none remain this year
      if (upcomingHolidays.length === 0) {
        const nextYearHolidays = hd
          .getHolidays(todayUTC.getUTCFullYear() + 1)
          .filter((h) => PUBLIC_HOLIDAY_TYPES.includes(h.type))
          .sort((a, b) => a.start.getTime() - b.start.getTime());
        upcomingHolidays.push(...nextYearHolidays);
      }

      if (upcomingHolidays.length > 0) {
        const next = upcomingHolidays[0]!;
        const daysUntil = Math.ceil(
          (next.start.getTime() - todayUTC.getTime()) / 86400000,
        );
        const nextDateStr = next.start.toLocaleDateString("en-AU", {
          timeZone: validatedTimezone,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
        nextHolidayLine = `Next public holiday: ${formatHolidayDetail(next)} on ${nextDateStr} (in ${daysUntil} day${daysUntil !== 1 ? "s" : ""})`;
      }
    } catch {
      holidayLines.push(
        `Public holiday lookup unavailable — unsupported country/state code: ${country}${state ? `/${state}` : ""}.`,
      );
    }
  } else {
    holidayLines.push(
      "No country code supplied — public holiday information is not available. " +
        "Provide the 'country' parameter (and optionally 'state') for local holiday data.",
    );
  }

  // --- Build output ---
  const lines: string[] = [];

  if (!tzIsValid) {
    lines.push(
      `⚠️  Unrecognised timezone '${timezone}'. Falling back to UTC.\n`,
    );
  }

  lines.push(`## Current Date & Time`);
  lines.push(`- **Local (${validatedTimezone}):** ${localDateTime}`);
  lines.push(`- **GMT / UTC:** ${gmtDateTime}`);
  lines.push(`- **ISO 8601 (UTC):** ${isoNow}`);
  lines.push(`- **UTC offset for ${validatedTimezone}:** ${offset}`);
  lines.push(``);

  lines.push(`## Day Information`);
  lines.push(`- **Day of week:** ${localDayName}${isWeekend ? " (weekend)" : " (weekday)"}`);
  lines.push(`- **Week number (ISO 8601):** Week ${weekNum}`);
  lines.push(`- **Day of year:** Day ${doy} of ${isLeapYear(todayUTC.getUTCFullYear()) ? 366 : 365}`);
  lines.push(`- **Days remaining in year:** ${daysUntilYearEnd}`);
  lines.push(``);

  lines.push(`## Public Holidays`);
  for (const line of holidayLines) {
    lines.push(`- ${line}`);
  }
  if (holidayLines.length === 0) {
    lines.push(`- None of yesterday, today, or tomorrow are public holidays.`);
  }
  if (nextHolidayLine) {
    lines.push(`- ${nextHolidayLine}`);
  }

  return lines.join("\n");
}

export async function handleCalculateDate(params: Record<string, unknown>): Promise<string> {
  const { dateTime, operation, amount, unit } = params as DateCalculationParams;
  const base = parseBaseDateTime(dateTime);
  const parsedOperation = parseOperation(operation);
  const parsedAmount = parseAmount(amount);
  const parsedUnit = normalizeDateUnit(unit);
  const signedAmount = parsedOperation === "subtract" ? -parsedAmount : parsedAmount;

  const result = new Date(base.getTime());
  switch (parsedUnit) {
    case "day":
      result.setUTCDate(result.getUTCDate() + signedAmount);
      break;
    case "week":
      result.setUTCDate(result.getUTCDate() + signedAmount * 7);
      break;
    case "month":
      result.setUTCMonth(result.getUTCMonth() + signedAmount);
      break;
    case "year":
      result.setUTCFullYear(result.getUTCFullYear() + signedAmount);
      break;
  }

  return formatCalculationResult("Date Calculation", base, parsedOperation, parsedAmount, parsedUnit, result);
}

export async function handleCalculateTime(params: Record<string, unknown>): Promise<string> {
  const { dateTime, operation, amount, unit } = params as TimeCalculationParams;
  const base = parseBaseDateTime(dateTime);
  const parsedOperation = parseOperation(operation);
  const parsedAmount = parseAmount(amount);
  const parsedUnit = normalizeTimeUnit(unit);
  const signedAmount = parsedOperation === "subtract" ? -parsedAmount : parsedAmount;

  let multiplier = 1;
  switch (parsedUnit) {
    case "hour":
      multiplier = 3600000;
      break;
    case "minute":
      multiplier = 60000;
      break;
    case "second":
      multiplier = 1000;
      break;
    case "millisecond":
      multiplier = 1;
      break;
  }

  const result = new Date(base.getTime() + signedAmount * multiplier);
  return formatCalculationResult("Time Calculation", base, parsedOperation, parsedAmount, parsedUnit, result);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
