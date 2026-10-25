import { colors, type StatusTone } from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { styles } from "../styles";

export const toneStyle = {
  good: styles.toneGood,
  warning: styles.toneWarning,
  bad: styles.toneBad,
  neutral: styles.toneNeutral,
} satisfies Record<StatusTone, object>;

export function StatusBadge({ tone, children }: { tone: StatusTone; children: string }) {
  return <Text style={[styles.statusBadge, toneStyle[tone]]}>{children}</Text>;
}

export function Feedback({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <Text accessibilityLiveRegion="polite" style={[styles.feedback, toneStyle[tone]]}>
      {children}
    </Text>
  );
}

// Tall bottom sheet in the app's existing sheet style, used for device dialogs.
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.sheetBackdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.sheetDismiss} onPress={onClose} accessibilityLabel={`Close ${title}`} />
        <View style={[styles.sheet, styles.sheetTall]} accessibilityViewIsModal>
          <View style={styles.sheetHandle} />
          <View style={styles.row}>
            <View style={styles.grow}>
              <Text style={styles.subtitle}>{title}</Text>
              {subtitle && <Text style={styles.caption}>{subtitle}</Text>}
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close ${title}`} style={styles.iconButton}>
              <Feather name="x" size={20} color={colors.navy} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
