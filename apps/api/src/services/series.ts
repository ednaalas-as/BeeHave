import type { SeriesPoint, SeriesResolution } from "@beehave/shared";

const MANILA = 8 * 3600000;
const HOUR = 3600000;
const DAY = 86400000;

/**
 * Chart resolution for a range of whole Manila days, so long ranges are not drawn hour by hour:
 * today is hourly, a week or month is daily, a quarter is weekly and a year or longer is monthly.
 */
export function seriesResolution(days: number): SeriesResolution {
  if (days <= 1) return "hour";
  if (days <= 3) return "3hour";
  if (days <= 62) return "day";
  if (days <= 180) return "week";
  return "month";
}

// Start of the bucket after the one containing t. Days, weeks (Monday) and months follow Manila time.
function next(t: number, resolution: SeriesResolution) {
  if (resolution === "hour") return t + HOUR;
  if (resolution === "3hour") return t + 3 * HOUR;
  const local = new Date(t + MANILA);
  const midnight =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - MANILA;
  if (resolution === "day") return midnight + DAY;
  if (resolution === "week") return midnight + ((8 - local.getUTCDay()) % 7 || 7) * DAY;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - MANILA;
}

/**
 * Aggregates observations for presentation only: Bee detections are summed, their acoustic
 * frequencies and the readings averaged.
 * A bucket with no Bee detections is 0 only when the device sent other data for it; otherwise null.
 */
export function buildSeries({
  start,
  end,
  resolution,
  bees,
  otherActivity,
  readings,
}: {
  start: number;
  end: number;
  resolution: SeriesResolution;
  bees: { at: number; frequency: number }[];
  otherActivity: number[];
  readings: { at: number; temperature: number | null; humidity: number | null }[];
}): SeriesPoint[] {
  const starts: number[] = [];
  for (let t = start; t < end; t = next(t, resolution)) starts.push(t);
  const buckets = starts.map(() => ({
    count: 0,
    evidence: false,
    frequencies: [] as number[],
    temperatures: [] as number[],
    humidities: [] as number[],
  }));
  const find = (t: number) => {
    if (t < start || t >= end) return undefined;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= t) low = mid;
      else high = mid - 1;
    }
    return buckets[low];
  };
  for (const bee of bees) {
    const bucket = find(bee.at);
    if (bucket) {
      bucket.count++;
      bucket.evidence = true;
      bucket.frequencies.push(bee.frequency);
    }
  }
  for (const t of otherActivity) {
    const bucket = find(t);
    if (bucket) bucket.evidence = true;
  }
  for (const reading of readings) {
    const bucket = find(reading.at);
    if (!bucket) continue;
    bucket.evidence = true;
    if (reading.temperature !== null) bucket.temperatures.push(reading.temperature);
    if (reading.humidity !== null) bucket.humidities.push(reading.humidity);
  }
  const average = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return buckets.map((bucket, i) => ({
    start: new Date(starts[i]).toISOString(),
    end: new Date(Math.min(end, starts[i + 1] ?? end)).toISOString(),
    count: bucket.evidence ? bucket.count : null,
    frequency: average(bucket.frequencies),
    temperature: average(bucket.temperatures),
    humidity: average(bucket.humidities),
  }));
}
