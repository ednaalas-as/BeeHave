import { setupPageUrl, type Device, type SetupLabel as Label } from "@beehave/shared";
import { useState } from "react";
import { Text, View } from "react-native";
import { apiRequest } from "../api";
import { styles } from "../styles";
import { Button, Message } from "./FormControls";

/** The Pi's setup label, as the device itself reported it: what an owner needs when the Pi has
 * fallen back to its setup hotspot (no Wi-Fi it knows is in range) or to pair it again. Shown
 * only on request. Values can be selected and copied with a long press. */
export function SetupLabel({ device }: { device: Device }) {
  const [label, setLabel] = useState<Label | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function show() {
    setBusy(true);
    setError("");
    try {
      setLabel(await apiRequest<Label>(`/devices/${encodeURIComponent(device.id)}/setup-label`));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Text style={styles.sectionTitle}>Setup label</Text>
      <Text style={styles.caption}>
        If the device cannot find a saved Wi-Fi network, it starts its own setup Wi-Fi. Join it with these details, then open {setupPageUrl} and enter the setup code. The setup code is also used to pair the device again.
      </Text>
      {label ? (
        <>
          {([["Setup Wi-Fi", label.hotspot], ["Wi-Fi password", label.hotspotPassword], ["Setup code", label.code]] as const).map(([name, value]) => (
            <View key={name} style={styles.pair}>
              <Text style={styles.muted}>{name}</Text>
              <Text selectable style={styles.value}>{value}</Text>
            </View>
          ))}
          <Text style={styles.caption}>
            Reported by the device {new Date(label.updatedAt).toLocaleString()}. Keep these private: anyone near the device with them can change its Wi-Fi.
          </Text>
          <Button title="Hide" icon="eye-off" onPress={() => setLabel(null)} />
        </>
      ) : (
        <Button title="Show setup label" icon="key" busy={busy} onPress={() => void show()} />
      )}
      {error ? <Message>{error}</Message> : null}
    </>
  );
}
