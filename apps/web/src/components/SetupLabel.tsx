import { setupPageUrl, type Device, type SetupLabel as Label } from "@beehave/shared";
import { Check, Copy, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "../api";

/** The Pi's setup label, as the device itself reported it: what an owner needs when the Pi has
 * fallen back to its setup hotspot (no Wi-Fi it knows is in range) or to pair it again. Shown
 * only on request and hidden again when the dialog closes. */
export function SetupLabel({ device }: { device: Device }) {
  const { farmApi: api } = useWorkspace();
  const [label, setLabel] = useState<Label | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  async function show() {
    setBusy(true);
    setError("");
    try {
      setLabel(await api<Label>(`/devices/${encodeURIComponent(device.id)}/setup-label`));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(name: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(name);
    } catch {
      setError("Copy failed. Select and copy it manually.");
    }
  }
  const rows: [string, string][] = label
    ? [["Setup Wi-Fi", label.hotspot], ["Wi-Fi password", label.hotspotPassword], ["Setup code", label.code]]
    : [];
  return (
    <section className="advanced-section">
      <h3>Setup label</h3>
      <span className="caption muted">
        If the device cannot find a saved Wi-Fi network, it starts its own setup Wi-Fi. Join it with these details,
        then open {setupPageUrl} and enter the setup code. The setup code is also used to pair the device again.
      </span>
      {label ? (
        <>
          <dl className="setup-label">
            {rows.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>
                  <code className="device-key">{value}</code>
                  <button type="button" className="text-button" onClick={() => void copy(name, value)} aria-label={`Copy ${name}`}>
                    {copied === name ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                    {copied === name ? "Copied" : "Copy"}
                  </button>
                </dd>
              </div>
            ))}
          </dl>
          <span className="caption muted">
            Reported by the device {new Date(label.updatedAt).toLocaleString()}. Keep these private: anyone near the device with them can change its Wi-Fi.
          </span>
          <div className="button-row">
            <button type="button" onClick={() => { setLabel(null); setCopied(""); }}>
              <EyeOff size={16} aria-hidden="true" /> Hide
            </button>
          </div>
        </>
      ) : (
        <div className="button-row">
          <button type="button" disabled={busy} aria-busy={busy} onClick={() => void show()}>
            <KeyRound size={16} aria-hidden="true" /> {busy ? "Loading…" : "Show setup label"}
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
