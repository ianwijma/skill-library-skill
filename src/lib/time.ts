const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const pad = (value: number): string => String(value).padStart(2, "0");

/** "3 hours ago", "5 days ago", "just now" (or "in 2 minutes" for a clock skewed into the future). */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);

  if (abs < 60) {
    return "just now";
  }

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });

  for (const [unit, size] of UNITS) {
    if (abs >= size) {
      return rtf.format(Math.trunc(seconds / size), unit);
    }
  }

  return "just now";
}

/** Local date and time as "2026-11-09 15:24", plus the zone abbreviation when one is known. */
export function localDateTime(date: Date): string {
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const zone = new Intl.DateTimeFormat("en", { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  return zone ? `${base} ${zone}` : base;
}

/** "3 hours ago (2026-11-09 15:24 CET)"; returns the input unchanged if it is not a valid timestamp. */
export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return `${relativeTime(date, now)} (${localDateTime(date)})`;
}
