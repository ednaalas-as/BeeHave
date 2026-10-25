import { type Device, type SavedNetwork, type WifiRequest } from "@beehave/shared";
import { sealWifiPassword } from "@beehave/shared/wifi-credential";
import { useState } from "react";
import { notCredential } from "../autofill";
import { Modal } from "./Modal";
import { requestId, useDeviceCommands } from "./useDeviceCommands";

export type WifiChoice =
  | { kind: "scanned"; ssid: string; security: string; saved?: SavedNetwork }
  | { kind: "other" };

const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Connect sheet for one network. The password is sealed to the device's key in this browser
 * before it is sent, and cleared from the page as soon as the request is submitted. */
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

  function connect() {
    if (problem || disabledReason) return;
    const id = requestId();
    const name = scanned ? scanned.ssid : ssid.trim();
    const hidden = choice.kind === "other";
    const wifi: WifiRequest = useSaved
      ? { ssid: name, profile: scanned!.saved!.id }
      : open
        ? { ssid: name, open: true, hidden }
        : { ssid: name, hidden, credential: sealWifiPassword(key!, password, id, name, (n) => crypto.getRandomValues(new Uint8Array(n))) };
    setPassword("");
    onClose();
    void send("wifi_connect", { id, wifi });
  }

  return (
    <Modal
      title={scanned ? `Connect to ${scanned.ssid}` : "Other network"}
      description={
        current
          ? `The device goes offline for a minute or two while it switches. If it cannot reach BeeHave on the new network, it returns to ${current}.`
          : "The device goes offline for a minute or two while it switches. If it cannot reach BeeHave on the new network, it returns to a saved network."
      }
      onClose={() => {
        setPassword("");
        onClose();
      }}
      footer={
        <>
          <button onClick={() => { setPassword(""); onClose(); }}>Cancel</button>
          <button className="primary" disabled={!!problem || !!disabledReason} title={problem || disabledReason} onClick={connect}>
            Connect
          </button>
        </>
      }
    >
      <form
        className="wifi-form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          connect();
        }}
      >
        {choice.kind === "other" && (
          <>
            <label>
              Network name
              <input {...notCredential} value={ssid} onChange={(event) => setSsid(event.target.value)} maxLength={32} autoCapitalize="none" spellCheck={false} autoFocus />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={open} onChange={(event) => setOpen(event.target.checked)} />
              Open network (no password)
            </label>
          </>
        )}
        {useSaved && (
          <p className="caption">
            This network is saved on the device, so it uses the saved password.{" "}
            <button type="button" className="subtle-button" onClick={() => setNewPassword(true)}>
              Use a different password
            </button>
          </p>
        )}
        {needsPassword && !enterprise && (
          <>
            <label>
              Password
              <input
                type={show ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                {...notCredential}
                spellCheck={false}
                autoCapitalize="none"
                autoFocus={choice.kind === "scanned"}
              />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={show} onChange={(event) => setShow(event.target.checked)} />
              Show password
            </label>
            <p className="caption muted">Encrypted on this device so only the BeeHave device can read it. It is never shown again or stored in readable form.</p>
          </>
        )}
        {scanned && open && !useSaved && <p className="caption muted">Open network: no password needed.</p>}
        {(problem || disabledReason) && ssid.trim() && (!needsPassword || password) && (
          <p className="form-error" role="alert">{problem || disabledReason}</p>
        )}
      </form>
    </Modal>
  );
}
