import { monitoringStatus, offlineControlsMessage, type Device } from "@beehave/shared";
import { Text } from "react-native";
import { useDeviceCommands } from "../hooks/useDeviceCommands";
import { styles } from "../styles";
import { CommandButton, CommandResult, MonitoringButton } from "./CommandControls";
import { DeviceManagement } from "./DeviceManagement";
import { HealthLabel } from "./HealthIcon";
import { SetupLabel } from "./SetupLabel";
import { Feedback } from "./Sheet";

/** Every device action in one place, shown at the top of Advanced settings. The card's quick
 * actions are the same components reading the same command store, so the two can never disagree. */
export function DeviceControls({
  device,
  canControl,
  changed,
}: {
  device: Device;
  canControl: boolean;
  changed: (deleted: boolean) => void;
}) {
  const { online, latest } = useDeviceCommands(device, canControl);
  const state = monitoringStatus(device, latest).current;
  const connected = !device.disconnectedAt;
  return (
    <>
      <Text style={styles.caption}>Each request is confirmed by the device before it is shown as done.</Text>
      {connected && !online && <Feedback tone="warning">{offlineControlsMessage}</Feedback>}
      {connected && (
        <>
          <HealthLabel icons={["monitoring"]} style={styles.sectionTitle}>Monitoring</HealthLabel>
          <Text style={styles.caption}>
            Pausing stops audio recording, bee detection, and temperature and humidity readings. Monitoring resumes automatically when the device restarts.
          </Text>
          <MonitoringButton device={device} canControl={canControl} />
          <CommandButton
            device={device}
            canControl={canControl}
            action="monitoring_restart"
            enabled={state === "active" || state === "error"}
          />
          <CommandResult device={device} canControl={canControl} group="monitoring" />

          <HealthLabel icons={["power"]} style={styles.sectionTitle}>Device</HealthLabel>
          <Text style={styles.caption}>
            Restarting interrupts monitoring briefly; it is complete only once the device reconnects. Shutting down stops monitoring until the device is powered on again. A request the device does not receive in time expires and never runs.
          </Text>
          <CommandButton device={device} canControl={canControl} action="reboot" />
          <CommandButton device={device} canControl={canControl} action="shutdown" warning />
          <CommandResult device={device} canControl={canControl} group="device" />
        </>
      )}
      {canControl && <SetupLabel device={device} />}
      <Text style={styles.sectionTitle}>Registration</Text>
      <Text style={styles.caption}>
        Disconnecting removes this device from your BeeHave account. It does not change anything on the Pi.
      </Text>
      <DeviceManagement device={device} changed={changed} />
    </>
  );
}
