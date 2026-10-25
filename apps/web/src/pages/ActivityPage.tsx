import { type Summary,formatDate,formatMeasurement } from "@beehave/shared";
import { useQuery } from "@tanstack/react-query";
import {
Activity,
CalendarDays,
ChevronRight,
Info,
Radio,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api,periodRange,queryString,useWorkspace } from "../api";
import { notCredential } from "../autofill";
import { DateInput } from "../components/DateInput";
import { type ChartMetric,chartMetrics,chartSeries,resolutionText } from "@beehave/shared/chart-series";
import {
Chart,
Failure,
Loading,
Metric,
PageHeading,
PanelTitle,
} from "../ui";

export function ActivityPage() {
  const { farm, device, refresh } = useWorkspace();
  const [metric, setMetric] = useState<ChartMetric>("count");
  const [days, setDays] = useState(7);
  const [custom, setCustom] = useState(periodRange(7));
  const range = days === 0 ? custom : periodRange(days);
  const query = useQuery({
    queryKey: ["activity", farm.id, device, range],
    queryFn: () =>
      api<Summary>(`/summary?${queryString({ ...range, device, farm: farm.id })}`),
    refetchInterval: refresh ? refresh * 1000 : false,
  });
  const summary = query.data;
  const chart = summary && chartSeries(summary, metric);
  return (
    <>
      <PageHeading
        eyebrow="PATTERNS OVER TIME"
        title="Activity & history"
        description="Explore daily patterns and the environmental context behind them."
        actions={
          <select
            {...notCredential}
            aria-label="Historical period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="0">Custom date range</option>
          </select>
        }
      />
      {days === 0 && (
        <div className="filters card">
          <DateInput
            label="From"
            value={custom.from}
            max={custom.to}
            onCommit={(from) => setCustom({ ...custom, from })}
          />
          <DateInput
            label="To"
            value={custom.to}
            min={custom.from}
            onCommit={(to) => setCustom({ ...custom, to })}
          />
        </div>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => query.refetch()} />
      ) : (
        summary && (
          <>
            <div className="metrics three">
              <Metric
                label="Detections in period"
                value={summary.total.toLocaleString()}
                foot={`${formatDate(summary.from)} – ${formatDate(summary.to)}`}
                icon={Radio}
              />
              <Metric
                label="Daily average"
                value={(
                  summary.total / Math.max(1, summary.daily.length)
                ).toFixed(1)}
                foot="Includes days with no synchronized detections"
                icon={CalendarDays}
              />
              <Metric
                label="Previous period"
                value={summary.previousTotal.toLocaleString()}
                foot="Equal-length preceding date range"
                icon={Activity}
              />
            </div>
            <section className="card">
              <PanelTitle
                title={`${chartMetrics[metric].title} over time`}
                subtitle={`Synchronized observations per ${resolutionText[chart!.resolution]} · gaps mean no data was received`}
                action={
                  <span className="legend">
                    <i />
                    {chartMetrics[metric].legend}
                  </span>
                }
              />
              <Chart
                values={chart!.values}
                metric={metric}
                onMetricChange={setMetric}
                labels={chart!.labels}
                periods={chart!.periods}
                tall
              />
            </section>
            <section className="card">
              <PanelTitle
                title="Daily summaries"
                subtitle="Select a date to inspect its individual detection records"
              />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Detections</th>
                      <th>Mean acoustic frequency</th>
                      <th>Temperature</th>
                      <th>Humidity</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...summary.daily].reverse().map((v) => (
                      <tr key={v.date}>
                        <td>
                          <Link
                            className="record-id"
                            to={`/detections?date=${v.date}`}
                          >
                            {formatDate(v.date)}
                          </Link>
                        </td>
                        <td>{v.count.toLocaleString()}</td>
                        <td>
                          {v.count ? `${v.frequency.toFixed(1)} Hz` : "—"}
                        </td>
                        <td>
                          {v.temperature === null
                            ? "—"
                            : `${formatMeasurement(v.temperature)} °C`}
                        </td>
                        <td>
                          {v.humidity === null
                            ? "—"
                            : `${formatMeasurement(v.humidity)} %`}
                        </td>
                        <td>
                          <Link
                            aria-label={`View detections for ${v.date}`}
                            to={`/detections?date=${v.date}`}
                          >
                            <ChevronRight size={17} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="insight-note">
              <Info size={16} />
              Environmental means use distinct readings associated with
              detections. Correlation does not establish causation;
              unsynchronized observations are not included.
            </div>
          </>
        )
      )}
    </>
  );
}
