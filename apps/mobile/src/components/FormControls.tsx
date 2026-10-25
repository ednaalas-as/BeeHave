import { colors } from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { styles } from "../styles";
import { HealthIcons, type HealthIconName } from "./HealthIcon";

export function Button({
  title,
  onPress,
  primary = false,
  warning = false,
  disabled = false,
  variant,
  icon,
  busy = false,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  warning?: boolean;
  disabled?: boolean;
  // Pause is a caution (amber, never red); Resume is the positive action (green).
  variant?: "pause" | "resume";
  icon?: keyof typeof Feather.glyphMap;
  // In progress: a spinner replaces the icon and the button stays disabled.
  busy?: boolean;
}) {
  const textColor = variant === "resume" && !busy ? "#FFFFFF" : warning ? colors.red : colors.navy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        (icon || busy) && styles.buttonWithIcon,
        primary && styles.primary,
        warning && styles.warningButton,
        !busy && variant === "pause" && styles.pauseButton,
        !busy && variant === "resume" && styles.resumeButton,
        (disabled || busy) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={colors.navy} /> : icon && <Feather name={icon} size={16} color={textColor} />}
      <Text style={[styles.buttonText, { color: textColor }]}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

// Account fields iOS and Android may offer to autofill. Secret fields that are not the
// user's account password (device codes, Wi-Fi keys) pass `secure` without `account`.
type AccountField = "name" | "email" | "password" | "newPassword";
const autofill: Record<
  AccountField,
  { textContentType: TextInputProps["textContentType"]; autoComplete: TextInputProps["autoComplete"] }
> = {
  name: { textContentType: "name", autoComplete: "name" },
  email: { textContentType: "emailAddress", autoComplete: "email" },
  password: { textContentType: "password", autoComplete: "current-password" },
  newPassword: { textContentType: "newPassword", autoComplete: "new-password" },
};

export function Field({
  label,
  value,
  onChange,
  secure = false,
  account,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
  account?: AccountField;
}) {
  const [focused, setFocused] = useState(false);
  const password = account === "password" || account === "newPassword";
  // Password autofill is offered only while a password field is being edited; once it
  // loses focus the field stops advertising itself, so the system prompt does not follow
  // the user onto other screens.
  const hints =
    account && (!password || focused)
      ? autofill[account]
      : { textContentType: "none" as const, autoComplete: "off" as const };
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        autoCapitalize={account === "name" ? "words" : "none"}
        keyboardType={account === "email" ? "email-address" : "default"}
        autoCorrect={account === "name"}
        textContentType={hints.textContentType}
        autoComplete={hints.autoComplete}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.input}
      />
    </View>
  );
}

export function Pair({ label, value, icons }: { label: string; value: string; icons?: readonly HealthIconName[] }) {
  return (
    <View style={styles.pair}>
      {icons ? (
        <View style={styles.healthLabel}>
          <HealthIcons icons={icons} />
          <Text style={styles.muted}>{label}</Text>
        </View>
      ) : (
        <Text style={styles.muted}>{label}</Text>
      )}
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

export function Message({ children }: { children: ReactNode }) {
  return <Text style={styles.notice}>{children}</Text>;
}
