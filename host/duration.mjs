const UNITS = new Map([
  ["millisecond", 1],
  ["second", 1_000],
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
  ["month", 2_592_000_000],
  ["year", 31_536_000_000],
]);

export function parseDuration(value, label = "duration") {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${label} must be a finite non-negative number`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be milliseconds or a human-readable duration`);
  }

  const match = value.trim().match(
    /^(\d+(?:\.\d+)?)\s*(milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/i,
  );
  if (!match) {
    throw new TypeError(`Unsupported ${label}: ${value}`);
  }
  const unit = match[2].toLowerCase().replace(/s$/, "");
  return Number(match[1]) * UNITS.get(unit);
}

export function parseSleepUntil(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) throw new TypeError("sleepUntil received an invalid Date");
    return time;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("sleepUntil requires a Date or Unix milliseconds");
}
