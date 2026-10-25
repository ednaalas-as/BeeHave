import { formatMeasurement, type SeriesPoint, type SeriesResolution, type Summary } from "./index";

export type ChartMetric = "count" | "frequency" | "visitation" | "temperature" | "humidity";

/**
 * Names, units and descriptions for each graph series, shared by web and mobile.
 * Acoustic frequency (Hz, from the bee audio) and visitation frequency (detections per hour)
 * are different measurements, so neither is ever labelled just "Frequency".
 */
export const chartMetrics: Record<
  ChartMetric,
  {
    label: string;
    short: string;
    // Graph title, e.g. "Acoustic frequency over time".
    title: string;
    legend: string;
    // Y-axis label.
    axis: string;
    unit: string;
    description: string;
  }
> = {
  count: {
    label: "Number of Detections",
    short: "Detections",
    title: "Detections",
    legend: "T. biroi detections (count)",
    axis: "Detections",
    unit: "detections",
    description: "T. biroi detection counts",
  },
  frequency: {
    label: "Acoustic Frequency",
    short: "Acoustic frequency",
    title: "Acoustic frequency",
    legend: "Mean acoustic frequency (Hz)",
    axis: "Acoustic frequency (Hz)",
    unit: "Hz",
    description: "Mean acoustic frequency of recorded T. biroi audio in Hz",
  },
  visitation: {
    label: "Visitation Frequency",
    short: "Visitation frequency",
    title: "Visitation frequency",
    legend: "Visitation frequency (detections / hr)",
    axis: "Visitation (detections / hr)",
    unit: "detections / hr",
    description: "Visitation frequency: T. biroi detections per hour",
  },
  temperature: {
    label: "Temperature",
    short: "Temperature",
    title: "Temperature",
    legend: "Temperature (°C)",
    axis: "Temperature (°C)",
    unit: "°C",
    description: "Temperature in °C",
  },
  humidity: {
    label: "Humidity",
    short: "Humidity",
    title: "Humidity",
    legend: "Humidity (%)",
    axis: "Humidity (%)",
    unit: "%",
    description: "Humidity in %",
  },
};
export const chartMetricOrder: ChartMetric[] = [
  "count",
  "frequency",
  "visitation",
  "temperature",
  "humidity",
];

export const resolutionText: Record<SeriesResolution, string> = {
  hour: "hour",
  "3hour": "3 hours",
  day: "day",
  week: "week",
  month: "month",
};

export function formatChartValue(value: number, metric: ChartMetric) {
  if (metric === "count") return String(value);
  if (metric === "frequency" || metric === "visitation") return value.toFixed(1);
  return formatMeasurement(value);
}

const minimumSpan: Record<ChartMetric, number> = {
  count: 4,
  frequency: 20,
  visitation: 4,
  temperature: 4,
  humidity: 10,
};

/**
 * Y axis for one series. Counts start at zero; frequency, temperature and humidity are fitted
 * to their own range, so a 200 Hz series is not flattened against a zero baseline.
 */
export function chartScale(values: (number | null)[], metric: ChartMetric, intervals = 4) {
  const present = values.filter((value): value is number => value !== null);
  let low = metric === "count" ? 0 : present.length ? Math.min(...present) : 0;
  let high = present.length ? Math.max(...present) : metric === "count" ? 4 : 1;
  if (metric === "count") high = Math.max(high, 4);
  // A minimum span keeps tiny changes (0.05 Hz, 0.1 °C) from being stretched into steep lines.
  const span = minimumSpan[metric];
  if (high - low < span) {
    const middle = present.length ? (high + low) / 2 : span / 2;
    low = middle - span / 2;
    high = middle + span / 2;
  }
  // Counts, Hz and % cannot be negative; shift the window up instead of drawing below zero.
  if (metric !== "temperature" && low < 0) {
    high -= low;
    low = 0;
  }
  const raw = (high - low) / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const floor = Math.floor(low / step) * step;
  const ceiling = Math.max(floor + step, Math.ceil(high / step) * step);
  const ticks: number[] = [];
  // Rounding removes binary noise such as 0.30000000000000004 from the tick labels.
  for (let t = floor; t <= ceiling + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { floor, ceiling, ticks };
}

const zone = "Asia/Manila";
const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options });
const hour = fmt({ hour: "numeric" });
const time = fmt({ hour: "numeric", minute: "2-digit" });
const day = fmt({ month: "short", day: "numeric" });
const fullDay = fmt({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
const dayYear = fmt({ month: "short", day: "numeric", year: "numeric" });
const month = fmt({ month: "short" });
const monthYear = fmt({ month: "short", year: "2-digit" });
const fullMonth = fmt({ month: "long", year: "numeric" });
const manilaHour = (date: Date) => Number(fmt({ hour: "numeric", hourCycle: "h23" }).format(date));

/**
 * Visitation frequency of one bucket: its Bee detections per hour. The bucket still in progress
 * is divided by the hours elapsed so far, so today's value is not diluted by future hours.
 */
function visitation(point: SeriesPoint) {
  if (point.count === null) return null;
  const hours = (Math.min(Date.parse(point.end), Date.now()) - Date.parse(point.start)) / 3600000;
  return hours > 0 ? point.count / Math.max(1, hours) : null;
}

/** Axis labels, tooltip periods and values for a summary's chronological series. */
export function chartSeries(summary: Summary, metric: ChartMetric) {
  // An API server older than the series field still provides per-day values.
  const resolution = summary.series ? (summary.resolution ?? "day") : "day";
  const points: SeriesPoint[] =
    summary.series ??
    summary.daily.map((d) => {
      const start = Date.parse(`${d.date}T00:00:00+08:00`);
      return {
        start: new Date(start).toISOString(),
        end: new Date(start + 86400000).toISOString(),
        count: d.count,
        frequency: d.count ? d.frequency : null,
        temperature: d.temperature,
        humidity: d.humidity,
      };
    });
  const spansYears =
    points.length > 0 &&
    new Date(points[0].start).getUTCFullYear() !==
      new Date(points[points.length - 1].start).getUTCFullYear();
  return {
    resolution,
    values: points.map((p) => (metric === "visitation" ? visitation(p) : (p[metric] ?? null))),
    labels: points.map((p) => {
      const start = new Date(p.start);
      if (resolution === "hour") return hour.format(start);
      // Three-hour buckets are labelled once per day so the axis stays readable.
      if (resolution === "3hour") return manilaHour(start) === 0 ? day.format(start) : "";
      if (resolution === "month") return (spansYears ? monthYear : month).format(start);
      return day.format(start);
    }),
    periods: points.map((p) => {
      const start = new Date(p.start);
      const end = new Date(p.end);
      const last = new Date(Date.parse(p.end) - 1);
      if (resolution === "hour" || resolution === "3hour")
        return `${dayYear.format(start)} · ${time.format(start)} – ${time.format(end)}`;
      if (resolution === "day") return fullDay.format(start);
      if (resolution === "week") return `${day.format(start)} – ${dayYear.format(last)}`;
      return fullMonth.format(start);
    }),
  };
}
