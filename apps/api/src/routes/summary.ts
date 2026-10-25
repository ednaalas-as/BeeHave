import {
manilaDate,
NON_BEE_CLASSIFICATION,
type Daily,
type Detection,
type Reading,
type Summary,
} from "@beehave/shared";
import type { RouteContext } from "../context";
import { range } from "../services/date-range";
import { deviceAccess, heldBy } from "../services/access";
import { buildSeries, seriesResolution } from "../services/series";
import { type EventRow } from "../types";
export function registerSummaryRoutes(context: RouteContext) {
  const { app, db, authenticate, ownedDevice, detectionView, devices, farmAccess } =
    context;
  function average(values: number[]) {
    return values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;
  }
  app.get("/api/summary", async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmAccess(req, account, "view");
    const dateRange = range(req);
    // One device of the selected farm, or every device of that farm; never another farm's.
    const device = typeof req.query.device === "string" ? req.query.device : "";
    if (device) await ownedDevice(device, farm.farmId);
    // Summaries count Bee-positive detections only; Non-Bee classifier windows are excluded.
    const query = `FROM detections e JOIN devices d ON d.id=e.device_id WHERE ${heldBy("e", "$1")} AND e.observed_at>=$2 AND e.observed_at<$3 AND (e.data->>'species') IS DISTINCT FROM '${NON_BEE_CLASSIFICATION}'${device ? " AND d.id=$4" : ""}`;
    const params = [
      farm.farmId,
      dateRange.start,
      dateRange.end,
      ...(device ? [device] : []),
    ];
    const rows = (await db.many(`SELECT e.* ${query} ORDER BY e.observed_at`, [
      ...params,
    ])) as EventRow[];
    const contextRows = (await db.many(
      `SELECT r.* FROM readings r WHERE ${heldBy("r", "$1")} AND r.observed_at>=$2 AND r.observed_at<$3`,
      [
        farm.farmId,
        new Date(Date.parse(dateRange.start) - 60000).toISOString(),
        new Date(Date.parse(dateRange.end) + 60000).toISOString(),
      ],
    )) as EventRow[];
    const contexts = new Map(
      contextRows.map((row) => [
        row.device_id + "/" + row.id,
        row.data as Reading,
      ]),
    );
    const detections = rows.map((row) => {
      const value = row.data as Detection;
      return {
        ...value,
        deviceId: row.device_id,
        reading: contexts.get(row.device_id + "/" + value.readingId) ?? null,
      };
    });
    const previousStart = new Date(
      Date.parse(dateRange.start) -
        (Date.parse(dateRange.end) - Date.parse(dateRange.start)),
    ).toISOString();
    const previous = (
      (await db.one(`SELECT COUNT(*)::integer count ${query}`, [
        farm.farmId,
        previousStart,
        dateRange.start,
        ...(device ? [device] : []),
      ])) as {
        count: number;
      }
    ).count;
    const hourly: Summary["hourly"] = Array.from({ length: 24 }, (_, i) => ({
      hour: String(i).padStart(2, "0"),
      count: 0,
      temperature: null,
      humidity: null,
    }));
    const hourlyReadings = Array.from({ length: 24 }, () => ({
      temperatures: [] as number[],
      humidities: [] as number[],
    }));
    for (const row of contextRows) {
      if (device && row.device_id !== device) continue;
      const reading = row.data as Reading;
      const observedAt = Date.parse(reading.observedAt);
      if (
        observedAt < Date.parse(dateRange.start) ||
        observedAt >= Date.parse(dateRange.end)
      ) continue;
      const bucket = hourlyReadings[
        new Date(observedAt + 8 * 3600000).getUTCHours()
      ];
      if (reading.temperature !== null) bucket.temperatures.push(reading.temperature);
      if (reading.humidity !== null) bucket.humidities.push(reading.humidity);
    }
    hourly.forEach((bucket, hour) => {
      const { temperatures, humidities } = hourlyReadings[hour];
      bucket.temperature = temperatures.length ? average(temperatures) : null;
      bucket.humidity = humidities.length ? average(humidities) : null;
    });
    const daily: Daily[] = [];
    for (
      let t = Date.parse(dateRange.start);
      t < Date.parse(dateRange.end);
      t += 86400000
    ) {
      const date = manilaDate(new Date(t));
      const values = detections.filter(
        (recording) => manilaDate(new Date(recording.observedAt)) === date,
      );
      const readings = [
        ...new Map(
          values.flatMap((recording) =>
            recording.reading
              ? [
                  [
                    recording.deviceId + "/" + recording.reading.id,
                    recording.reading,
                  ] as const,
                ]
              : [],
          ),
        ).values(),
      ];
      const temperatures = readings.flatMap((v) =>
        v.temperature === null ? [] : [v.temperature],
      );
      const humidities = readings.flatMap((v) =>
        v.humidity === null ? [] : [v.humidity],
      );
      daily.push({
        date,
        count: values.length,
        frequency: average(values.map((v) => v.frequency)),
        confidence: average(values.map((v) => v.confidence)),
        temperature: temperatures.length ? average(temperatures) : null,
        humidity: humidities.length ? average(humidities) : null,
      });
    }
    for (const recording of detections)
      hourly[
        new Date(Date.parse(recording.observedAt) + 8 * 3600000).getUTCHours()
      ].count++;
    // Non-Bee windows are not counted, but they show the device was producing data in that bucket.
    const nonBee = (await db.many(
      `SELECT e.data->>'observedAt' AS observed_at FROM detections e JOIN devices d ON d.id=e.device_id WHERE ${heldBy("e", "$1")} AND e.observed_at>=$2 AND e.observed_at<$3 AND (e.data->>'species')='${NON_BEE_CLASSIFICATION}'${device ? " AND d.id=$4" : ""}`,
      params,
    )) as { observed_at: string }[];
    const resolution = seriesResolution(
      Math.round((Date.parse(dateRange.end) - Date.parse(dateRange.start)) / 86400000),
    );
    const series = buildSeries({
      start: Date.parse(dateRange.start),
      end: Date.parse(dateRange.end),
      resolution,
      bees: detections.map((v) => ({ at: Date.parse(v.observedAt), frequency: v.frequency })),
      otherActivity: nonBee.map((v) => Date.parse(v.observed_at)),
      readings: contextRows
        .filter((row) => !device || row.device_id === device)
        .map((row) => {
          const reading = row.data as Reading;
          return {
            at: Date.parse(reading.observedAt),
            temperature: reading.temperature,
            humidity: reading.humidity,
          };
        }),
    });
    const peak = [...hourly].sort((a, b) => b.count - a.count)[0];
    // Visitation frequency is Bee detections per elapsed hour; the peak is the busiest single clock hour.
    const elapsedHours =
      Math.max(
        0,
        Math.min(Date.parse(dateRange.end), Date.now()) - Date.parse(dateRange.start),
      ) / 3600000;
    const perHour = new Map<number, number>();
    for (const recording of detections) {
      const hour = Math.floor(Date.parse(recording.observedAt) / 3600000);
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }
    let peakVisitation: Summary["peakVisitation"] = null;
    for (const [hour, count] of perHour)
      if (!peakVisitation || count > peakVisitation.count)
        peakVisitation = { count, start: new Date(hour * 3600000).toISOString() };
    const summary: Summary = {
      total: detections.length,
      averageFrequency: average(
        detections.map((recording) => recording.frequency),
      ),
      averageConfidence: average(
        detections.map((recording) => recording.confidence),
      ),
      previousTotal: previous,
      peakHour: peak.count ? peak.hour : null,
      visitationFrequency:
        elapsedHours > 0 ? detections.length / Math.max(1, elapsedHours) : 0,
      peakVisitation,
      hourly,
      daily,
      resolution,
      series,
      recent: await Promise.all(rows.slice(-5).reverse().map(detectionView)),
      devices: await devices(farm.farmId, deviceAccess(farm.role)),
      from: dateRange.from,
      to: dateRange.to,
    };
    res.json(summary);
  });
}
