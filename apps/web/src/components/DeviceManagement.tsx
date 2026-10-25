import type { Device } from "@beehave/shared";
import { ArrowRightLeft, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "../api";
import { notCredential } from "../autofill";
import { ConfirmDialog } from "./Modal";

type Pending = "unpair" | "delete" | "transfer";

/** Registration actions in Advanced Settings. These act on BeeHave, not the Pi: success is the
 * API confirming the device key was revoked (or the registration removed), never assumed. */
export function DeviceManagement({
  device,
  changed,
}: {
  device: Device;
  changed: (deleted: boolean) => void;
}) {
  const { farmApi: api, farm, farms } = useWorkspace();
  // A device moves only to another farm this account administers.
  const targets = farms.filter((f) => f.role === "owner" && !f.demo && f.id !== farm.id);
  const [target, setTarget] = useState("");
  const targetFarm = targets.find((f) => f.id === target) ?? targets[0];
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  async function act(action: Pending) {
    if (pending) return;
    setPending(action);
    setMessage(null);
    try {
      await api(`/devices/${encodeURIComponent(device.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "transfer" ? { confirm: true, farm: targetFarm?.id } : { confirm: true }),
      });
      setMessage({
        ok: true,
        text:
          action === "unpair"
            ? "Disconnected. The device's access was revoked and historical data is preserved. The Pi can be paired again through nearby setup."
            : action === "transfer"
              ? `Transferred to ${targetFarm?.name}. Its earlier records stay with ${farm.name}.`
              : "Registration deleted.",
      });
      // A transferred device leaves this farm, like a deleted one.
      changed(action !== "unpair");
    } catch (error) {
      const failed = { unpair: "Disconnect failed.", delete: "Delete failed.", transfer: "Transfer failed." }[action];
      setMessage({ ok: false, text: `${failed} ${(error as Error).message}` });
    } finally {
      setPending(null);
    }
  }
  const prompts: Record<Pending, { title: string; text: string; confirm: string }> = {
    unpair: {
      title: `Disconnect ${device.name}?`,
      text: "This only removes the device from your BeeHave account: its credential is revoked. The device is not restarted, stopped or reset, and its files and Wi-Fi do not change. Existing history stays with this farm. You can pair it again later with a fresh registration.",
      confirm: "Disconnect",
    },
    delete: {
      title: `Delete the registration for ${device.name}?`,
      text: "This cannot be undone. Deletion will be refused if any historical records exist. Files on the Pi will not be touched.",
      confirm: "Delete",
    },
    transfer: {
      title: `Transfer ${device.name} to ${targetFarm?.name}?`,
      text: `Device ${device.id} will belong to ${targetFarm?.name} only, and its new data will go there. Detections, recordings and environmental records it already sent stay with ${farm.name}; they are not moved. Members of ${farm.name} lose access to the device itself.`,
      confirm: "Transfer",
    },
  };
  return (
    <>
      <div className="button-row">
        {!device.disconnectedAt ? (
          <button className="warning" disabled={!!pending} aria-busy={!!pending} onClick={() => setConfirm("unpair")}>
            <Unplug size={16} aria-hidden="true" /> {pending === "unpair" ? "Disconnecting…" : "Disconnect Device"}
          </button>
        ) : (
          <button className="warning" disabled={!!pending} aria-busy={!!pending} onClick={() => setConfirm("delete")}>
            <Trash2 size={16} aria-hidden="true" /> {pending === "delete" ? "Deleting…" : "Delete Registration"}
          </button>
        )}
      </div>
      {!device.disconnectedAt && targetFarm && (
        <div className="button-row">
          <label>
            Transfer to farm
            <select {...notCredential} value={targetFarm.id} disabled={!!pending} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <button disabled={!!pending} aria-busy={pending === "transfer"} onClick={() => setConfirm("transfer")}>
            <ArrowRightLeft size={16} aria-hidden="true" /> {pending === "transfer" ? "Transferring…" : "Transfer Device"}
          </button>
        </div>
      )}
      {device.disconnectedAt && !message && (
        <p className="caption muted">
          Disconnected. History remains with this farm. Deletion is permitted only when no historical records exist.
        </p>
      )}
      {message && (
        <p className={message.ok ? "feedback good" : "form-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={prompts[confirm].title}
          text={prompts[confirm].text}
          confirmLabel={prompts[confirm].confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void act(confirm);
          }}
        />
      )}
    </>
  );
}
