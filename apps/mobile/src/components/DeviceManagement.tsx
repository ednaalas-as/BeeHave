import type { Device } from "@beehave/shared";
import { useState } from "react";
import { Alert } from "react-native";
import { apiRequest } from "../api";
import { useFarm } from "../farm";
import { Button, Message } from "./FormControls";
import { SelectionSheet } from "./SelectionSheet";

/** Registration actions in Advanced settings. These act on BeeHave, not the Pi: success is the
 * API confirming the device key was revoked (or the registration removed), never assumed. */
export function DeviceManagement({
  device,
  changed,
}: {
  device: Device;
  changed: (deleted: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const action = device.disconnectedAt ? "delete" : "unpair";
  const { farm, farms } = useFarm();
  // A device moves only to another farm this account administers.
  const targets = farms.filter((f) => f.role === "owner" && !f.demo && f.id !== farm.id);
  const [choosing, setChoosing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  // Chosen in the sheet, then confirmed inline (no alert over a closing sheet).
  const [target, setTarget] = useState<string | null>(null);
  const destination = targets.find((f) => f.id === target);
  async function transfer() {
    if (!destination) return;
    setTransferring(true);
    setMessage("");
    try {
      await apiRequest(`/devices/${encodeURIComponent(device.id)}/transfer`, {
        method: "POST",
        body: JSON.stringify({ farm: destination.id, confirm: true }),
      });
      setMessage(`Transferred to ${destination.name}. Its earlier records stay with ${farm.name}.`);
      // A transferred device leaves this farm, like a deleted one.
      setTarget(null);
      changed(true);
    } catch (error) {
      setMessage(`Transfer failed. ${(error as Error).message}`);
    } finally {
      setTransferring(false);
    }
  }
  async function submit() {
    setPending(true);
    setMessage("");
    try {
      await apiRequest(`/devices/${encodeURIComponent(device.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      setMessage(
        action === "unpair"
          ? "Disconnected. The device's access was revoked and historical data is preserved. The Pi can be paired again through nearby setup."
          : "Registration deleted.",
      );
      changed(action === "delete");
    } catch (error) {
      setMessage(`${action === "unpair" ? "Disconnect failed." : "Delete failed."} ${(error as Error).message}`);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        warning
        busy={pending}
        icon={action === "unpair" ? "link-2" : "trash-2"}
        title={
          pending ? (action === "unpair" ? "Disconnecting…" : "Deleting…")
          : action === "unpair" ? "Disconnect Device" : "Delete Registration"
        }
        onPress={() =>
          Alert.alert(
            action === "unpair"
              ? `Disconnect ${device.name}?`
              : `Delete ${device.name}?`,
            action === "unpair"
              ? "Its device credential will be revoked. History stays with this farm. Pi files and Wi-Fi remain unchanged. It can be paired again later with a fresh registration."
              : "Permanently delete this disconnected registration? This cannot be undone. Deletion will be refused if any historical records exist. Pi files will not be touched.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: action === "unpair" ? "Disconnect" : "Delete permanently",
                style: "destructive",
                onPress: () => {
                  void submit();
                },
              },
            ],
          )
        }
      />
      {!device.disconnectedAt && targets.length > 0 && (
        <>
          <Button
            busy={transferring}
            disabled={pending || transferring}
            icon="repeat"
            title={transferring ? "Transferring…" : "Transfer to another farm"}
            onPress={() => setChoosing(true)}
          />
          <SelectionSheet
            title="Transfer to farm"
            visible={choosing}
            selected=""
            options={targets.map((f) => ({ label: f.name, value: f.id }))}
            onSelect={setTarget}
            onClose={() => setChoosing(false)}
          />
          {destination && (
            <>
              <Message>
                {`Device ${device.id} will belong to ${destination.name} only, and its new data will go there. Detections, recordings and environmental records it already sent stay with ${farm.name}; they are not moved.`}
              </Message>
              <Button warning busy={transferring} title={`Confirm transfer to ${destination.name}`} onPress={() => void transfer()} />
              <Button title="Cancel transfer" disabled={transferring} onPress={() => setTarget(null)} />
            </>
          )}
        </>
      )}
      {!!device.disconnectedAt && (
        <Message>
          Disconnected. History remains with this farm. Deletion requires no
          historical records.
        </Message>
      )}
      {!!message && <Message>{message}</Message>}
    </>
  );
}
