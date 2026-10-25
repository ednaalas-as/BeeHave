import {
  ago,
  formatDate,
  formatTime,
  type Device,
  formatUptime,
  healthFresh,
  healthReportedAt,
  monitoringStateLabels,
  monitoringStatus,
} from "@beehave/shared";
import type { ReactNode } from "react";
import { DeviceControls } from "./DeviceControls";
import { HealthLabel, type HealthIconName } from "./HealthIcon";
import { liveValue, NOT_REPORTED } from "./live";
import { Modal } from "./Modal";
import { NetworkConfiguration } from "./NetworkConfiguration";
import { useDeviceCommands } from "./useDeviceCommands";


function Details({ rows }: { rows: ([string, ReactNode] | [string, ReactNode, HealthIconName[]])[] }) {
  return (
    <dl className="device-details">
      {rows.map(([label, value, icons]) => (
        <div key={label}>
          <dt>{icons ? <HealthLabel icons={icons}>{label}</HealthLabel> : label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Device controls first, then network, diagnostics and system health. Restart is also a quick
 * action on the device card. */
export function AdvancedSettings({
  device,
  canControl,
  changed,
  onClose,
}: {
  device: Device;
  canControl: boolean;
  changed: (deleted: boolean) => void;
  onClose: () => void;
}) {
  const h = device.health;
  const { online, latest, feedback } = useDeviceCommands(device, canControl);
  const monitoringNow = monitoringStatus(device, latest);
  const state = monitoringNow.current;
  const fresh = healthFresh(device);
  const reportedAt = healthReportedAt(device);
  const live = liveValue(device);

  return (
    <Modal
      wide
      title={`${device.name} · Advanced settings`}
      description={
        fresh
          ? "Device controls, plus technical details for troubleshooting from the device’s latest report."
          : "The device cannot currently confirm its state, so its live values show as Unknown. Last reported values are shown for reference."
      }
      onClose={onClose}
      footer={<button onClick={onClose}>Close</button>}
    >
      <DeviceControls device={device} canControl={canControl} changed={changed} />
      <NetworkConfiguration device={device} canControl={canControl} />
      <section className="advanced-section">
        <h3><HealthLabel icons={["monitoring"]}>Monitoring diagnostics</HealthLabel></h3>
        <span className="caption muted">
          Pause, resume and restart monitoring with the controls above. These are the service details behind it.
        </span>
        <Details
          rows={[
            ["Current state", monitoringStateLabels[state]],
            ...(state === "unknown" && monitoringNow.lastReported && monitoringNow.reportedAt
              ? [["Last reported", `${monitoringStateLabels[monitoringNow.lastReported]} · ${ago(monitoringNow.reportedAt).toLowerCase()}`] as [string, string]]
              : []),
            ["Service state", live(h?.monitoringService ? <span className="mono">{h.monitoringService}</span> : h ? (h.collecting ? "Running" : "Stopped") : undefined), ["monitoring"]],
            ["Microphone", live(h ? h.audioStatusDetail || (h.microphone ? "Connected" : "Unavailable") : undefined), ["microphone"]],
            ["Temperature & humidity sensor", live(h ? h.sensorStatusDetail || (h.sensor ? "Connected" : "Unavailable") : undefined), ["temperature", "humidity"]],
            ["Newest monitoring window", live(h?.lastWindowAgeSeconds !== undefined ? `${Math.round(h.lastWindowAgeSeconds)} s old` : undefined)],
            ["Reported problems", live(h?.errors ? (h.errors.length ? h.errors.join("; ") : "None") : undefined)],
            ["Last health report", reportedAt ? ago(reportedAt) : "Never"],
            ["Last remote request", latest ? `${feedback!.text} (${ago(latest.updatedAt).toLowerCase()})` : "None"],
          ]}
        />
      </section>
      <section className="advanced-section">
        <h3>System health</h3>
        {h ? (
          <Details
            rows={[
              ["CPU usage", live(`${h.cpu.toFixed(0)}%`), ["cpu"]],
              ["Memory usage", live(`${h.ram.toFixed(0)}%`), ["memory"]],
              ["CPU temperature", live(`${h.cpuTemperature.toFixed(1)} °C`), ["temperature"]],
              ["Storage used", live(`${h.storageUsed.toFixed(1)} of ${h.storageTotal} GB`), ["storage"]],
              ["Storage free", live(`${(h.storageTotal - h.storageUsed).toFixed(1)} GB`), ["storage"]],
            ]}
          />
        ) : (
          <p className="caption">The device has not reported system health yet.</p>
        )}
      </section>
      <section className="advanced-section">
        <h3>Data & sync</h3>
        <Details
          rows={[
            ["Records waiting to sync", h?.uploader === "not installed" ? "Not tracked (uploader not installed)" : live(h ? String(h.queued) : undefined)],
            ["Last successful sync", device.lastSync ? `${formatDate(device.lastSync)} · ${formatTime(device.lastSync)}` : "Not yet synchronized", ["sync"]],
            ["Upload status", h?.uploader === "not installed" ? "Data upload not set up" : !device.lastSync ? "No uploads yet" : !online ? "Paused while offline" : h?.queued ? "Waiting to upload" : "Up to date", ["sync"]],
          ]}
        />
      </section>
      <section className="advanced-section">
        <h3>Device information</h3>
        <Details
          rows={[
            ["Device ID", <span className="mono">{device.id}</span>],
            ["Device hostname", h?.hostname || NOT_REPORTED],
            ["Model", device.model || NOT_REPORTED],
            ["Software version", h?.softwareVersion || NOT_REPORTED],
            ["Uptime", live(h?.uptimeSeconds !== undefined ? formatUptime(h.uptimeSeconds) : undefined)],
            ["Installation label", device.location],
          ]}
        />
      </section>
    </Modal>
  );
}
