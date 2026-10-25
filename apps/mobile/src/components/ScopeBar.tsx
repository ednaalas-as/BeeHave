import { colors, type Device, type FarmMembership } from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useFarm } from "../farm";
import { useRemote } from "../hooks/useRemote";
import { styles } from "../styles";
import { SelectionSheet } from "./SelectionSheet";

/** FARM ▼ → EDGE DEVICE ▼. The device list is the selected farm's only; a device that is not
 * in it (deleted, or from the previous farm) falls back to all devices in this farm. */
export function ScopeBar({
  farms,
  setFarm,
  station,
  setStation,
  expired,
}: {
  farms: FarmMembership[];
  setFarm: (id: string) => void;
  station: string;
  setStation: (id: string) => void;
  expired: () => void;
}) {
  const { farm, farmPath } = useFarm();
  const result = useRemote<Device[]>(farmPath("/devices"), expired, 15_000);
  const devices = result.error ? [] : result.data;
  const unknown = !!station && !!devices && !devices.some((device) => device.id === station);
  useEffect(() => {
    if (unknown) setStation("");
  }, [unknown, setStation]);
  return <ScopeSelectors farms={farms} farm={farm} devices={devices ?? []} station={station} setFarm={setFarm} setStation={setStation} />;
}

export function ScopeSelectors({ farms = [], farm, devices = [], station = "", setFarm = () => {}, setStation = () => {} }: {
  farms?: FarmMembership[];
  farm?: FarmMembership;
  devices?: Device[];
  station?: string;
  setFarm?: (id: string) => void;
  setStation?: (id: string) => void;
}) {
  const [choosing, setChoosing] = useState<"farm" | "device" | null>(null);
  const selected = devices?.find((device) => device.id === station);
  const unknown = !!station && !!devices && !selected;
  return (
    <View style={styles.scopeBar}>
      <Pressable
        style={[styles.stationSelector, styles.scopeSelector]}
        accessibilityRole="button"
        accessibilityLabel={`Farm: ${farm?.name ?? "No Available Farm"}. Change farm`}
        disabled={!farms.length}
        onPress={() => setChoosing("farm")}
      >
        <Feather name="feather" size={17} color={colors.blue} />
        <View style={styles.scopeSelectorText}>
          <Text style={styles.scopeCaption}>FARM</Text>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65} style={styles.scopeLabel}>{farm?.name ?? "No Available Farm"}</Text>
        </View>
        <Feather name="chevron-down" size={16} color={colors.slate} />
      </Pressable>
      <Pressable
        style={[styles.stationSelector, styles.scopeSelector]}
        accessibilityRole="button"
        accessibilityLabel={`Edge device: ${selected?.name ?? (devices.length ? "All devices in this farm" : "No Available Edge Device")}. Change edge device`}
        disabled={!devices.length}
        onPress={() => setChoosing("device")}
      >
        <Feather name="radio" size={17} color={colors.blue} />
        <View style={styles.scopeSelectorText}>
          <Text style={styles.scopeCaption}>EDGE DEVICE</Text>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65} style={styles.scopeLabel}>
            {selected?.name ?? (devices.length ? "All devices in this farm" : "No Available Edge Device")}
          </Text>
        </View>
        <Feather name="chevron-down" size={16} color={colors.slate} />
      </Pressable>
      <SelectionSheet
        title="Farm"
        visible={choosing === "farm"}
        selected={farm?.id ?? ""}
        options={farms.map((f) => ({ label: f.role === "owner" ? f.name : `${f.name} · viewer`, value: f.id }))}
        onSelect={setFarm}
        onClose={() => setChoosing(null)}
      />
      <SelectionSheet
        title="Edge device"
        visible={choosing === "device"}
        selected={unknown ? "" : station}
        options={[
          { label: devices.length ? "All devices in this farm" : "No Available Edge Device", value: "" },
          ...(devices?.map((device) => ({ label: device.name, value: device.id })) ?? []),
        ]}
        onSelect={setStation}
        onClose={() => setChoosing(null)}
      />
    </View>
  );
}
