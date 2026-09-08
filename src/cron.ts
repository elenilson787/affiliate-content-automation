function parseNumber(value: string) {
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

function matchesPart(part: string, value: number, min: number, max: number, normalize?: (n: number) => number): boolean {
  const [rangeExpr, stepExpr] = part.split("/");
  const step = stepExpr ? parseNumber(stepExpr) : 1;
  if (!step || step < 1) return false;

  if (rangeExpr === "*") return (value - min) % step === 0;

  if (rangeExpr.includes("-")) {
    const [startRaw, endRaw] = rangeExpr.split("-");
    const startParsed = parseNumber(startRaw);
    const endParsed = parseNumber(endRaw);
    if (startParsed == null || endParsed == null) return false;
    const start = normalize ? normalize(startParsed) : startParsed;
    const end = normalize ? normalize(endParsed) : endParsed;
    if (start < min || end > max || start > end || value < start || value > end) return false;
    return (value - start) % step === 0;
  }

  const parsed = parseNumber(rangeExpr);
  if (parsed == null) return false;
  const target = normalize ? normalize(parsed) : parsed;
  return target >= min && target <= max && value === target;
}

function matchesField(expr: string, value: number, min: number, max: number, normalize?: (n: number) => number) {
  return expr.split(",").some((part) => matchesPart(part.trim(), value, min, max, normalize));
}

function localParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday,
  };
}

export function cronMatches(expression: string, date: Date, timezone: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = fields;

  let parts: ReturnType<typeof localParts>;
  try {
    parts = localParts(date, timezone);
  } catch {
    return false;
  }

  if (!matchesField(minuteExpr, parts.minute, 0, 59)) return false;
  if (!matchesField(hourExpr, parts.hour, 0, 23)) return false;
  if (!matchesField(monthExpr, parts.month, 1, 12)) return false;

  const dayMatch = matchesField(dayExpr, parts.day, 1, 31);
  const weekdayMatch = matchesField(weekdayExpr, parts.weekday, 0, 6, (n) => n === 7 ? 0 : n);
  const dayWildcard = dayExpr === "*";
  const weekdayWildcard = weekdayExpr === "*";

  if (dayWildcard && weekdayWildcard) return true;
  if (dayWildcard) return weekdayMatch;
  if (weekdayWildcard) return dayMatch;
  return dayMatch || weekdayMatch;
}

export function findDueSlot(expression: string, now: Date, timezone: string, lookbackMinutes = 5) {
  const minute = new Date(now);
  minute.setUTCSeconds(0, 0);

  for (let offset = 0; offset < lookbackMinutes; offset += 1) {
    const candidate = new Date(minute.getTime() - offset * 60_000);
    if (cronMatches(expression, candidate, timezone)) return candidate;
  }
  return null;
}

export async function stableUuid(input: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
