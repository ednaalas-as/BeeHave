import { type Summary,ago,formatHourWindow,formatMeasurement,isOnline } from "@beehave/shared";
import { useQuery } from "@tanstack/react-query";
import {
Activity,
ArrowUpRight,
AudioLines,
ChevronRight,
Clock3,
Droplets,
Gauge,
Info,
Radio,
Thermometer,
TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api,periodRange,queryString,useWorkspace } from "../api";
import { type ChartMetric,chartMetrics,chartSeries,resolutionText } from "@beehave/shared/chart-series";
import {
Badge,
Chart,
DetectionTable,
Failure,
Loading,
Metric,
NoDevice,
PageHeading,
PanelTitle,
} from "../ui";

export function Dashboard() {
  const { farm, device, refresh } = useWorkspace();
  const [metric, setMetric] = useState<ChartMetric>("count");
  const [days, setDays] = useState(farm.demo ? 7 : 1);
  const range = periodRange(days);
  const query = useQuery({
    queryKey: ["summary", farm.id, device, range],
    queryFn: () =>
      api<Summary>(`/summary?${queryString({ ...range, device, farm: farm.id })}`),
    refetchInterval: refresh ? refresh * 1000 : false,
  });
  const summary = query.data;
  const latest =
    summary?.devices.find((v) => v.id === device) ?? summary?.devices[0];
  const reading = summary?.recent.find((e) => e.reading)?.reading;
  const chart = summary && chartSeries(summary, metric);
  return (
    <>
      <PageHeading
        eyebrow="MONITORING"
        title="Dashboard overview"
        description="Recent T. biroi detections and environmental readings."
        actions={
          <div className="segmented">
            {[
              [1, "Today"],
              [7, "Week"],
              [30, "Month"],
              [365, "Year"],
            ].map(([n, label]) => (
              <button
                key={n}
                className={days === n ? "active" : ""}
                onClick={() => setDays(Number(n))}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => query.refetch()} />
      ) : (
        summary && (
          <>
            {!summary.devices.length ? (
              <section className="card">
                <NoDevice />
              </section>
            ) : (
              <>
                <div className="metrics six">
                  <Metric
                    label="Total detections"
                    value={summary.total.toLocaleString()}
                    foot={
                      summary.previousTotal
                        ? `${summary.previousTotal.toLocaleString()} in the previous equal period`
                        : "No detections in the previous period"
                    }
                    icon={Radio}
                    tone="amber"
                  />
                  <Metric
                    label="Mean acoustic frequency"
                    value={
                      summary.total ? summary.averageFrequency.toFixed(1) : "—"
                    }
                    unit="Hz"
                    foot="Across classified acoustic events"
                    icon={AudioLines}
                  />
                  <Metric
                    label="Peak activity window"
                    value={summary.peakHour ? `${summary.peakHour}:00` : "—"}
                    foot={
                      summary.peakHour
                        ? `${summary.peakHour}:00 – ${String(Number(summary.peakHour) + 1).padStart(2, "0")}:00 · Philippine time`
                        : "Waiting for detection records"
                    }
                    icon={Clock3}
                  />
                  <Metric
                    label="Visitation frequency"
                    value={
                      summary.visitationFrequency == null
                        ? "—"
                        : summary.visitationFrequency.toFixed(1)
                    }
                    unit="/ hr"
                    foot="Mean T. biroi detections per elapsed hour"
                    icon={Gauge}
                    tone="amber"
                  />
                  <Metric
                    label="Peak visitation frequency"
                    value={
                      summary.peakVisitation
                        ? summary.peakVisitation.count.toLocaleString()
                        : "—"
                    }
                    unit="/ hr"
                    foot={
                      summary.peakVisitation
                        ? `Busiest hour · ${formatHourWindow(summary.peakVisitation.start, days > 1)} PHT`
                        : "Waiting for detection records"
                    }
                    icon={TrendingUp}
                  />
                  <Metric
                    label="Model confidence"
                    value={
                      summary.total
                        ? (summary.averageConfidence * 100).toFixed(1)
                        : "—"
                    }
                    unit="%"
                    foot="Mean score · not a measure of accuracy"
                    icon={Activity}
                    tone="green"
                  />
                </div>
                <section className="card chart-panel">
                  <PanelTitle
                    title={`${chartMetrics[metric].title} ${days === 1 ? "throughout the day" : "over time"}`}
                    subtitle={`Values per ${resolutionText[chart!.resolution]} · gaps mean no data was received`}
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
                  <div className="chart-foot">
                    <span>
                      <Clock3 size={14} /> All times in Asia/Manila
                    </span>
                    <Link to="/activity">
                      Explore activity <ArrowUpRight size={14} />
                    </Link>
                  </div>
                </section>
                {/* Environment and edge connection share one lane, side by side when there is room. */}
                <div className="dashboard-grid">
                  <section className="card field-panel">
                    <PanelTitle
                      title="In the field"
                      subtitle="Latest reported environment"
                    />
                    <div className="environment-value">
                      <span className="env-icon">
                        <Thermometer size={21} />
                      </span>
                      <div>
                        <span>Temperature</span>
                        <strong>
                          {reading?.temperature == null ? "—" : formatMeasurement(reading.temperature)}
                          <small> °C</small>
                        </strong>
                      </div>
                    </div>
                    <div className="environment-value">
                      <span className="env-icon">
                        <Droplets size={21} />
                      </span>
                      <div>
                        <span>Relative humidity</span>
                        <strong>
                          {reading?.humidity == null ? "—" : formatMeasurement(reading.humidity)}
                          <small> %</small>
                        </strong>
                      </div>
                    </div>
                    <div className="sensor-time">
                      {reading
                        ? `Sensor reading ${ago(reading.observedAt)}`
                        : "No associated sensor reading"}
                    </div>
                  </section>
                  <section className="card edge-panel">
                    <PanelTitle
                      title={
                        <>
                          <Radio size={18} /> Edge connection
                        </>
                      }
                      subtitle="Latest device synchronization"
                    />
                    <div className="field-device">
                      <Badge
                        tone={latest && isOnline(latest) ? "green" : "gray"}
                      >
                        {latest && isOnline(latest)
                          ? "Recent report"
                          : "Stale / unknown"}
                      </Badge>
                      <p>
                        {latest
                          ? `Last synchronized ${ago(latest.lastSync)}`
                          : "No device connected"}
                      </p>
                      <Link to="/devices">
                        View device health <ChevronRight size={15} />
                      </Link>
                    </div>
                  </section>
                </div>
                <section className="card">
                  <PanelTitle
                    title="Recent detections"
                    subtitle="The latest signals from your monitoring stations"
                    action={
                      <Link className="text-link" to="/detections">
                        View all records <ArrowUpRight size={15} />
                      </Link>
                    }
                  />
                  <DetectionTable items={summary.recent} compact />
                </section>
                <div className="insight-note">
                  <Info size={16} />
                  <span>
                    {farm.demo
                      ? "You are exploring generated sample records. Connect a device in your own farm to collect real observations."
                      : "Detection counts represent acoustic events, not unique bees or confirmed flower visits. Delayed synchronization can leave gaps."}
                  </span>
                </div>
              </>
            )}
          </>
        )
      )}
    </>
  );
}
