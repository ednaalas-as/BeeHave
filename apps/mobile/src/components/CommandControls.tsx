import {
  commandGroup,
  commandPrompts,
  monitoringStatus,
  type CommandGroup,
  type Device,
  type DeviceCommandAction,
} from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { Alert, Text, View } from "react-native";
import { useDeviceCommands } from "../hooks/useDeviceCommands";
import { styles } from "../styles";
import { Button } from "./FormControls";
import { Feedback, toneStyle } from "./Sheet";

const icons: Record<DeviceCommandAction, keyof typeof Feather.glyphMap> = {
  reboot: "rotate-ccw",
  shutdown: "power",
  monitoring_restart: "rotate-ccw",
  monitoring_stop: "pause",
  monitoring_start: "play",
  network_scan: "wifi",
  wifi_connect: "wifi",
  wifi_disconnect: "wifi-off",
  wifi_forget: "trash-2",
  wifi_priority: "list",
};
const busyLabels: Record<DeviceCommandAction, string> = {
  reboot: "Restarting…",
  shutdown: "Shutting down…",
  monitoring_restart: "Restarting monitoring…",
  monitoring_stop: "Pausing…",
  monitoring_start: "Resuming…",
  network_scan: "Scanning…",
  wifi_connect: "Connecting…",
  wifi_disconnect: "Disconnecting…",
  wifi_forget: "Forgetting…",
  wifi_priority: "Saving…",
};

/** One device action with its confirmation. Every copy of an action reads the same shared
 * command store, so all copies disable and show progress together. */
export function CommandButton({
  device,
  canControl,
  action,
  enabled = true,
  warning = false,
  variant,
  confirm = true,
}: {
  device: Device;
  canControl: boolean;
  action: DeviceCommandAction;
  // Whether the device's verified state allows this action now.
  enabled?: boolean;
  warning?: boolean;
  variant?: "pause" | "resume";
  // Read-only requests (a Wi-Fi scan) run without a confirmation step.
  confirm?: boolean;
}) {
  const { activeAction, disabledReason, send } = useDeviceCommands(device, canControl);
  const working = activeAction === action;
  const blocked = !!disabledReason || !enabled;
  const press = () => {
    if (blocked) return;
    if (!confirm) return void send(action);
    Alert.alert(commandPrompts[action].title, commandPrompts[action].text, [
      { text: "Cancel", style: "cancel" },
      // Destructive styling only for power actions; pause and resume are not dangerous.
      { text: commandPrompts[action].confirm, style: action === "reboot" || action === "shutdown" ? "destructive" : "default", onPress: () => void send(action) },
    ]);
  };
  return (
    <Button
      title={working ? busyLabels[action] : commandPrompts[action].button}
      icon={icons[action]}
      busy={working}
      warning={warning}
      variant={variant}
      disabled={blocked}
      onPress={press}
    />
  );
}

/** The one stateful monitoring action: Pause while monitoring, Resume while paused or not
 * running, and nothing executable while the state is Unknown. */
export function MonitoringButton({ device, canControl }: { device: Device; canControl: boolean }) {
  const { latest, activeAction, online } = useDeviceCommands(device, canControl);
  const state = monitoringStatus(device, latest).current;
  const working = activeAction === "monitoring_stop" || activeAction === "monitoring_start";
  const action: DeviceCommandAction | null = working
    ? activeAction
    : state === "active"
      ? "monitoring_stop"
      : state === "stopped" || state === "error"
        ? "monitoring_start"
        : null;
  if (!action)
    return (
      <>
        <Button title="Monitoring status unknown" icon="help-circle" disabled onPress={() => {}} />
        <Text style={styles.caption}>
          {online ? "Waiting for the device to report its monitoring state." : "The device cannot currently be reached."}
        </Text>
      </>
    );
  return (
    <CommandButton
      key={action}
      device={device}
      canControl={canControl}
      action={action}
      variant={action === "monitoring_stop" ? "pause" : "resume"}
    />
  );
}

/** Progress or outcome for the requests of one group, plus a submission error. */
export function CommandResult({ device, canControl, group }: { device: Device; canControl: boolean; group: CommandGroup }) {
  const { sending, feedbackFor, errorFor, cancel, cancelling, cancelError } = useDeviceCommands(device, canControl);
  const shown = feedbackFor(group);
  const error = errorFor(group);
  return (
    <>
      {sending && commandGroup(sending) === group ? (
        <Feedback tone="neutral">Sending…</Feedback>
      ) : (
        shown && (
          <>
            <View style={[styles.feedback, toneStyle[shown.tone]]}>
              <Text accessibilityLiveRegion="polite" style={{ color: toneStyle[shown.tone].color, fontSize: 12, lineHeight: 18 }}>
                {shown.active && <Text style={{ fontWeight: "600" }}>{shown.step}  </Text>}
                {shown.text}
              </Text>
            </View>
            {shown.cancellable && canControl && (
              <Button title={cancelling ? "Cancelling…" : "Cancel request"} disabled={cancelling} onPress={() => void cancel()} />
            )}
          </>
        )
      )}
      {!!error && <Feedback tone="bad">{error}</Feedback>}
      {!!cancelError && <Feedback tone="bad">{cancelError}</Feedback>}
    </>
  );
}
