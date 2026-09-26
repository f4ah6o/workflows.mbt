const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function expandPart(part, min, max, fieldIndex) {
  const [base, stepText] = part.split("/");
  const step = stepText == null ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step < 1) {
    throw new TypeError(`Invalid cron step: ${part}`);
  }

  let start;
  let end;
  if (base === "*") {
    start = min;
    end = max;
  } else if (base.includes("-")) {
    const [left, right] = base.split("-");
    start = Number(left);
    end = Number(right);
  } else {
    start = Number(base);
    end = start;
  }

  if (
    !Number.isInteger(start) || !Number.isInteger(end) ||
    start < min || end > max || start > end
  ) {
    throw new TypeError(`Invalid cron field value: ${part}`);
  }

  const out = new Set();
  for (let value = start; value <= end; value += step) {
    out.add(fieldIndex === 4 && value === 7 ? 0 : value);
  }
  return out;
}

function parseField(text, fieldIndex) {
  const [min, max] = RANGES[fieldIndex];
  const values = new Set();
  for (const part of text.split(",")) {
    for (const value of expandPart(part, min, max, fieldIndex)) values.add(value);
  }
  return { values, wildcard: text === "*" };
}

export function parseCron(expression) {
  if (typeof expression !== "string") throw new TypeError("cron must be a string");
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new TypeError(`Cron expression must contain 5 fields: ${expression}`);
  }
  return fields.map(parseField);
}

export function matchesCron(expression, timestamp) {
  const fields = parseCron(expression);
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new TypeError("Invalid cron timestamp");

  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];
  const minuteHourMonth =
    fields[0].values.has(values[0]) &&
    fields[1].values.has(values[1]) &&
    fields[3].values.has(values[3]);
  if (!minuteHourMonth) return false;

  const domMatches = fields[2].values.has(values[2]);
  const dowMatches = fields[4].values.has(values[4]);
  if (fields[2].wildcard && fields[4].wildcard) return true;
  if (fields[2].wildcard) return dowMatches;
  if (fields[4].wildcard) return domMatches;
  return domMatches || dowMatches;
}
