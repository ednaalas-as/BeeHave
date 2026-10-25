import { RegisterDevice } from "../components/NearbySetup";
import { AdvancedSettings } from "../components/AdvancedSettings";
import { MonitoringPanel } from "../components/MonitoringPanel";
import { CommandButton, CommandResult } from "../components/CommandControls";
import { ago, deviceOverview, healthFresh, setupPageNote, type Account, type Device } from "@beehave/shared";
import { type NearbyPi } from "@beehave/shared/nearby";
import { useCallback, useEffect, useReducer, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, Message, Pair } from "../components/FormControls";
import { Feedback, StatusBadge } from "../components/Sheet";
import { HealthLabel, type HealthIconName } from "../components/HealthIcon";
import { useCommandsSettled } from "../hooks/useDeviceCommands";

const itemIcons = (key: string, value: string): HealthIconName[] =>
  key === "microphone" ? ["microphone"]
  : key === "environment" ? ["temperature", "humidity"]
  : key === "connection" ? [value === "Online" ? "connection" : "offline"]
  : key === "storage" ? ["storage"]
  : key === "sync" ? ["sync"]
  : [];
import { apiRequest } from "../api";
import { useFarm } from "../farm";
import { useRemote } from "../hooks/useRemote";
import { styles } from "../styles";

