import { ago, deviceOverview, healthReportedAt, monitoringStatus, type Device, type StatusTone } from "@beehave/shared";
import { Text, View } from "react-native";
import { useDeviceCommands } from "../hooks/useDeviceCommands";
import { styles } from "../styles";
import { CommandResult, MonitoringButton } from "./CommandControls";
import { Pair } from "./FormControls";
import { HealthIcons, HealthLabel, type HealthIconName } from "./HealthIcon";
import { StatusBadge, toneStyle } from "./Sheet";

// Distinct shapes per monitoring state, so the state does not rely on color alone.
const stateIcon: Record<string, HealthIconName> = { active: "monitoring", stopped: "stopped", error: "error", unknown: "unknown" };

/** The farmer-facing Monitoring section: verified state, the Pause/Resume quick action, and the
 * few details a farmer needs. Anything the device cannot currently confirm reads Unknown. */
export function MonitoringPanel({ device, canControl }: { device: Device; canControl: boolean }) {
  const { latest } = useDeviceCommands(device, canControl);
  const { monitoring, summary, items, fresh } = deviceOverview(device, latest);
  const state = monitoringStatus(device, latest).current;
  const h = device.health;
  const microphone = items.find((item) => item.key === "microphone")!;
  const environment = items.find((item) => item.key === "environment")!;
  const reportedAt = healthReportedAt(device);
  // A past moment, so it stays meaningful offline ("2 hr ago"); it never claims current activity.
  const lastActivity =
    h?.lastWindowAgeSeconds !== undefined && reportedAt
      ? ago(new Date(Date.parse(reportedAt) - h.lastWindowAgeSeconds * 1000).toISOString())
      : device.lastSync
        ? ago(device.lastSync)
        : "No monitoring data yet";
  const recording: [string, StatusTone] =
    state === "active" ? ["Running", "good"]
    : state === "stopped" ? ["Paused", "warning"]
    : state === "error" ? ["Not running", "bad"]
    : ["Unknown", "neutral"];
  const micLabel: Record<string, string> = { Working: "Detected", "Attention Needed": "Not detected" };
  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrowSmall}>Monitoring</Text>
      <View style={styles.healthLabel}>
        <HealthIcons icons={[stateIcon[state]]} />
        <Text style={styles.subtitle}>{summary}</Text>
      </View>
      {!!monitoring.detail && <Text style={[styles.caption, { color: toneStyle[monitoring.tone].color }]}>{monitoring.detail}</Text>}
      {canControl && !device.disconnectedAt && (
        <>
          <MonitoringButton device={device} canControl={canControl} />
          <CommandResult device={device} canControl={canControl} group="monitoring" />
        </>
      )}
      <View style={styles.statusRow}>
        <HealthLabel icons={["microphone"]}>Microphone</HealthLabel>
        <StatusBadge tone={microphone.tone}>{micLabel[microphone.value] ?? microphone.value}</StatusBadge>
      </View>
      <View style={styles.statusRow}>
        <HealthLabel icons={["temperature", "humidity"]}>Temperature & humidity</HealthLabel>
        <StatusBadge tone={environment.tone}>{environment.value}</StatusBadge>
      </View>
      <View style={styles.statusRow}>
        <HealthLabel icons={["monitoring"]}>Recording & bee detection</HealthLabel>
        <StatusBadge tone={recording[1]}>{recording[0]}</StatusBadge>
      </View>
      <Pair label="Last monitoring activity" value={lastActivity} />
      {!fresh && !device.disconnectedAt && !!(microphone.detail || environment.detail) && (
        <Text style={styles.caption}>{microphone.value === "Unknown" ? microphone.detail : environment.detail}</Text>
      )}
    </View>
  );
}
