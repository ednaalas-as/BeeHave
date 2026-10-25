import { colors } from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { styles } from "../styles";

/** One collapsible settings group in the app's card style. Collapsing only hides the content: it
 * stays mounted, so a form someone is part-way through keeps what they typed. */
export function SettingsSection({ title, defaultOpen = false, children }: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        hitSlop={8}
      >
        <Text style={styles.subtitle}>{title}</Text>
        <Feather name={open ? "chevron-down" : "chevron-right"} size={18} color={colors.slate} />
      </Pressable>
      <View style={[styles.settingsBody, !open && styles.hidden]}>{children}</View>
    </View>
  );
}

/** A titled part of a settings group, divided from the one above by a thin line, never a card. */
export function SettingsBlock({ title, action, first = false, children }: {
  title?: string;
  action?: ReactNode;
  // The first block of a group has no divider above it.
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.settingsBlock, !first && styles.settingsDivider]}>
      {(title || action) && (
        <View style={styles.row}>
          {title ? <Text style={styles.settingsBlockTitle}>{title}</Text> : <View />}
          {action}
        </View>
      )}
      {children}
    </View>
  );
}

/** A quiet text action for a block header, such as Edit. */
export function TextAction({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} hitSlop={8} style={({ pressed }) => [pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={styles.blue}>{title}</Text>
    </Pressable>
  );
}
