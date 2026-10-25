import { Feather } from "@expo/vector-icons";
import { type ReactNode } from "react";
import { Text, View } from "react-native";
import { styles } from "../styles";

// One small Feather icon per device-health item, for recognition; the text label always stays.
// Feather has no memory-module icon, so "server" (stacked modules) stands in for RAM.
export const healthIcons = {
  cpu: "cpu",
  memory: "server",
  temperature: "thermometer",
  humidity: "droplet",
  microphone: "mic",
  storage: "hard-drive",
  connection: "wifi",
  offline: "wifi-off",
  monitoring: "activity",
  sync: "refresh-cw",
  power: "power",
  stopped: "stop-circle",
  error: "alert-triangle",
  unknown: "help-circle",
} as const satisfies Record<string, keyof typeof Feather.glyphMap>;
export type HealthIconName = keyof typeof healthIcons;

export function HealthIcons({ icons }: { icons: readonly HealthIconName[] }) {
  return (
    <>
      {icons.map((name) => (
        <Feather key={name} name={healthIcons[name]} size={14} color="#7A8695" accessibilityElementsHidden importantForAccessibility="no" />
      ))}
    </>
  );
}

export function HealthLabel({ icons, children, style = styles.body }: { icons: readonly HealthIconName[]; children: ReactNode; style?: object }) {
  return (
    <View style={styles.healthLabel}>
      <HealthIcons icons={icons} />
      <Text style={style}>{children}</Text>
    </View>
  );
}
