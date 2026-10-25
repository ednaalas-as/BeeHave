import { useEffect, useState } from "react";
import { Linking, Switch, Text, View } from "react-native";
import { registerPush, setPushEnabled, type PushStatus } from "../push";
import { styles } from "../styles";
import { Button } from "./FormControls";
import { SettingsBlock } from "./SettingsSection";
import { Feedback } from "./Sheet";

const explanation: Record<PushStatus, string> = {
  on: "This phone gets a notification when an Edge Device comes online or someone asks for access to your farm.",
  off: "Get a notification when an Edge Device comes online or someone asks for access to your farm.",
  denied: "Notifications for BeeHave are turned off in your phone's settings.",
  unconfigured: "Push notifications are not set up for this build of BeeHave yet.",
  unavailable: "This phone could not register for notifications. Check the network connection and try again.",
};

/** Push notifications for this phone and account. A refusal in the phone's settings is shown with
 * a way there; BeeHave never asks again by itself. */
export function NotificationSettings({ accountId }: { accountId: string }) {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void registerPush(accountId, false).then((next) => current && setStatus(next), () => current && setStatus("unavailable"));
    return () => { current = false; };
  }, [accountId]);
  async function change(on: boolean) {
    setBusy(true);
    try {
      setStatus(await setPushEnabled(accountId, on));
    } catch {
      setStatus("unavailable");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsBlock title="Notifications" first>
      {status === null ? (
        <Text style={styles.muted}>Checking this phone…</Text>
      ) : (
        <>
          {(status === "on" || status === "off" || status === "unavailable") && (
            <View style={styles.row}>
              <Text style={[styles.body, styles.grow]}>Push notifications</Text>
              <Switch
                value={status === "on"}
                disabled={busy}
                onValueChange={(on) => void change(on)}
                accessibilityLabel="Push notifications on this phone"
              />
            </View>
          )}
          {status === "unavailable" ? (
            <Feedback tone="warning">{explanation.unavailable}</Feedback>
          ) : (
            <Text style={styles.caption}>{explanation[status]}</Text>
          )}
          {status === "denied" && <Button title="Open phone settings" onPress={() => void Linking.openSettings()} />}
        </>
      )}
    </SettingsBlock>
  );
}
