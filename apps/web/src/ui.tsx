import {
  classificationLabel,
  formatDate,
  formatMeasurement,
  formatTime,
  type Detection,
} from "@beehave/shared";
import {
  chartMetricOrder,
  chartMetrics,
  chartScale,
  formatChartValue,
  type ChartMetric,
} from "@beehave/shared/chart-series";
import {
  Activity,
  ArrowRight,
  AudioLines,
  Inbox,
  RefreshCw,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { notCredential } from "./autofill";

// The detection opened in the modal is kept in the URL, so it survives reloads and Back closes it.
export const detailParams = { device: "detectionDevice", id: "detection" } as const;
/** Link target that opens a detection's modal over the current page, keeping its filters. */
export function useDetectionLink() {
  const location = useLocation();
  return (deviceId: string, id: string) => {
    const search = new URLSearchParams(location.search);
    search.set(detailParams.device, deviceId);
    search.set(detailParams.id, id);
    return { pathname: location.pathname, search: `?${search}` };
  };
}
export function Badge({
  children,
  tone = "green",
}: {
  children: ReactNode;
  tone?: "green" | "amber" | "blue" | "gray" | "red";
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function Empty({
  title = "No detections in this period",
  text = "Records will appear when your edge device synchronizes.",
  action,
}: {
  title?: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Inbox size={32} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <RefreshCw className="spin" size={20} /> Loading monitoring data…
    </div>
  );
}
export function Failure({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <TriangleAlert size={22} />
      <div>
        <strong>We couldn’t load this information</strong>
        <p>{error?.message ?? "Check your connection and try again."}</p>
      </div>
      <button onClick={retry}>Try again</button>
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
export function Metric({
  label,
  value,
  unit,
  foot,
  icon: Icon,
  tone = "blue",
}: {
  label: string;
  value: string;
  unit?: string;
  foot: string;
  icon: LucideIcon;
  tone?: string;
}) {
  return (
    <div className="metric card">
      <div className="metric-top">
        <span>{label}</span>
        <span className={`metric-icon ${tone}`}>
          <Icon size={18} />
        </span>
      </div>
      <div className="metric-value">
        {value}
        <span>{unit}</span>
      </div>
      <div className="metric-foot">{foot}</div>
    </div>
  );
}
export function Chart({
  values,
  labels,
  tall = false,
  metric = "count",
  onMetricChange,
  periods,
}: {
  values: (number | null)[];
  labels: string[];
  // Full description of the period each point covers, shown in its tooltip.
  periods?: string[];
  tall?: boolean;
  metric?: ChartMetric;
  onMetricChange?: (metric: ChartMetric) => void;
}) {
  const radioName = useId();
  const frame = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(800);
  const [axisFontSize, setAxisFontSize] = useState(12);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setWidth(
        element.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      );
      setAxisFontSize(parseFloat(style.fontSize));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const preferenceObserver = new MutationObserver(measure);
    preferenceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    measure();
    return () => {
      observer.disconnect();
      preferenceObserver.disconnect();
    };
  }, []);
  const { unit, description, axis, short } = chartMetrics[metric];
  const shown = (value: number) => formatChartValue(value, metric);
  // Each series gets its own fitted axis, so Hz, °C, % and counts all stay readable.
  const { floor, ceiling, ticks } = chartScale(values, metric);
  // Reserve space for the full labels at the user's selected reading size.
  // A conservative character width covers digits, signs and date separators.
  const tickWidth =
    Math.max(...ticks.map((value) => String(value).length)) *
    axisFontSize *
    0.75;
  const dateWidth =
    Math.max(1, ...labels.map((label) => label.length)) * axisFontSize * 0.75;
  const left = Math.max(tickWidth + 20, dateWidth / 2 + 8);
  const right = dateWidth / 2 + 8;
  // Room above the plot for the y-axis label.
  const top = axisFontSize * 2 + 14;
  const bottom = axisFontSize * 2 + 12;
  // Match the rendered width so wide cards do not magnify the SVG text.
  const w = Math.max(left + right + 1, width),
    h = Math.max(tall ? 250 : 200, top + bottom + axisFontSize * 8);
  const plotWidth = w - left - right;
  const baseline = h - bottom;
  const x = (i: number) =>
    left + (i * plotWidth) / Math.max(1, values.length - 1);
  const y = (v: number) =>
    baseline - ((v - floor) / (ceiling - floor)) * (baseline - top);
  // Empty labels are intentional blanks; thin out only the labels that exist.
  const labelled = labels.flatMap((label, i) => (label ? [i] : []));
  const labelStep = Math.max(
    1,
    Math.ceil(
      labelled.length /
        Math.max(1, Math.min(9, Math.floor(plotWidth / (dateWidth + 16)))),
    ),
  );
  const shownLabels = new Set(labelled.filter((_, k) => k % labelStep === 0));
  const period = (i: number) => periods?.[i] ?? labels[i];
  const slot = plotWidth / Math.max(1, values.length - 1);
  const segments: { index: number; value: number }[][] = [];
  values.forEach((value, index) => {
    if (value === null) return;
    if (index === 0 || values[index - 1] === null) segments.push([]);
    segments[segments.length - 1].push({ index, value });
  });
  return (
    <div className="chart" ref={frame}>
      <div className="chart-plot" onMouseLeave={() => setActive(null)}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`${description}: ${labels.map((_, i) => `${period(i)}: ${values[i] === null ? "No data" : shown(values[i] as number)}`).join(", ")}`}
      >
        <defs>
          <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--blue)" stopOpacity=".15" />
            <stop offset="100%" stopColor="var(--blue)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <text className="chart-axis-label" x={0} y={axisFontSize} textAnchor="start">
          {axis}
        </text>
        {ticks.map((value, i) => {
          return (
            <g key={i}>
              <line
                x1={left}
                x2={w - right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--border)"
                strokeDasharray="3 5"
              />
              <text
                x={left - 12}
                y={y(value)}
                dominantBaseline="middle"
                textAnchor="end"
              >
                {value}
              </text>
            </g>
          );
        })}
        {segments.map((segment) => {
          const points = segment
            .map(({ index, value }) => `${x(index)},${y(value)}`)
            .join(" ");
          return (
            <g key={segment[0].index}>
              <polygon
                points={`${x(segment[0].index)},${baseline} ${points} ${x(segment[segment.length - 1].index)},${baseline}`}
                fill="url(#area)"
              />
              <polyline
                points={points}
                fill="none"
                stroke="var(--blue)"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
              {segment.map(({ value, index }) => (
                <circle
                  key={index}
                  cx={x(index)}
                  cy={y(value)}
                  r="3"
                  fill="var(--white)"
                  stroke="var(--blue)"
                  strokeWidth="2"
                >
                  <title>{`${period(index)} · ${short}: ${shown(value)} ${unit}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {active !== null && (
          <line
            x1={x(active)}
            x2={x(active)}
            y1={top}
            y2={baseline}
            stroke="var(--blue)"
            strokeOpacity=".35"
          />
        )}
        {active !== null && values[active] !== null && (
          <circle
            cx={x(active)}
            cy={y(values[active] as number)}
            r="5"
            fill="var(--blue)"
            stroke="var(--white)"
            strokeWidth="2"
          />
        )}
        {values.map((_, i) => (
          <rect
            key={i}
            x={x(i) - slot / 2}
            y={top}
            width={slot}
            height={baseline - top}
            fill="transparent"
            onMouseEnter={() => setActive(i)}
            onClick={() => setActive(i)}
          />
        ))}
        {labels.map((label, i) =>
          shownLabels.has(i) ? (
            <text
              key={i}
              x={x(i)}
              y={baseline + axisFontSize + 12}
              textAnchor="middle"
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>
      {active !== null && (
        <div
          className="chart-tooltip"
          role="status"
          style={{
            left: `${(x(active) / w) * 100}%`,
            transform: `translateX(${x(active) / w < 0.2 ? "0" : x(active) / w > 0.8 ? "-100%" : "-50%"})`,
          }}
        >
          <span>{period(active)}</span>
          <span>{short}</span>
          <strong>
            {values[active] === null
              ? "No data received"
              : `${shown(values[active] as number)} ${unit}`}
          </strong>
        </div>
      )}
      </div>
      {onMetricChange && (
        <div
          role="radiogroup"
          aria-label="Graph measurement"
          className="chart-metrics"
        >
          {chartMetricOrder.map((value) => (
            <label key={value}>
              <input
                {...notCredential}
                type="radio"
                name={radioName}
                checked={metric === value}
                onChange={() => onMetricChange(value)}
              />
              {chartMetrics[value].label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
export function DetectionTable({
  items,
  compact = false,
}: {
  items: Detection[];
  compact?: boolean;
}) {
  const detailLink = useDetectionLink();
  if (!items.length) return <Empty />;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Detection / time</th>
            <th>Classification</th>
            <th>Acoustic frequency</th>
            <th>Confidence</th>
            {!compact && <th>Environment</th>}
            <th>Recording</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((detection) => (
            <tr key={`${detection.deviceId}/${detection.id}`}>
              <td>
                <Link
                  className="record-id"
                  to={detailLink(detection.deviceId, detection.id)}
                >
                  #{detection.id.replace("sample-", "").slice(0, 14)}
                </Link>
                <small>
                  {formatDate(detection.observedAt)} ·{" "}
                  {formatTime(detection.observedAt)}
                </small>
              </td>
              <td>
                <span className="species">
                  <span className="species-dot" />
                  {classificationLabel(detection.species)}
                </span>
              </td>
              <td className="mono">
                {detection.frequency.toFixed(1)}{" "}
                <span className="muted">Hz</span>
              </td>
              <td>
                <span className="confidence">
                  <span style={{ width: `${detection.confidence * 100}%` }} />
                </span>
                <span className="mono">
                  {(detection.confidence * 100).toFixed(0)}%
                </span>
              </td>
              {!compact && (
                <td>
                  {detection.reading ? (
                    <>
                      {detection.reading.temperature == null
                        ? "—"
                        : formatMeasurement(detection.reading.temperature)}
                      °C ·{" "}
                      {detection.reading.humidity == null
                        ? "—"
                        : formatMeasurement(detection.reading.humidity)}
                      %
                      <small>
                        Sensor {formatTime(detection.reading.observedAt)}
                      </small>
                    </>
                  ) : (
                    <span className="muted">Unavailable</span>
                  )}
                </td>
              )}
              <td>
                {detection.recording ? (
                  <Link
                    className="audio-link"
                    to={
                      // Listen opens the detection's own 3-second clip when its window is known.
                      detection.audioWindow &&
                      detection.recording.status === "available"
                        ? detailLink(detection.deviceId, detection.id)
                        : `/recordings/${detection.deviceId}/${detection.recording.id}`
                    }
                  >
                    <AudioLines size={16} />
                    {detection.recording.status === "available"
                      ? "Listen"
                      : "Pending"}
                  </Link>
                ) : (
                  <span className="muted">No audio</span>
                )}
              </td>
              <td>
                <Link
                  className="icon-button"
                  aria-label={`View detection ${detection.id}`}
                  to={detailLink(detection.deviceId, detection.id)}
                >
                  <ArrowRight size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function PanelTitle({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function Pagination({
  page,
  pages,
  total,
  onChange,
  pageSize,
  onPageSizeChange,
}: {
  page: number;
  pages: number;
  total: number;
  onChange: (p: number) => void;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total.toLocaleString()} records · Page {page} of {pages}
      </span>
      {pageSize !== undefined && onPageSizeChange && (
        <label className="pagination-size">
          Detections per page
          <select
            {...notCredential}
            aria-label="Detections per page"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {[10, 20, 50, 100].map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
      )}
      <div>
        <button disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Previous
        </button>
        <button disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
export function DetailShell({
  title,
  back,
  children,
}: {
  title: ReactNode;
  back: string;
  children: ReactNode;
}) {
  return (
    <section className="card detail">
      <div className="panel-title">
        <h2>{title}</h2>
        <Link className="icon-button" aria-label="Close details" to={back}>
          <X size={20} />
        </Link>
      </div>
      {children}
    </section>
  );
}
export function NoDevice() {
  return (
    <Empty
      title="Your farm is ready to connect"
      text="Register your Raspberry Pi in Edge Device, then send the first monitoring batch."
      action={
        <Link className="button primary" to="/devices">
          <Activity size={16} /> Connect an edge device
        </Link>
      }
    />
  );
}
