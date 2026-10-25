import {
  ago,
  commandPrompts,
  formatDate,
  formatTime,
  formatUptime,
  healthFresh,
  healthReportedAt,
  internetLabels,
  isWifiScan,
  isOnline,
  isSavedNetworkAction,
  monitoringStateLabels,
  monitoringStatus,
  networkMethodLabels,
  setupPageNote,
  signalLabel,
  type Device,
  type SavedNetwork,
  type SavedNetworkAction,
} from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { randomUUID } from "expo-crypto";
import { useEffect, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { useDeviceCommands } from "../hooks/useDeviceCommands";
import { styles } from "../styles";
import { CommandButton, CommandResult } from "./CommandControls";
import { DeviceControls } from "./DeviceControls";
import { Button, Pair } from "./FormControls";
import { HealthLabel } from "./HealthIcon";
import { LivePair, NOT_REPORTED } from "./LivePair";
import { Sheet, StatusBadge } from "./Sheet";
import { WifiConnectSheet, type WifiChoice } from "./WifiConnectSheet";

type ChangeNetwork = (action: SavedNetworkAction, network: SavedNetwork, priority?: number) => void;

/** Priority, Disconnect and Forget for one saved network. Nothing changes until confirmed. */
function SavedNetworkActions({ network, disabledReason, onChange }: { network: SavedNetwork; disabledReason: string; onChange: ChangeNetwork }) {
  const [priority, setPriority] = useState(String(network.priority));
  // The device's report is the truth: follow it once a change lands.
  useEffect(() => setPriority(String(network.priority)), [network.priority]);
  const value = Number(priority);
  const valid = /^\d{1,3}$/.test(priority) && value <= 100;
  const blocked = !!disabledReason;
  return (
    <View style={styles.networkActions}>
      <Text style={styles.caption}>Priority</Text>
      <TextInput
        style={[styles.input, styles.priorityInput]}
        value={priority}
        onChangeText={setPriority}
        keyboardType="number-pad"
        maxLength={3}
        autoComplete="off"
        textContentType="none"
        editable={!blocked}
        accessibilityLabel={`Priority for ${network.ssid}`}
      />
      <Button title="Save" disabled={blocked || !valid || value === network.priority} onPress={() => onChange("wifi_priority", network, value)} />
      {network.active && <Button title="Disconnect" icon="wifi-off" disabled={blocked} onPress={() => onChange("wifi_disconnect", network)} />}
      <Button title="Forget" icon="trash-2" warning disabled={blocked} onPress={() => onChange("wifi_forget", network)} />
    </View>
  );
}

function PreferredNetworks({ saved, disabledReason = "", onChange }: { saved: SavedNetwork[]; disabledReason?: string; onChange?: ChangeNetwork }) {
  const preferred = saved.filter((network) => network.autoconnect);
  const other = saved.filter((network) => !network.autoconnect);
  const state = (network: SavedNetwork) =>
    network.active ? <StatusBadge tone="good">Connected</StatusBadge>
    : network.inRange ? <StatusBadge tone="neutral">In range</StatusBadge>
    : <StatusBadge tone="neutral">Not in range</StatusBadge>;
  // Older device software reports no profile ID, so its networks cannot be changed remotely.
  const actions = (network: SavedNetwork) =>
    onChange && network.id ? <SavedNetworkActions network={network} disabledReason={disabledReason} onChange={onChange} /> : null;
  const rowStyle = (network: SavedNetwork) => [styles.networkRow, onChange && network.id ? { borderBottomWidth: 0 } : null];
  return (
    <>
      {preferred.length ? (
        preferred.map((network, index) => (
          <View key={network.profile || network.ssid}>
            <View style={rowStyle(network)}>
              <Text style={styles.networkRank}>{index + 1}</Text>
              <Text style={[styles.body, styles.grow]}>{network.ssid}</Text>
              {!onChange && <Text style={styles.caption}>Priority {network.priority}</Text>}
              {state(network)}
            </View>
            {actions(network)}
          </View>
        ))
      ) : (
        <Text style={styles.caption}>No saved network joins automatically.</Text>
      )}
      {other.length > 0 && (
        <>
          <Text style={styles.caption}>Saved, but not joined automatically</Text>
          {other.map((network) => (
            <View key={network.profile || network.ssid}>
              <View style={rowStyle(network)}>
                <Text style={[styles.body, styles.grow]}>{network.ssid}</Text>
                {state(network)}
              </View>
              {actions(network)}
            </View>
          ))}
        </>
      )}
    </>
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
  const n = h?.network;
  const online = isOnline(device);
  const fresh = healthFresh(device);
  const reportedAt = healthReportedAt(device);
  const { latest, feedback, history, disabledReason, send, sending } = useDeviceCommands(device, canControl);
  // Progress for a saved-network change shows under the saved list; everything else under the scan.
  const savedChange = sending ? isSavedNetworkAction(sending) : !!latest && isSavedNetworkAction(latest.action);
  const [choice, setChoice] = useState<WifiChoice | null>(null);
  const monitoringNow = monitoringStatus(device, latest);
  const state = monitoringNow.current;
  // A past moment: relative while current, exact once it is only history.
  const when = (value: string) => (fresh ? ago(value).toLowerCase() : `${formatDate(value)} · ${formatTime(value)}`);
  const scanCommand = history.find((command) => command.action === "network_scan" && command.status === "succeeded" && isWifiScan(command.result));
  const scan = scanCommand && isWifiScan(scanCommand.result) ? { ...scanCommand.result, updatedAt: scanCommand.updatedAt } : null;
  // The network the device is on right now, only while that is confirmed.
  const current = fresh && n?.method === "wifi" ? n.ssid : undefined;
  const control = canControl && !device.disconnectedAt;
  // Network details need a device that reports them; older software reports only name and IP.
  const net = (value: string | undefined) => (n ? value : undefined);
  // Confirm, then send one saved-network change to the device.
  const changeNetwork: ChangeNetwork = (action, network, priority) => {
    const prompt = commandPrompts[action];
    const detail = priority !== undefined ? `${network.ssid}: priority ${network.priority} → ${priority}` : network.ssid;
    Alert.alert(prompt.title, `${detail}. ${prompt.text}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: prompt.confirm,
        style: action === "wifi_forget" ? "destructive" : "default",
        onPress: () => void send(action, { id: randomUUID(), network: { ssid: network.ssid, profile: network.id!, ...(priority !== undefined ? { priority } : {}) } }),
      },
    ]);
  };

  return (
    <Sheet
      title="Advanced settings"
      subtitle={fresh ? `${device.name} · from the latest device report` : `${device.name} · live values are Unknown until the device reports again`}
      onClose={onClose}
    >
      <DeviceControls device={device} canControl={canControl} changed={changed} />
      <HealthLabel icons={["connection"]} style={styles.sectionTitle}>Network configuration</HealthLabel>
      <Text style={styles.caption}>What the device reports about its own network. Anything it cannot currently confirm shows as Unknown.</Text>
      <Pair label="Connection to BeeHave" value={device.disconnectedAt ? "Disconnected" : online ? "Online" : device.lastSeen ? "Offline" : "Not connected yet"} />
      <LivePair device={device} label="Connection method" value={net(n && networkMethodLabels[n.method])} />
      <LivePair device={device} label="Wi-Fi network" value={n ? (n.method === "wifi" ? n.ssid : "Not on Wi-Fi") : h?.wifiNetwork} />
      <LivePair device={device} label="Signal strength" value={net(n?.signal !== undefined ? signalLabel(n.signal) : n?.method === "wifi" ? undefined : "Not on Wi-Fi")} />
      <LivePair device={device} label="IP address" value={n?.ipAddress ?? h?.ipAddress} />
      <LivePair device={device} label="Internet" value={net(n?.internet && internetLabels[n.internet])} />
      <Pair label="BeeHave cloud" value={online ? "Reachable" : device.lastSeen ? "Unknown" : "Not connected yet"} />
      <LivePair device={device} label="Setup mode" value={net(n && (n.setupMode ? "On: setup hotspot running" : "Off"))} />
      <Pair label="Bluetooth setup" value="Not available yet" />
      <LivePair device={device} label="Last connected to Wi-Fi" value={net(n && (n.lastConnectedAt ? when(n.lastConnectedAt) : "Never"))} />
      <LivePair
        device={device}
        label="Last setup page Wi-Fi change"
        value={net(n && (n.setupPageResult ? `${setupPageNote(device, false)?.summary ?? ""} (${when(n.setupPageResult.at)})` : "None"))}
      />
      <LivePair
        device={device}
        label="Last network problem"
        value={net(n && (n.lastFailure ? `${n.lastFailure.message} (${n.lastFailure.ssid.trim() || "unknown network"}, ${when(n.lastFailure.at)})` : "None"))}
      />

      <Text style={styles.eyebrowSmall}>Preferred networks</Text>
      <Text style={styles.caption}>The device joins the first one in range, in this order.</Text>
      {!n ? (
        <Text style={styles.caption}>{NOT_REPORTED}</Text>
      ) : fresh ? (
        <PreferredNetworks saved={n.saved} disabledReason={disabledReason} onChange={control ? changeNetwork : undefined} />
      ) : (
        <>
          <Pair label="Saved networks" value="Unknown" />
          <Text style={styles.caption}>Last reported {reportedAt ? ago(reportedAt).toLowerCase() : ""}; the device cannot currently confirm them:</Text>
          <PreferredNetworks saved={n.saved} />
        </>
      )}
      <Text style={styles.caption}>When several saved networks are in range, the highest priority (0–100) is joined first.</Text>
      {control && savedChange && <CommandResult device={device} canControl={canControl} group="network" />}

      <Text style={styles.eyebrowSmall}>Available networks</Text>
      <Text style={styles.caption}>Networks the device itself can see, not your phone. Scanning does not change its connection.</Text>
      {control && (
        <>
          <CommandButton device={device} canControl={canControl} action="network_scan" confirm={false} />
          {!savedChange && <CommandResult device={device} canControl={canControl} group="network" />}
        </>
      )}
      {scan && (
        <Text style={styles.caption}>
          Scanned {ago(scan.scannedAt ?? scan.updatedAt).toLowerCase()}
          {scan.cached ? " (the device's last scan; its radio was busy)" : ""}
          {scan.networks.length ? "" : ". The device found no Wi-Fi networks."}
        </Text>
      )}
      {scan?.networks.map((network) => {
        const saved = n?.saved.find((item) => item.ssid === network.ssid && item.id);
        return (
          <View key={network.ssid} style={styles.networkRow}>
            <Feather
              name={network.security === "open" ? "unlock" : "lock"}
              size={14}
              color="#7A8695"
              accessibilityLabel={network.security === "open" ? "Open network" : "Secured network"}
            />
            <View style={styles.grow}>
              <Text style={styles.body}>{network.ssid}</Text>
              <Text style={styles.caption}>{signalLabel(network.signal)}{saved ? " · Saved" : ""}</Text>
            </View>
            {network.ssid === current ? (
              <StatusBadge tone="good">Connected</StatusBadge>
            ) : (
              control && (
                <Button
                  title="Connect"
                  disabled={!!disabledReason}
                  onPress={() => setChoice({ kind: "scanned", ssid: network.ssid, security: network.security, saved })}
                />
              )
            )}
          </View>
        );
      })}
      {control && (
        <View style={styles.networkRow}>
          <Feather name="plus" size={14} color="#7A8695" />
          <View style={styles.grow}>
            <Text style={styles.body}>Other network</Text>
            <Text style={styles.caption}>Hidden or not in the list</Text>
          </View>
          <Button title="Connect" disabled={!!disabledReason} onPress={() => setChoice({ kind: "other" })} />
        </View>
      )}
      {choice && <WifiConnectSheet device={device} canControl={canControl} choice={choice} onClose={() => setChoice(null)} />}

      <HealthLabel icons={["monitoring"]} style={styles.sectionTitle}>Monitoring diagnostics</HealthLabel>
      <Text style={styles.caption}>Pause, resume and restart monitoring with the controls above. These are the service details behind it.</Text>
      <Pair label="Current state" value={monitoringStateLabels[state]} />
      {state === "unknown" && monitoringNow.lastReported && monitoringNow.reportedAt && (
        <Pair label="Last reported" value={`${monitoringStateLabels[monitoringNow.lastReported]} · ${ago(monitoringNow.reportedAt).toLowerCase()}`} />
      )}
      <LivePair device={device} icons={["monitoring"]} label="Service state" value={h?.monitoringService ?? (h ? (h.collecting ? "Running" : "Stopped") : undefined)} />
      <LivePair device={device} icons={["microphone"]} label="Microphone" value={h ? h.audioStatusDetail || (h.microphone ? "Connected" : "Unavailable") : undefined} />
      <LivePair device={device} icons={["temperature", "humidity"]} label="Temperature & humidity sensor" value={h ? h.sensorStatusDetail || (h.sensor ? "Connected" : "Unavailable") : undefined} />
      <LivePair device={device} label="Newest monitoring window" value={h?.lastWindowAgeSeconds !== undefined ? `${Math.round(h.lastWindowAgeSeconds)} s old` : undefined} />
      <LivePair device={device} label="Reported problems" value={h?.errors ? (h.errors.length ? h.errors.join("; ") : "None") : undefined} />
      <Pair label="Last health report" value={reportedAt ? ago(reportedAt) : "Never"} />
      <Pair label="Last remote request" value={latest ? `${feedback!.text} (${ago(latest.updatedAt).toLowerCase()})` : "None"} />
      {n && (
        <>
          <Text style={styles.eyebrowSmall}>Network diagnostics</Text>
          {n.saved.map((network) => (
            <Pair
              key={network.profile || network.ssid}
              label={network.profile || network.ssid}
              value={`priority ${network.priority} · auto-join ${network.autoconnect ? "on" : "off"}${network.active ? " · active" : ""}`}
            />
          ))}
          {n.lastFailure && <Pair label="Last failure stage" value={n.lastFailure.stage} />}
        </>
      )}

      <Text style={styles.sectionTitle}>System health</Text>
      {h ? (
        <>
          <LivePair device={device} icons={["cpu"]} label="CPU usage" value={`${h.cpu.toFixed(0)}%`} />
          <LivePair device={device} icons={["memory"]} label="Memory usage" value={`${h.ram.toFixed(0)}%`} />
          <LivePair device={device} icons={["temperature"]} label="CPU temperature" value={`${h.cpuTemperature.toFixed(1)} °C`} />
          <LivePair device={device} icons={["storage"]} label="Storage used" value={`${h.storageUsed.toFixed(1)} of ${h.storageTotal} GB`} />
          <LivePair device={device} icons={["storage"]} label="Storage free" value={`${(h.storageTotal - h.storageUsed).toFixed(1)} GB`} />
        </>
      ) : (
        <Text style={styles.caption}>The device has not reported system health yet.</Text>
      )}

      <Text style={styles.sectionTitle}>Data & sync</Text>
      {h?.uploader === "not installed" ? (
        <Pair label="Records waiting to sync" value="Not tracked (uploader not installed)" />
      ) : (
        <LivePair device={device} label="Records waiting to sync" value={h ? String(h.queued) : undefined} />
      )}
      <Pair icons={["sync"]} label="Last successful sync" value={device.lastSync ? `${formatDate(device.lastSync)} · ${formatTime(device.lastSync)}` : "Not yet synchronized"} />
      <Pair icons={["sync"]} label="Upload status" value={h?.uploader === "not installed" ? "Data upload not set up" : !device.lastSync ? "No uploads yet" : !online ? "Paused while offline" : h?.queued ? "Waiting to upload" : "Up to date"} />

      <Text style={styles.sectionTitle}>Device information</Text>
      <Pair label="Device ID" value={device.id} />
      <Pair label="Device hostname" value={h?.hostname || NOT_REPORTED} />
      <Pair label="Model" value={device.model || NOT_REPORTED} />
      <Pair label="Software version" value={h?.softwareVersion || NOT_REPORTED} />
      <LivePair device={device} label="Uptime" value={h?.uptimeSeconds !== undefined ? formatUptime(h.uptimeSeconds) : undefined} />
      <Pair label="Installation label" value={device.location} />
    </Sheet>
  );
}
