import {
  ago,
  deviceOverview,
  healthReportedAt,
  monitoringStatus,
  type Device,
  type StatusTone,
} from "@beehave/shared";
import { Activity, CircleHelp, CirclePause, TriangleAlert } from "lucide-react";
import { Badge } from "../ui";
import { MonitoringButton } from "./CommandButton";
import { HealthLabel } from "./HealthIcon";
import { useDeviceCommands } from "./useDeviceCommands";

export const toneBadge: Record<StatusTone, "green" | "amber" | "red" | "gray"> = {
  good: "green",
  warning: "amber",
  bad: "red",
  neutral: "gray",
};

// Distinct shapes per monitoring state, so the state does not rely on color alone.
const stateIcon = { active: Activity, stopped: CirclePause, error: TriangleAlert, unknown: CircleHelp } as const;

/** The farmer-facing Monitoring section: verified state, the Pause/Resume quick action, and the
 * few details a farmer needs. Anything the device cannot currently confirm reads Unknown.
 * Service internals live in Advanced Settings. */
export function MonitoringPanel({ device, canControl }: { device: Device; canControl: boolean }) {
  const { latest, errorFor, feedbackFor, result } = useDeviceCommands(device, canControl);
  // The state changes only when the device confirms it (health report or verified result).
  const { monitoring, summary, items, fresh } = deviceOverview(device, latest);
  const state = monitoringStatus(device, latest).current;
  const Icon = stateIcon[state];
  const h = device.health;
  const microphone = items.find((item) => item.key === "microphone")!;
  const environment = items.find((item) => item.key === "environment")!;
  const reportedAt = healthReportedAt(device);
  // A past moment, so it stays meaningful offline ("2 h ago"); it never claims current activity.
  const lastActivity =
    h?.lastWindowAgeSeconds !== undefined && reportedAt
      ? ago(new Date(Date.parse(reportedAt) - h.lastWindowAgeSeconds * 1000).toISOString())
      : device.lastSync
        ? ago(device.lastSync)
        : "No monitoring data yet";
  const recording: [string, StatusTone] =
    state === "active"
      ? ["Running", "good"]
      : state === "stopped"
        ? ["Paused", "warning"]
        : state === "error"
          ? ["Not running", "bad"]
          : ["Unknown", "neutral"];
  const micLabel: Record<string, string> = { Working: "Detected", "Attention Needed": "Not detected" };

  return (
    <section className="monitoring-panel" aria-labelledby={`monitoring-${device.id}`}>
      <header>
        <div className="monitoring-state">
          <Icon size={20} aria-hidden="true" />
          <div>
            <h3 id={`monitoring-${device.id}`} className="section-label">Monitoring</h3>
            <strong>{summary}</strong>
            <p>{monitoring.detail}</p>
          </div>
        </div>
        {canControl && !device.disconnectedAt && <MonitoringButton device={device} canControl={canControl} />}
      </header>
      <dl className="monitoring-details">
        <div>
          <dt><HealthLabel icons={["microphone"]}>Microphone</HealthLabel></dt>
          <dd>
            <Badge tone={toneBadge[microphone.tone]}>{micLabel[microphone.value] ?? microphone.value}</Badge>
          </dd>
        </div>
        <div>
          <dt><HealthLabel icons={["temperature", "humidity"]}>Temperature & humidity</HealthLabel></dt>
          <dd><Badge tone={toneBadge[environment.tone]}>{environment.value}</Badge></dd>
        </div>
        <div>
          <dt><HealthLabel icons={["monitoring"]}>Recording & bee detection</HealthLabel></dt>
          <dd><Badge tone={toneBadge[recording[1]]}>{recording[0]}</Badge></dd>
        </div>
        <div>
          <dt>Last monitoring activity</dt>
          <dd>{lastActivity}</dd>
        </div>
      </dl>
      {!fresh && !device.disconnectedAt && (microphone.detail || environment.detail) && (
        <p className="caption muted">{microphone.value === "Unknown" ? microphone.detail : environment.detail}</p>
      )}
      {canControl && !device.disconnectedAt && result(feedbackFor("monitoring"), "monitoring")}
      {canControl && errorFor("monitoring") && <p className="form-error" role="alert">{errorFor("monitoring")}</p>}
    </section>
  );
}
