import assert from "node:assert/strict";
import test from "node:test";
import { buildSeries, seriesResolution } from "./services/series";

const day = (date: string) => Date.parse(`${date}T00:00:00+08:00`);

test("resolution widens with the selected range", () => {
  assert.equal(seriesResolution(1), "hour");
  assert.equal(seriesResolution(2), "3hour");
  assert.equal(seriesResolution(7), "day");
  assert.equal(seriesResolution(30), "day");
  assert.equal(seriesResolution(90), "week");
  assert.equal(seriesResolution(365), "month");
  assert.equal(seriesResolution(400), "month");
});

test("buckets follow Manila days, Monday weeks and calendar months", () => {
  const empty = { bees: [], otherActivity: [], readings: [] };
  const hourly = buildSeries({ start: day("2026-10-21"), end: day("2026-10-22"), resolution: "hour", ...empty });
  assert.equal(hourly.length, 24);
  const daily = buildSeries({ start: day("2026-09-22"), end: day("2026-10-22"), resolution: "day", ...empty });
  assert.equal(daily.length, 30);
  // 2026-10-21 is a Wednesday: the first week is partial and ends at Monday 2026-10-26.
  const weekly = buildSeries({ start: day("2026-10-21"), end: day("2026-11-10"), resolution: "week", ...empty });
  assert.deepEqual(weekly.map((p) => p.end), [day("2026-10-26"), day("2026-11-02"), day("2026-11-09"), day("2026-11-10")].map((t) => new Date(t).toISOString()));
  const monthly = buildSeries({ start: day("2025-11-15"), end: day("2026-02-01"), resolution: "month", ...empty });
  assert.deepEqual(monthly.map((p) => p.start), [day("2025-11-15"), day("2025-12-01"), day("2026-01-01")].map((t) => new Date(t).toISOString()));
  assert.equal(monthly.length, 3);
});

test("counts sum, readings average, and missing buckets stay missing", () => {
  const start = day("2026-10-20");
  const [first, second, third] = buildSeries({
    start,
    end: day("2026-10-23"),
    resolution: "day",
    bees: [
      { at: start + 3600000, frequency: 200 },
      { at: start + 7200000, frequency: 210 },
    ],
    otherActivity: [day("2026-10-21") + 60000],
    readings: [
      { at: start + 60000, temperature: 30, humidity: 70 },
      { at: start + 120000, temperature: 32, humidity: null },
    ],
  });
  assert.deepEqual([first.count, first.frequency, first.temperature, first.humidity], [2, 205, 31, 70]);
  // A Non-Bee window proves the device was running: zero Bee detections is real.
  assert.deepEqual([second.count, second.frequency, second.temperature], [0, null, null]);
  // Nothing at all was received: the bucket is a gap, not zero.
  assert.deepEqual([third.count, third.temperature, third.humidity], [null, null, null]);
});
