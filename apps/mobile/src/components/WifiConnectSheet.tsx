import { type Device, type SavedNetwork, type WifiRequest } from "@beehave/shared";
import { sealWifiPassword } from "@beehave/shared/wifi-credential";
import { getRandomBytes, randomUUID } from "expo-crypto";
import { useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { useDeviceCommands } from "../hooks/useDeviceCommands";
import { styles } from "../styles";
import { Button } from "./FormControls";
import { Feedback, Sheet } from "./Sheet";

export type WifiChoice =
  | { kind: "scanned"; ssid: string; security: string; saved?: SavedNetwork }
  | { kind: "other" };

const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Connect sheet for one network. The password is sealed to the device's key on this phone
 * before it is sent, and cleared as soon as the request is submitted. */
export function WifiConnectSheet({
  device,
  canControl,
  choice,
  onClose,
}: {
  device: Device;
  canControl: boolean;
  choice: WifiChoice;
  onClose: () => void;
}) {
  const { send, disabledReason } = useDeviceCommands(device, canControl);
  const network = device.health?.network;
  const key = network?.credentialKey;
  const current = network?.method === "wifi" ? network.ssid : undefined;
  const scanned = choice.kind === "scanned" ? choice : null;
  const [ssid, setSsid] = useState(scanned?.ssid ?? "");
  const [open, setOpen] = useState(scanned?.security === "open");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  // A saved network rejoins with the password already on the device, unless the farmer changes it.
  const [newPassword, setNewPassword] = useState(!scanned?.saved?.id);
  const enterprise = scanned?.security === "enterprise";
  const useSaved = !!scanned?.saved?.id && !newPassword;
  const needsPassword = !open && !useSaved;
  const problem = enterprise
    ? "Enterprise (802.1X) networks are not supported."
    : !ssid.trim() || bytes(ssid) > 32
      ? "Enter the network name (up to 32 characters)."
      : needsPassword && !key
        ? "This device's software cannot receive Wi-Fi passwords from BeeHave yet. Use nearby setup on the device."
        : needsPassword && (bytes(password) < 8 || bytes(password) > 63)
          ? "Wi-Fi passwords are 8–63 characters."
          : "";
  const close = () => {
    setPassword("");
    onClose();
  };

  function connect() {
    if (problem || disabledReason) return;
    const id = randomUUID();
    const name = scanned ? scanned.ssid : ssid.trim();
    const hidden = choice.kind === "other";
    const wifi: WifiRequest = useSaved
      ? { ssid: name, profile: scanned!.saved!.id }
      : open
        ? { ssid: name, open: true, hidden }
        : { ssid: name, hidden, credential: sealWifiPassword(key!, password, id, name, (n) => getRandomBytes(n)) };
    close();
    void send("wifi_connect", { id, wifi });
  }

  return (
    <Sheet title={scanned ? `Connect to ${scanned.ssid}` : "Other network"} subtitle={device.name} onClose={close}>
      <Text style={styles.caption}>
        The device goes offline for a minute or two while it switches. If it cannot reach BeeHave on the new network, it returns to {current ?? "a saved network"}.
      </Text>
      {choice.kind === "other" && (
        <>
          <View style={styles.field}>
            <Text style={styles.label}>Network name</Text>
            <TextInput
              accessibilityLabel="Network name"
              value={ssid}
              onChangeText={setSsid}
              maxLength={32}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              style={styles.input}
            />
          </View>
          <View style={styles.pair}>
            <Text style={styles.muted}>Open network (no password)</Text>
            <Switch value={open} onValueChange={setOpen} accessibilityLabel="Open network" />
          </View>
        </>
      )}
      {useSaved && (
        <>
          <Text style={styles.caption}>This network is saved on the device, so it uses the saved password.</Text>
          <Button title="Use a different password" onPress={() => setNewPassword(true)} />
        </>
      )}
      {needsPassword && !enterprise && (
        <>
          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              accessibilityLabel="Wi-Fi password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!show}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="none"
              autoComplete="off"
              style={styles.input}
            />
          </View>
          <View style={styles.pair}>
            <Text style={styles.muted}>Show password</Text>
            <Switch value={show} onValueChange={setShow} accessibilityLabel="Show password" />
          </View>
          <Text style={styles.caption}>Encrypted on this phone so only the BeeHave device can read it. It is never shown again or stored in readable form.</Text>
        </>
      )}
      {scanned && open && !useSaved && <Text style={styles.caption}>Open network: no password needed.</Text>}
      {!!(problem || disabledReason) && !!ssid.trim() && (!needsPassword || !!password) && (
        <Feedback tone="bad">{problem || disabledReason}</Feedback>
      )}
      <Button primary title="Connect" icon="wifi" disabled={!!problem || !!disabledReason} onPress={connect} />
      <Button title="Cancel" onPress={close} />
    </Sheet>
  );
}
