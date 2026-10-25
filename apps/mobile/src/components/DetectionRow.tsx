import {
  classificationLabel,
  colors,
  formatDate,
  formatTime,
  type Detection,
} from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { Detail } from "../navigation";
import { styles } from "../styles";

export function DetectionRow({
  d: detection,
  open,
}: {
  d: Detection;
  open: (v: Detail) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open detection ${detection.id}`}
      onPress={() =>
        open({
          kind: "detection",
          device: detection.deviceId,
          id: detection.id,
        })
      }
      style={styles.record}
    >
      <View style={styles.row}>
        <Text style={styles.subtitle}>{classificationLabel(detection.species)}</Text>
        <Text style={styles.blue}>{detection.frequency.toFixed(1)} Hz</Text>
      </View>
      <Text style={styles.caption}>
        {formatDate(detection.observedAt)} · {formatTime(detection.observedAt)}
      </Text>
      <View style={styles.row}>
        <Text style={styles.muted}>
          {(detection.confidence * 100).toFixed(0)}% confidence
        </Text>
        <Feather name="chevron-right" size={18} color={colors.slate} />
      </View>
    </Pressable>
  );
}
