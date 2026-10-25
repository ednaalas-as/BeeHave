import { monitoringStatus, offlineControlsMessage, type Device } from "@beehave/shared";
import { CommandButton, MonitoringButton } from "./CommandButton";
import { DeviceManagement } from "./DeviceManagement";
import { HealthLabel } from "./HealthIcon";
import { SetupLabel } from "./SetupLabel";
import { useDeviceCommands } from "./useDeviceCommands";

/** Every device action in one place, shown at the top of Advanced Settings. The quick actions on
 * the device card are the same components reading the same command state, so the two can never
 * disagree. */
export function DeviceControls({
  device,
  canControl,
  changed,
}: {
  device: Device;
  canControl: boolean;
  changed: (deleted: boolean) => void;
}) {
  const { online, latest, errorFor, feedbackFor, result } = useDeviceCommands(device, canControl);
  const state = monitoringStatus(device, latest).current;
  const reachable = !device.disconnectedAt;
  return (
    <>
      <p className="caption muted">
        Every request is confirmed by the device before it is shown as done. A request the device does not receive in time expires and never runs.
      </p>
      {reachable && !online && <p className="feedback warning">{offlineControlsMessage}</p>}
      {reachable && (
        <>
          <section className="advanced-section">
            <h3><HealthLabel icons={["monitoring"]}>Monitoring</HealthLabel></h3>
            <span className="caption muted">
              Pausing stops audio recording, bee detection, and temperature and humidity readings. Monitoring resumes automatically when the device restarts.
            </span>
            <div className="button-row">
              <MonitoringButton device={device} canControl={canControl} />
              <CommandButton
                device={device}
                canControl={canControl}
                action="monitoring_restart"
                enabled={state === "active" || state === "error"}
                reason={state === "unknown" ? "Waiting for the device to report its monitoring state." : "Monitoring is not running."}
              />
            </div>
            {result(feedbackFor("monitoring"), "monitoring")}
            {errorFor("monitoring") && <p className="form-error" role="alert">{errorFor("monitoring")}</p>}
          </section>
          <section className="advanced-section">
            <h3><HealthLabel icons={["power"]}>Device</HealthLabel></h3>
            <span className="caption muted">
              Restarting interrupts monitoring briefly; it is complete only once the device reconnects. Shutting down stops monitoring until the device is powered on again.
            </span>
            <div className="button-row">
              <CommandButton device={device} canControl={canControl} action="reboot" />
              <CommandButton device={device} canControl={canControl} action="shutdown" className="warning" />
            </div>
            {result(feedbackFor("device"), "device")}
            {errorFor("device") && <p className="form-error" role="alert">{errorFor("device")}</p>}
          </section>
        </>
      )}
      {canControl && <SetupLabel device={device} />}
      <section className="advanced-section">
        <h3>Registration</h3>
        <span className="caption muted">
          Disconnecting removes this device from your BeeHave account. It does not change anything on the Pi.
        </span>
        <DeviceManagement device={device} changed={changed} />
      </section>
    </>
  );
}
