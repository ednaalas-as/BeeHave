import { ago, healthFresh, healthReportedAt, type Device } from "@beehave/shared";
import { Text, View } from "react-native";
import { styles } from "../styles";
import { Pair } from "./FormControls";
import { HealthIcons, type HealthIconName } from "./HealthIcon";

export const NOT_REPORTED = "Not reported by device";

/** A value the device must confirm: Unknown when its report is not current, with the last
 * reported value kept underneath as history, never shown as the current state. */
export function LivePair({ device, label, value, icons }: { device: Device; label: string; value: string | undefined; icons?: readonly HealthIconName[] }) {
  if (value === undefined || value === "") return <Pair label={label} value={NOT_REPORTED} icons={icons} />;
  if (healthFresh(device)) return <Pair label={label} value={value} icons={icons} />;
  const at = healthReportedAt(device);
  return (
    <View style={styles.pair}>
      <View style={styles.healthLabel}>
        {icons && <HealthIcons icons={icons} />}
        <Text style={styles.muted}>{label}</Text>
      </View>
      <View style={styles.staleValue}>
        <Text style={styles.value}>Unknown</Text>
        <Text style={[styles.caption, { textAlign: "right" }]}>
          Last reported {at ? ago(at).toLowerCase() : ""}: {value}
        </Text>
      </View>
    </View>
  );
}
