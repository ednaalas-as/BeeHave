import { type Device, type DeviceClaim } from "@beehave/shared";
import {
  localRequest,
  pairNearby,
  type NearbyPi,
} from "@beehave/shared/nearby";
import { Check, Copy, Radio } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useWorkspace } from "../api";
import { notCredential } from "../autofill";
import { Modal } from "./Modal";

// pair → confirm and claim → claim-confirm show the device and the selected farm before linking.
type Step = "search" | "pair" | "confirm" | "claim" | "claim-confirm" | "done" | "manual" | "manual-done";

// Web discovery looks up the Pi’s printed .local setup name; browsers cannot browse Bonjour.
export async function findNearby(address: string) {
  const url = `http://${address.trim()}:8765`;
  const pi = await localRequest<NearbyPi>(url, "/info");
  return { ...pi, url };
}

export function RegisterDeviceModal({
  farm,
  initial,
  isRegistered,
  found,
  onClose,
  registered,
}: {
  farm: string;
  initial: NearbyPi | null;
  isRegistered: (pi: NearbyPi) => boolean;
  found: (devices: NearbyPi[]) => void;
  onClose: () => void;
  registered: () => void;
}) {
  // The device joins the selected farm.
  const { farmApi: api } = useWorkspace();
  const [step, setStep] = useState<Step>(initial ? "pair" : "search");
  const [address, setAddress] = useState("beehave-pi.local");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<NearbyPi[] | null>(initial ? [initial] : null);
  const [searchError, setSearchError] = useState("");
  const [selected, setSelected] = useState<NearbyPi | null>(initial);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState<{ id: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [claim, setClaim] = useState<DeviceClaim | null>(null);

  async function search() {
    setSearching(true);
    setSearchError("");
    setResults(null);
    try {
      const pi = await findNearby(address);
      setResults([pi]);
      found([pi]);
    } catch (failure) {
      setResults([]);
      found([]);
      setSearchError((failure as Error).message);
    } finally {
      setSearching(false);
    }
  }
  useEffect(() => {
    if (!initial) void search();
    // Search once when the dialog opens; later searches are explicit.
  }, []);

  async function pair() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      await pairNearby(api, selected, code, name, location);
      setCode("");
      registered();
      setStep("done");
    } catch (failure) {
      console.error("Nearby registration failed", failure);
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Looks up the provisioned device for this pairing code; nothing is linked yet.
  async function lookup(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setClaim(await api<DeviceClaim>("/device-claims/lookup", { method: "POST", body: JSON.stringify({ code: pairingCode }) }));
      setStep("claim-confirm");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function claimDevice() {
    if (!claim || busy) return;
    setBusy(true);
    setError("");
    try {
      await api<Device>("/device-claims", {
        method: "POST",
        body: JSON.stringify({ code: pairingCode, deviceUid: claim.deviceUid, name, location, confirm: true }),
      });
      setPairingCode("");
      registered();
      setStep("done");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function manual(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ device: Device; key: string }>("/devices", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
      });
      setKey({ id: result.device.id, key: result.key });
      setCopied(false);
      registered();
      setStep("manual-done");
    } catch (e) {
      const failure = e as Error & { status?: number };
      setError(
        failure.status === 403
          ? "Only an administrator of this farm can register devices. Sample farms cannot register devices."
          : failure.status === 400
            ? `Check the device name and installation label. ${failure.message.replace(/\bname:/g, "Device name:").replace(/\blocation:/g, "Installation label:")}`
            : failure instanceof TypeError
              ? "Could not confirm registration with the BeeHave server. Check your network connection and the device list before trying again."
              : failure.message,
      );
    } finally {
      setBusy(false);
    }
  }

  const available = (results ?? []).filter((pi) => !isRegistered(pi));
  const already = (results ?? []).filter(isRegistered);
  // Closing mid-registration would hide its outcome.
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal
      title="Register Edge Device"
      description={`Select an available BeeHave Edge Device to connect it to ${farm}.`}
      onClose={close}
      footer={
        step === "done" || step === "manual-done" ? (
          <button className="primary" onClick={onClose}>
            {step === "manual-done" ? "I’ve saved the key" : "Done"}
          </button>
        ) : (
          <button onClick={close} disabled={busy}>
            Cancel
          </button>
        )
      }
    >
      {step === "search" && (
        <>
          {searching ? (
            <p className="feedback" role="status">Searching for nearby BeeHave devices…</p>
          ) : results && available.length ? (
            <div className="choice-list">
              {available.map((pi) => (
                <div className="available-device" key={pi.id}>
                  <Radio size={18} />
                  <div>
                    <strong>{pi.name}</strong>
                    <small>Available nearby · {pi.url.replace(/^http:\/\/|:8765$/g, "")}</small>
                  </div>
                  <button
                    className="primary"
                    onClick={() => {
                      setSelected(pi);
                      setStep("pair");
                      setError("");
                    }}
                  >
                    Select
                  </button>
                </div>
              ))}
            </div>
          ) : results ? (
            <div className="feedback warning" role="status">
              <strong>No available BeeHave devices were found.</strong>
              {already.length > 0 && (
                <p>{already.map((pi) => pi.name).join(", ")} is already registered to this farm.</p>
              )}
              <ul>
                <li>Check that the Edge Device is powered on and its BeeHave setup service is running.</li>
                <li>Connect this computer to the same Wi-Fi network as the device.</li>
                <li>Check that the setup name below matches the .local name on the device’s label.</li>
                <li>Allow local network access if your browser asks. If this browser blocks local setup, use the BeeHave mobile app.</li>
              </ul>
              {searchError && !already.length && <p className="caption muted">Details: {searchError}</p>}
            </div>
          ) : null}
          <form
            className="device-form"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <label>
              Device setup name
              <input
                {...notCredential}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
                disabled={searching}
              />
              <span className="caption muted">The .local name printed on the device’s label; no IP address is needed.</span>
            </label>
            <button disabled={searching}>{results ? "Search Again" : "Search"}</button>
          </form>
          <button
            className="text-button"
            onClick={() => {
              setStep("claim");
              setError("");
            }}
          >
            Use a pairing code
          </button>
          <button
            className="text-button"
            onClick={() => {
              setStep("manual");
              setError("");
            }}
          >
            Register without nearby setup
          </button>
        </>
      )}
      {step === "pair" && selected && (
        <form
          className="device-form"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            setStep("confirm");
          }}
        >
          <div className="choice-list">
            <div className="available-device">
              <Radio size={18} />
              <div>
                <strong>{selected.name}</strong>
                <small>Selected · Available nearby</small>
              </div>
            </div>
          </div>
          <label>
            Device setup code
            <input
              type="password"
              {...notCredential}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              disabled={busy}
            />
            <span className="caption muted">The 32-character code on the device’s setup label. For a device this account paired before, it is under Advanced settings → Setup label. It confirms you are near this device.</span>
          </label>
          <label>
            Device name
            <input {...notCredential} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={100} required disabled={busy} placeholder="Hive 1 Monitor" />
          </label>
          <label>
            Installation label
            <input {...notCredential} value={location} onChange={(e) => setLocation(e.target.value)} minLength={2} maxLength={100} required disabled={busy} placeholder="North apiary · Hive 1" />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="button-row">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("search");
                setError("");
              }}
            >
              Back
            </button>
            <button className="primary" disabled={busy}>
              Continue
            </button>
          </div>
        </form>
      )}
      {step === "confirm" && selected && (
        <LinkConfirmation
          identifier={selected.id}
          label={selected.name}
          farm={farm}
          name={name}
          location={location}
          busy={busy}
          error={error}
          back={() => { setStep("pair"); setError(""); }}
          confirm={() => void pair()}
        />
      )}
      {step === "claim" && (
        <form className="device-form" onSubmit={(e) => void lookup(e)}>
          <p className="caption muted">
            Enter the pairing code from the label of a provisioned BeeHave device. You will see which device it is before anything is linked.
          </p>
          <label>
            Pairing code
            <input {...notCredential} value={pairingCode} onChange={(e) => setPairingCode(e.target.value)} required minLength={6} maxLength={40} placeholder="ABCDE-23456" autoCapitalize="characters" disabled={busy} />
          </label>
          <label>
            Device name
            <input {...notCredential} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={100} required disabled={busy} placeholder="Hive 1 Monitor" />
          </label>
          <label>
            Installation label
            <input {...notCredential} value={location} onChange={(e) => setLocation(e.target.value)} minLength={2} maxLength={100} required disabled={busy} placeholder="North apiary · Hive 1" />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => { setStep("search"); setError(""); }}>
              Back
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </div>
        </form>
      )}
      {step === "claim-confirm" && claim && (
        <LinkConfirmation
          identifier={claim.deviceUid}
          farm={claim.farm}
          name={name}
          location={location}
          busy={busy}
          error={error}
          back={() => { setStep("claim"); setError(""); }}
          confirm={() => void claimDevice()}
        />
      )}
      {step === "done" && (
        <div className="feedback good" role="status">
          <strong>Device registered successfully.</strong>
          <p>It now appears under Registered devices. Its status stays unknown until it sends its first report; monitoring uploads are configured separately.</p>
        </div>
      )}
      {step === "manual" && (
        <form className="device-form" onSubmit={(e) => void manual(e)}>
          <p className="caption muted">
            Use this when nearby setup is not possible. BeeHave creates a device key that you configure on the Pi yourself. No existing device ID or code is needed.
          </p>
          <label>
            Device name
            <input {...notCredential} name="name" required minLength={2} maxLength={100} placeholder="Hive 1 Monitor" disabled={busy} />
          </label>
          <label>
            Installation label
            <input {...notCredential} name="location" required minLength={2} maxLength={100} placeholder="North apiary · Hive 1" disabled={busy} />
          </label>
          {busy && <p className="feedback" role="status">Registering device…</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => { setStep("search"); setError(""); }}>
              Back
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Registering…" : "Register Device"}
            </button>
          </div>
        </form>
      )}
      {step === "manual-done" && key && (
        <>
          <div className="feedback good" role="status">
            <strong>Device registered successfully.</strong>
            <p>Save the device ID and key now. The key is shown once; store it securely on the Pi, not in web or mobile code.</p>
          </div>
          <p className="mono">Device ID: {key.id}</p>
          <code className="device-key">{key.key}</code>
          <p className="caption muted">
            If using the provided uploader, set BEEHAVE_DEVICE_KEY to this key and BEEHAVE_API_URL to your reachable backend address in the Pi’s environment. See docs/EDGE_INTEGRATION.md.
          </p>
          <div className="button-row">
            <button
              onClick={async () => {
                setError("");
                try {
                  await navigator.clipboard.writeText(key.key);
                  setCopied(true);
                } catch {
                  setError("Copy failed. Select and copy the credential manually.");
                }
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy key"}
            </button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </>
      )}
    </Modal>
  );
}

// The last step before an existing device is linked: which device, and which farm it joins.
function LinkConfirmation({ identifier, label, farm, name, location, busy, error, back, confirm }: {
  identifier: string;
  label?: string;
  farm: string;
  name: string;
  location: string;
  busy: boolean;
  error: string;
  back: () => void;
  confirm: () => void;
}) {
  return (
    <div className="device-form">
      <p className="caption muted">Check the device and farm before linking. The device can belong to only one farm at a time.</p>
      <dl>
        <dt>Device identifier</dt>
        <dd className="mono">{identifier}</dd>
        {label && (
          <>
            <dt>Found as</dt>
            <dd>{label}</dd>
          </>
        )}
        <dt>Selected farm</dt>
        <dd>{farm}</dd>
        <dt>Device name</dt>
        <dd>{name}</dd>
        <dt>Installation label</dt>
        <dd>{location}</dd>
      </dl>
      {busy && <p className="feedback" role="status">Registering device…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="button-row">
        <button type="button" disabled={busy} onClick={back}>
          Back
        </button>
        <button className="primary" disabled={busy} onClick={confirm}>
          {busy ? "Registering…" : `Link to ${farm}`}
        </button>
      </div>
    </div>
  );
}