export function DeviceScreen({
  expired,
  account,
  refreshSession,
  station,
  deleted,
}: {
  expired: () => void;
  account: Account;
  // Reloads the account's farms after connecting to or leaving one.
  refreshSession: () => void;
  // The selected Edge Device narrows the screen to it; empty shows every device of this farm.
  station: string;
  deleted: (id: string) => void;
}) {
  const { farm, owner: admin, farmPath } = useFarm();
  // While a device is offline or its report is stale, check often so a reconnect shows promptly.
  const [stale, setStale] = useState(false);
  const query = useRemote<Device[]>(farmPath("/devices"), expired, stale ? 10_000 : 60_000);
  const shown = query.data?.filter((device) => !station || device.id === station);
  useEffect(() => {
    setStale(!!query.data?.some((device) => !device.disconnectedAt && !healthFresh(device)));
  }, [query.data]);
  // Freshness depends on the clock: re-evaluate so a device that stops reporting turns Unknown.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, []);
  // A request reaching its real outcome refreshes the device's reported state in place.
  const refresh = query.refresh;
  useCommandsSettled(useCallback(() => refresh(), [refresh]));
  // The API resolves the account's permission per device; older responses fall back to the farm role.
  const controls = (device: Device) => (device.access ? device.access === "administrator" : admin);
  const [registering, setRegistering] = useState<{ initial: NearbyPi | null } | null>(null);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyPi[]>([]);
  const [leaving, setLeaving] = useState<"confirm" | "busy" | null>(null);
  const [leaveError, setLeaveError] = useState("");
  // A viewer leaves the whole farm; the farm's devices and data disappear from this account.
  async function leave() {
    setLeaving("busy");
    setLeaveError("");
    try {
      await apiRequest(`/farms/${encodeURIComponent(farm.id)}/members/${encodeURIComponent(account.id)}/remove`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      refreshSession();
    } catch (e) {
      setLeaveError((e as Error).message);
      setLeaving(null);
    }
  }
  // A discovered Pi counts as registered only while its pairing is active in this farm.
  const isRegistered = (pi: NearbyPi) =>
    !!query.data?.some((device) => device.setupId === pi.id && !device.disconnectedAt);
  const available = nearby.filter((pi) => !isRegistered(pi));
  const advancedDevice = query.data?.find((device) => device.id === advanced);
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={query.loading} onRefresh={query.reload} />
      }
    >
      <View style={styles.row}>
        <Text style={styles.title}>Devices</Text>
        {admin && (
          <Button primary title="Register Device" onPress={() => setRegistering({ initial: null })} />
        )}
      </View>
      {query.error && <Message>{query.error}</Message>}
      <Text style={styles.sectionTitle}>Registered devices</Text>
      <Text style={styles.caption}>Linked to {farm.name}</Text>
      {shown?.map((device) => {
        const { overall, items } = deviceOverview(device);
        const canControl = controls(device);
        return (
          <Card key={device.id}>
            <View style={styles.row}>
              <View style={styles.grow}>
                <Text style={styles.subtitle}>{device.name}</Text>
                <Text style={styles.caption}>{device.location}</Text>
                {device.access && (
                  <Text
                    accessibilityLabel={device.access === "administrator" ? "You administer this farm and can control this device" : "You can view this device"}
                    style={[styles.statusBadge, styles.roleBadge, device.access === "administrator" ? styles.roleAdmin : styles.toneNeutral]}
                  >
                    {device.access === "administrator" ? "Administrator" : "Viewer"}
                  </Text>
                )}
              </View>
              <StatusBadge tone={overall.tone}>{overall.value}</StatusBadge>
            </View>
            <MonitoringPanel device={device} canControl={canControl} />
            {items
              .filter((item) => item.key !== "microphone" && item.key !== "environment")
              .map((item) => (
                <View key={item.label} style={styles.statusRow}>
                  <View style={styles.grow}>
                    <HealthLabel icons={itemIcons(item.key, item.value)}>{item.label}</HealthLabel>
                    {item.detail && <Text style={styles.caption}>{item.detail}</Text>}
                  </View>
                  <StatusBadge tone={item.tone}>{item.value}</StatusBadge>
                </View>
              ))}
            <SetupResult device={device} />
            <Pair label="Last update" value={ago(device.lastSeen)} />
            <Pair label="Last data received" value={ago(device.lastSync)} />
            {/* Restart is the card's device-level quick action; the full set is in Advanced settings. */}
            {canControl && !device.disconnectedAt && (
              <>
                <CommandButton device={device} canControl={canControl} action="reboot" />
                <CommandResult device={device} canControl={canControl} group="device" />
              </>
            )}
            {!!device.disconnectedAt && (
              <Text style={styles.caption}>Disconnected. History remains with this farm. Registration options are in Advanced settings.</Text>
            )}
            {/* Advanced settings hold device controls, network and service administration: administrators only. */}
            {canControl && (
              <Button title="Advanced settings" icon="settings" onPress={() => setAdvanced(device.id)} />
            )}
          </Card>
        );
      })}
      {query.data?.length === 0 && (
        <Message>
          {admin ? "No device registered yet. Tap Register Device to connect your first BeeHave device." : "No device registered yet. A farm administrator can register one."}
        </Message>
      )}
      {!admin && !farm.demo && (
        leaving === "confirm" || leaving === "busy" ? (
          <Button title={`Confirm disconnect from ${farm.name}`} disabled={leaving === "busy"} onPress={() => void leave()} />
        ) : (
          <Button title={`Disconnect from ${farm.name}`} onPress={() => setLeaving("confirm")} />
        )
      )}
      {!!leaveError && <Message>{leaveError}</Message>}
      {admin && <Text style={styles.sectionTitle}>Available devices</Text>}
      {admin && (available.length ? (
        available.map((pi) => (
          <Card key={pi.url}>
            <View style={styles.row}>
              <View style={styles.grow}>
                <Text style={styles.body}>{pi.name}</Text>
                <Text style={styles.caption}>Available nearby · not registered</Text>
              </View>
              <Button title="Register" onPress={() => setRegistering({ initial: pi })} />
            </View>
          </Card>
        ))
      ) : (
        <Text style={styles.caption}>
          No nearby devices found yet. Tap Register Device to search for nearby BeeHave devices.
        </Text>
      ))}
      <Message>
        An offline device may still collect locally. Current collection state
        cannot be inferred from internet connectivity.
      </Message>
      {registering && (
        <RegisterDevice
          initial={registering.initial}
          isRegistered={isRegistered}
          found={setNearby}
          registered={query.reload}
          onClose={() => setRegistering(null)}
        />
      )}
      {advancedDevice && controls(advancedDevice) && (
        <AdvancedSettings
          device={advancedDevice}
          canControl={controls(advancedDevice)}
          changed={(wasDeleted) => {
            if (wasDeleted) {
              deleted(advancedDevice.id);
              setAdvanced(null);
            }
            query.refresh();
          }}
          onClose={() => setAdvanced(null)}
        />
      )}
    </ScrollView>
  );
}

// The last setup-page Wi-Fi change, which that page could not show: reported once back online.
function SetupResult({ device }: { device: Device }) {
  const note = setupPageNote(device);
  if (!note) return null;
  return <Feedback tone={note.tone}>{`${note.title} (${ago(note.at).toLowerCase()}). ${note.text}`}</Feedback>;
}
