import type { ReactNode } from "react";
import {
  ago,
  deviceOverview,
  formatDate,
  formatTime,
  setupPageNote,
  type Device,
} from "@beehave/shared";
import { Radio } from "lucide-react";
import { Badge, PanelTitle } from "../ui";
import { HealthLabel, type HealthIconName } from "./HealthIcon";
import { CommandButton } from "./CommandButton";
import { MonitoringPanel, toneBadge } from "./MonitoringPanel";
import { useDeviceCommands } from "./useDeviceCommands";

export { toneBadge };

const itemIcons = (key: string, value: string): HealthIconName[] =>
  key === "microphone" ? ["microphone"]
  : key === "environment" ? ["temperature", "humidity"]
  : key === "connection" ? [value === "Online" ? "connection" : "offline"]
  : key === "storage" ? ["storage"]
  : key === "sync" ? ["sync"]
  : [];

const exact = (value: string | null) =>
  value ? `${formatDate(value)} · ${formatTime(value)} (Asia/Manila)` : undefined;

// Restart is the card's device-level quick action; the full set lives in Advanced Settings.
function QuickActions({ device }: { device: Device }) {
  const { online, disabledReason, errorFor, feedbackFor, result } = useDeviceCommands(device, true);
  return (
    <>
      <div className="button-row device-actions">
        <CommandButton device={device} canControl action="reboot" />
      </div>
      {result(feedbackFor("device"), "device")}
      {errorFor("device") && <p className="form-error" role="alert">{errorFor("device")}</p>}
      {!online && <p className="caption muted">{disabledReason}</p>}
    </>
  );
}

export function DeviceCard({
  device,
  headerAction,
  canControl = false,
}: {
  device: Device;
  // Whether the signed-in account may send requests to this device.
  canControl?: boolean;
  // Secondary controls shown under the status badge (Advanced Settings).
  headerAction?: ReactNode;
}) {
  const { overall, items } = deviceOverview(device);
  const setupNote = setupPageNote(device);
  return (
    <section className="card device-card">
      <PanelTitle
        title={
          <>
            {device.name}
            {device.access && (
              <span title={device.access === "administrator" ? "You administer this farm and can control this device" : "You can view this device"}>
                <Badge tone={device.access === "administrator" ? "blue" : "gray"}>
                  {device.access === "administrator" ? "Administrator" : "Viewer"}
                </Badge>
              </span>
            )}
          </>
        }
        subtitle={device.location}
        action={
          <div className="device-head">
            <Badge tone={toneBadge[overall.tone]}>{overall.value}</Badge>
            {headerAction}
          </div>
        }
      />
      <div className="device-body">
        <MonitoringPanel device={device} canControl={canControl} />
        <div className="status-list">
          {items.filter((item) => item.key !== "microphone" && item.key !== "environment").map((item) => (
            <div key={item.label}>
              <span>
                <HealthLabel icons={itemIcons(item.key, item.value)}>{item.label}</HealthLabel>
                {item.detail && <small>{item.detail}</small>}
              </span>
              <Badge tone={toneBadge[item.tone]}>{item.value}</Badge>
            </div>
          ))}
        </div>
        {setupNote && (
          <div className={`feedback ${setupNote.tone}`} role="status">
            <strong>{setupNote.title}</strong> <span title={exact(setupNote.at)}>· {ago(setupNote.at)}</span>
            <p>{setupNote.text}</p>
          </div>
        )}
        {canControl && !device.disconnectedAt && <QuickActions device={device} />}
        {device.disconnectedAt && (
          <p className="caption muted">Disconnected. History remains with this farm. Registration options are in Advanced Settings.</p>
        )}
        {/* Heartbeat and data sync are separate: a device can report status without sending data. */}
        <div className="device-timestamps">
          <span title={exact(device.lastSeen)}>
            <Radio size={12} /> Last update: <strong>{ago(device.lastSeen)}</strong>
          </span>
          <span title={exact(device.lastSync)}>
            Last data received:{" "}
            <strong>{device.lastSync ? ago(device.lastSync) : "Not yet received"}</strong>
          </span>
        </div>
      </div>
    </section>
  );
}
