import { useState } from "react";
import { Alert, Text } from "react-native";
import { apiRequest } from "../api";
import { styles } from "../styles";
import { Button, Field } from "./FormControls";
import { SettingsBlock } from "./SettingsSection";

export function PasswordChange({ done }: { done: () => void }) {
  const [currentPassword, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  return (
    <SettingsBlock title="Security" first>
      <Field
        label="Current password"
        value={currentPassword}
        onChange={setCurrent}
        secure
        account="password"
      />
      <Field
        label="New password (12+ characters)"
        value={password}
        onChange={setPassword}
        secure
        account="newPassword"
      />
      <Field
        label="Confirm new password"
        value={confirm}
        onChange={setConfirm}
        secure
        account="newPassword"
      />
      <Button
        title="Change password and sign out"
        onPress={async () => {
          if (password !== confirm) {
            Alert.alert("Password change failed", "New passwords do not match.");
            return;
          }
          try {
            await apiRequest("/auth/password", {
              method: "POST",
              body: JSON.stringify({ currentPassword, password }),
            });
            done();
          } catch (e) {
            Alert.alert("Password change failed", (e as Error).message);
          }
        }}
      />
      <Text style={styles.caption}>Signs you out on every device.</Text>
    </SettingsBlock>
  );
}
