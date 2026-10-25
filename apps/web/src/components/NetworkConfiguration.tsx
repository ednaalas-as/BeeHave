import {
  ago,
  commandPrompts,
  isSavedNetworkAction,
  formatDate,
  formatTime,
  healthFresh,
  healthReportedAt,
  internetLabels,
  isWifiScan,
  networkMethodLabels as methodLabels,
  setupPageNote,
  signalLabel,
  type Device,
  type SavedNetwork,
  type SavedNetworkAction,
} from "@beehave/shared";
import { Lock, LockOpen, Plus, Trash2, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../ui";
import { notCredential } from "../autofill";
import { CommandButton } from "./CommandButton";
import { HealthLabel } from "./HealthIcon";
import { liveValue, NOT_REPORTED } from "./live";
import { ConfirmDialog } from "./Modal";
import { requestId, useDeviceCommands } from "./useDeviceCommands";
import { WifiConnectSheet, type WifiChoice } from "./WifiConnectSheet";

// A change to one saved network, waiting for the farmer's confirmation.
type NetworkChange = { action: SavedNetworkAction; network: SavedNetwork; priority?: number };

/** Priority, Disconnect and Forget for one saved network. Nothing changes until confirmed. */
function SavedNetworkActions({
  network,
  disabledReason,
  onChange,
}: {
  network: SavedNetwork;
  disabledReason: string;
  onChange: (change: NetworkChange) => void;
}) {
  const [priority, setPriority] = useState(String(network.priority));
  // The device's report is the truth: follow it once a change lands.
  useEffect(() => setPriority(String(network.priority)), [network.priority]);
  const value = Number(priority);
  const valid = priority.trim() !== "" && Number.isInteger(value) && value >= 0 && value <= 100;
  const blocked = !!disabledReason;
  return (
    <div className="network-actions">
      <label className="network-priority">
        Priority
        <input
          {...notCredential}
          type="number"
          min={0}
          max={100}
          step={1}
          inputMode="numeric"
          value={priority}
          disabled={blocked}
          aria-label={`Priority for ${network.ssid}`}
          onChange={(event) => setPriority(event.target.value)}
        />
      </label>
      <button
        className="small-button"
        disabled={blocked || !valid || value === network.priority}
        title={disabledReason || (valid ? "" : "Enter a whole number from 0 to 100.")}
        onClick={() => onChange({ action: "wifi_priority", network, priority: value })}
      >
        Save
      </button>
      {network.active && (
        <button className="small-button" disabled={blocked} title={disabledReason} onClick={() => onChange({ action: "wifi_disconnect", network })}>
          <Unlink size={14} aria-hidden="true" /> Disconnect
        </button>
      )}
      <button className="small-button warning" disabled={blocked} title={disabledReason} onClick={() => onChange({ action: "wifi_forget", network })}>
        <Trash2 size={14} aria-hidden="true" /> Forget
      </button>
    </div>
  );
}

function PreferredNetworks({
  saved,
  disabledReason = "",
  onChange,
}: {
  saved: SavedNetwork[];
  disabledReason?: string;
  // Present only while the farmer may change saved networks.
  onChange?: (change: NetworkChange) => void;
}) {
  const preferred = saved.filter((network) => network.autoconnect);
  const other = saved.filter((network) => !network.autoconnect);
  const state = (network: SavedNetwork) =>
    network.active ? <Badge tone="green">Connected</Badge>
    : network.inRange ? <Badge tone="blue">In range</Badge>
    : <Badge tone="gray">Not in range</Badge>;
  // Older device software reports no profile ID, so its networks cannot be changed remotely.
  const actions = (network: SavedNetwork) =>
    onChange && network.id ? <SavedNetworkActions network={network} disabledReason={disabledReason} onChange={onChange} />
    : !onChange ? <span className="caption muted">Priority {network.priority}</span> : null;
  return (
    <>
      {preferred.length ? (
        <ol className="network-list">
          {preferred.map((network, index) => (
            <li key={network.profile || network.ssid} className={onChange ? "managed" : undefined}>
              <span className="network-rank">{index + 1}</span>
              <span className="network-name">{network.ssid}</span>
              {state(network)}
              {actions(network)}
            </li>
          ))}
        </ol>
      ) : (
        <p className="caption muted">No saved network joins automatically.</p>
      )}
      {other.length > 0 && (
        <>
          <p className="caption muted">Saved, but not joined automatically</p>
          <ul className="network-list">
            {other.map((network) => (
              <li key={network.profile || network.ssid} className={onChange ? "managed" : undefined}>
                <span className="network-name">{network.ssid}</span>
                {state(network)}
                {actions(network)}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Advanced Settings → Network configuration: status, the saved networks in the order the
 * device tries them (with priority, disconnect and forget), and a Wi-Fi scan by the device itself. */
export function NetworkConfiguration({ device, canControl }: { device: Device; canControl: boolean }) {
  const { online, latest, sending, history, errorFor, feedbackFor, result, send, disabledReason } = useDeviceCommands(device, canControl);
  const [choice, setChoice] = useState<WifiChoice | null>(null);
  const [change, setChange] = useState<NetworkChange | null>(null);
  // A confirmation is dropped, never sent, once requests are no longer allowed.
  useEffect(() => {
    if (disabledReason) setChange(null);
  }, [disabledReason]);
  // Progress for a saved-network change shows under the saved list; everything else under the scan.
  const savedChange = sending ? isSavedNetworkAction(sending) : !!latest && isSavedNetworkAction(latest.action);
  const networkResult = (
    <>
      {result(feedbackFor("network"), "network")}
      {errorFor("network") && <p className="form-error" role="alert">{errorFor("network")}</p>}
    </>
  );
  const h = device.health;
  const n = h?.network;
  const fresh = healthFresh(device);
  const reportedAt = healthReportedAt(device);
  const live = liveValue(device);
  // Network details need a device that reports them; older software reports only name and IP.
  const reported = (value: string | undefined) => (n ? live(value) : NOT_REPORTED);
  // A past moment: relative while current, exact once it is only history.
  const when = (value: string) => (fresh ? ago(value).toLowerCase() : `${formatDate(value)} · ${formatTime(value)}`);
  const scanCommand = history.find((command) => command.action === "network_scan" && command.status === "succeeded" && isWifiScan(command.result));
  const scan = scanCommand && isWifiScan(scanCommand.result) ? { ...scanCommand.result, updatedAt: scanCommand.updatedAt } : null;
  // The network the device is on right now, only while that is confirmed.
  const current = fresh && n?.method === "wifi" ? n.ssid : undefined;
  const control = canControl && !device.disconnectedAt;

  return (
    <section className="advanced-section">
      <h3><HealthLabel icons={["connection"]}>Network configuration</HealthLabel></h3>
      <span className="caption muted">
        What the device reports about its own network. Anything it cannot currently confirm shows as Unknown.
      </span>
      <dl className="device-details">
        {(
          [
            ["Connection to BeeHave", device.disconnectedAt ? "Disconnected" : online ? "Online" : device.lastSeen ? "Offline" : "Not connected yet"],
            ["Connection method", reported(n && methodLabels[n.method])],
            ["Wi-Fi network", n ? reported(n.method === "wifi" ? n.ssid : "Not on Wi-Fi") : live(h?.wifiNetwork)],
            ["Signal strength", reported(n?.signal !== undefined ? signalLabel(n.signal) : n?.method === "wifi" ? undefined : "Not on Wi-Fi")],
            ["IP address", live(n?.ipAddress ?? h?.ipAddress)],
            ["Internet", reported(n?.internet && internetLabels[n.internet])],
            ["BeeHave cloud", online ? "Reachable" : device.lastSeen ? "Unknown" : "Not connected yet"],
            ["Setup mode", reported(n && (n.setupMode ? "On: the device is running its setup hotspot" : "Off"))],
            ["Bluetooth setup", "Not available yet"],
            ["Last connected to Wi-Fi", reported(n && (n.lastConnectedAt ? when(n.lastConnectedAt) : "Never"))],
            ["Last setup page Wi-Fi change", reported(n && (n.setupPageResult ? `${setupPageNote(device, false)?.summary ?? ""} (${when(n.setupPageResult.at)})` : "None"))],
            ["Last network problem", reported(n && (n.lastFailure ? `${n.lastFailure.message} (${n.lastFailure.ssid.trim() || "unknown network"}, ${when(n.lastFailure.at)})` : "None"))],
          ] as [string, React.ReactNode][]
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h4 className="section-label">Preferred networks</h4>
      <span className="caption muted">The device joins the first one in range, in this order.</span>
      {!n ? (
        <p className="caption muted">{NOT_REPORTED}</p>
      ) : fresh ? (
        <PreferredNetworks saved={n.saved} disabledReason={disabledReason} onChange={control ? setChange : undefined} />
      ) : (
        <>
          <p className="stale-value">Unknown<small>The device cannot currently confirm its saved networks.</small></p>
          <details className="network-diagnostics">
            <summary>Last reported list ({reportedAt ? ago(reportedAt).toLowerCase() : "unknown time"})</summary>
            <PreferredNetworks saved={n.saved} />
          </details>
        </>
      )}
      <span className="caption muted">When several saved networks are in range, the highest priority (0–100) is joined first.</span>
      {savedChange && networkResult}
      {change && (
        <ConfirmDialog
          title={commandPrompts[change.action].title}
          text={`${change.network.ssid}${change.priority !== undefined ? `: priority ${change.network.priority} → ${change.priority}` : ""}. ${commandPrompts[change.action].text}`}
          confirmLabel={commandPrompts[change.action].confirm}
          confirmClass={change.action === "wifi_forget" ? "warning" : "primary"}
          onCancel={() => setChange(null)}
          onConfirm={() => {
            const { action, network, priority } = change;
            setChange(null);
            void send(action, { id: requestId(), network: { ssid: network.ssid, profile: network.id!, ...(priority !== undefined ? { priority } : {}) } });
          }}
        />
      )}

      <h4 className="section-label">Available networks</h4>
      <span className="caption muted">Networks the device itself can see. Scanning does not change its connection.</span>
      {control && (
        <div className="button-row">
          <CommandButton device={device} canControl={canControl} action="network_scan" confirm={false} />
        </div>
      )}
      {!savedChange && networkResult}
      {scan && (
        <>
          <p className="caption muted">
            Scanned {ago(scan.scannedAt ?? scan.updatedAt).toLowerCase()}
            {scan.cached ? " (the device's last scan; its radio was busy)" : ""}
          </p>
          {!scan.networks.length && <p className="caption muted">The device found no Wi-Fi networks.</p>}
        </>
      )}
      {(scan?.networks.length || control) && (
        <ul className="network-list">
          {scan?.networks.map((network) => {
            const saved = n?.saved.find((item) => item.ssid === network.ssid && item.id);
            return (
              <li key={network.ssid}>
                {network.security === "open" ? <LockOpen size={14} aria-label="Open network" /> : <Lock size={14} aria-label="Secured network" />}
                <span className="network-name">
                  {network.ssid}
                  {saved && <small className="muted"> · Saved</small>}
                </span>
                <span className="caption muted">{signalLabel(network.signal)}</span>
                {network.ssid === current ? (
                  <Badge tone="green">Connected</Badge>
                ) : (
                  control && (
                    <button
                      className="small-button"
                      disabled={!!disabledReason}
                      title={disabledReason}
                      onClick={() => setChoice({ kind: "scanned", ssid: network.ssid, security: network.security, saved })}
                    >
                      Connect
                    </button>
                  )
                )}
              </li>
            );
          })}
          {control && (
            <li>
              <Plus size={14} aria-hidden="true" />
              <span className="network-name">Other network</span>
              <span className="caption muted">Hidden or not in the list</span>
              <button className="small-button" disabled={!!disabledReason} title={disabledReason} onClick={() => setChoice({ kind: "other" })}>
                Connect
              </button>
            </li>
          )}
        </ul>
      )}
      {choice && <WifiConnectSheet device={device} canControl={canControl} choice={choice} onClose={() => setChoice(null)} />}

      {n && (
        <details className="network-diagnostics">
          <summary>Network diagnostics</summary>
          <dl className="device-details">
            {n.saved.map((network) => (
              <div key={network.profile || network.ssid}>
                <dt className="mono">{network.profile || network.ssid}</dt>
                <dd>
                  priority {network.priority} · auto-join {network.autoconnect ? "on" : "off"}
                  {network.active ? " · active" : ""}
                </dd>
              </div>
            ))}
            {n.lastFailure && (
              <div>
                <dt>Last failure stage</dt>
                <dd className="mono">{n.lastFailure.stage}</dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </section>
  );
}
