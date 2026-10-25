import {
  commandPrompts,
  monitoringStatus,
  type Device,
  type DeviceCommandAction,
} from "@beehave/shared";
import { ArrowUpDown, CircleHelp, LoaderCircle, Pause, Play, Power, RotateCcw, Trash2, Unlink, Wifi } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./Modal";
import { useDeviceCommands } from "./useDeviceCommands";

const icons: Record<DeviceCommandAction, ReactNode> = {
  reboot: <RotateCcw size={16} aria-hidden="true" />,
  shutdown: <Power size={16} aria-hidden="true" />,
  monitoring_restart: <RotateCcw size={16} aria-hidden="true" />,
  monitoring_stop: <Pause size={16} aria-hidden="true" />,
  monitoring_start: <Play size={16} aria-hidden="true" />,
  network_scan: <Wifi size={16} aria-hidden="true" />,
  wifi_connect: <Wifi size={16} aria-hidden="true" />,
  wifi_disconnect: <Unlink size={16} aria-hidden="true" />,
  wifi_forget: <Trash2 size={16} aria-hidden="true" />,
  wifi_priority: <ArrowUpDown size={16} aria-hidden="true" />,
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

/** One device action with its confirmation. Every copy of an action (quick action, Device
 * Controls) reads the same shared command state, so they disable and show progress together. */
export function CommandButton({
  device,
  canControl,
  action,
  enabled = true,
  reason = "",
  className,
  confirmClass,
  confirm = true,
}: {
  device: Device;
  canControl: boolean;
  action: DeviceCommandAction;
  // Whether the device's verified state allows this action now.
  enabled?: boolean;
  reason?: string;
  className?: string;
  confirmClass?: string;
  // Read-only requests (e.g. a Wi-Fi scan) run without a confirmation step.
  confirm?: boolean;
}) {
  const { activeAction, sending, disabledReason, send } = useDeviceCommands(device, canControl);
  // Tied to the action it was opened for, so a confirmation never carries over to another action.
  const [confirming, setConfirming] = useState<DeviceCommandAction | null>(null);
  const working = activeAction === action;
  const blocked = !!disabledReason || !enabled;
  useEffect(() => {
    if (blocked) setConfirming(null);
  }, [blocked]);
  return (
    <>
      <button
        className={className}
        disabled={blocked}
        aria-busy={working}
        title={disabledReason || (enabled ? "" : reason)}
        onClick={() => {
          if (blocked || sending) return;
          if (confirm) setConfirming(action);
          else void send(action);
        }}
      >
        {working ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : icons[action]}
        {working ? busyLabels[action] : commandPrompts[action].button}
      </button>
      {/* A confirmation whose action is no longer allowed is dropped, never sent. */}
      {confirming === action && !blocked && (
        <ConfirmDialog
          title={commandPrompts[action].title}
          text={commandPrompts[action].text}
          confirmLabel={commandPrompts[action].confirm}
          confirmClass={confirmClass}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void send(action);
          }}
        />
      )}
    </>
  );
}

/** The one stateful monitoring action: Pause while monitoring, Resume while paused or not
 * running, and nothing executable while the state is Unknown. */
export function MonitoringButton({ device, canControl }: { device: Device; canControl: boolean }) {
  const { latest, activeAction, online } = useDeviceCommands(device, canControl);
  const state = monitoringStatus(device, latest).current;
  const working = activeAction === "monitoring_stop" || activeAction === "monitoring_start";
  // While a pause or resume runs, keep showing that action's progress.
  const action: DeviceCommandAction | null = working
    ? activeAction
    : state === "active"
      ? "monitoring_stop"
      : state === "stopped" || state === "error"
        ? "monitoring_start"
        : null;
  if (!action)
    return (
      <button
        className="monitoring-button"
        disabled
        title={online ? "Waiting for the device to report its monitoring state." : "The device cannot currently be reached."}
      >
        <CircleHelp size={16} aria-hidden="true" /> Monitoring status unknown
      </button>
    );
  const tone = action === "monitoring_stop" ? "pause" : "resume";
  return (
    <CommandButton
      key={action}
      device={device}
      canControl={canControl}
      action={action}
      className={`monitoring-button ${working ? "" : tone}`.trim()}
      confirmClass={`monitoring-button ${tone}`}
    />
  );
}
