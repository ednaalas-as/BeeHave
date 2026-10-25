import { colors } from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { styles } from "../styles";

type Option = { label: string; value: string };
export function SelectionSheet({
  title,
  visible,
  selected,
  options,
  onSelect,
  onClose,
}: {
  title: string;
  visible: boolean;
  selected: string;
  options: Option[];
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={styles.sheetDismiss}
          onPress={onClose}
          accessibilityLabel="Close selection"
        />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.sheetHandle} />
          <View style={styles.row}>
            <Text style={styles.subtitle}>{title}</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close selection"
              style={styles.iconButton}
            >
              <Feather name="x" size={20} color={colors.navy} />
            </Pressable>
          </View>
          <ScrollView>
            {options.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected === option.value }}
                onPress={() => {
                  onSelect(option.value);
                  onClose();
                }}
                style={styles.sheetOption}
              >
                <Text style={styles.body}>{option.label}</Text>
                {selected === option.value && (
                  <Feather name="check" size={20} color={colors.amber} />
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
