import { Pressable, Text, View } from "react-native";
import { styles } from "../styles";

export function PeriodControl({
  days,
  onChange,
  historical = false,
}: {
  days: number;
  onChange: (days: number) => void;
  historical?: boolean;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {(historical ? [7, 30] : [1, 7, 30, 365]).map((period) => (
        <Pressable
          key={period}
          accessibilityRole="tab"
          accessibilityState={{ selected: days === period }}
          onPress={() => onChange(period)}
          style={[styles.segment, days === period && styles.segmentSelected]}
        >
          <Text
            style={[
              styles.segmentText,
              days === period && styles.segmentTextSelected,
            ]}
          >
            {period === 1 ? "Today" : period === 7 ? "Week" : period === 30 ? "Month" : "Year"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
