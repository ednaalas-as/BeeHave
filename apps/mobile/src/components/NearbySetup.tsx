import { getRandomBytes } from "expo-crypto";
import { type Device, type DeviceClaim } from "@beehave/shared";
import {
  localRequest,
  pairNearby,
  setupCommand,
  type NearbyPi,
} from "@beehave/shared/nearby";
import { useEffect, useRef, useState } from "react";
import { AppState, NativeModules, Text, View } from "react-native";
import Zeroconf from "react-native-zeroconf";
import { useFarm } from "../farm";
import { styles } from "../styles";
import { Button, Card, Field, Pair } from "./FormControls";
import { Feedback, Sheet } from "./Sheet";

// pair → confirm and claim → claim-confirm show the device and the selected farm before linking.
type Step = "search" | "pair" | "confirm" | "claim" | "claim-confirm" | "done" | "manual" | "manual-done";

export function RegisterDevice({
  initial,
  isRegistered,
  found,
  registered,
  onClose,
}: {
  initial: NearbyPi | null;
  isRegistered: (pi: NearbyPi) => boolean;
  found: (devices: NearbyPi[]) => void;
  registered: () => void;
  onClose: () => void;
}) {
  const discovery = useRef<Zeroconf | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The device joins the selected farm; only its owners reach this screen.
  const { farm, farmApi: apiRequest } = useFarm();
  const [step, setStep] = useState<Step>(initial ? "pair" : "search");
  const [devices, setDevices] = useState<NearbyPi[]>(initial ? [initial] : []);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(!!initial);
  const [selected, setSelected] = useState<NearbyPi | null>(initial);
  const [address, setAddress] = useState("beehave-pi.local");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [wifi, setWifi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [claim, setClaim] = useState<DeviceClaim | null>(null);
  const stop = () => {
    discovery.current?.stop();
    if (timer.current) clearTimeout(timer.current);
    setSearching(false);
  };
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") stop();
    });
    if (!initial) void scan();
    return () => {
      stop();
      discovery.current?.removeAllListeners();
      discovery.current?.removeDeviceListeners();
      discovery.current = null;
      sub.remove();
    };
    // Search once when the sheet opens; later searches are explicit.
  }, []);
  const remember = (pi: NearbyPi) =>
    setDevices((previous) => {
      const next = [...previous.filter((item) => item.url !== pi.url), pi];
      found(next);
      return next;
    });
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function scan() {
    setDevices([]);
    found([]);
    setError("");
    setMessage("");
    if (!NativeModules.RNZeroconf) {
      setSearched(true);
      setMessage("Automatic discovery needs the installed BeeHave app; Expo Go does not include it. Search by the device’s printed setup name below.");
      return;
    }
    discovery.current?.stop();
    discovery.current?.removeAllListeners();
    discovery.current?.removeDeviceListeners();
    if (timer.current) clearTimeout(timer.current);
    const browser = new Zeroconf();
    discovery.current = browser;
    setSearching(true);
    browser.on("resolved", (service) => {
      const host = service.host.replace(/\.$/, "").toLowerCase();
      if (service.port !== 8765 || !/^[a-z0-9-]+\.local$/.test(host)) return;
      const url = `http://${host}:8765`;
      // The /info identity matches the one stored at pairing, so registered devices can be hidden.
      void localRequest<NearbyPi>(url, "/info")
        .then((info) => remember({ ...info, url }))
        .catch(() => remember({ id: service.fullName, name: service.name, url }));
    });
    browser.on("error", () => {
      stop();
      setSearched(true);
      setError("Discovery could not finish. Check local-network permission and make sure you share the device’s Wi-Fi.");
    });
    if ((await browser.checkLocalNetworkAccess({ type: "beehave", protocol: "tcp" })) === "denied") {
      stop();
      setSearched(true);
      setError("Allow BeeHave local-network access in system settings to find your device.");
      return;
    }
    if (discovery.current !== browser || AppState.currentState !== "active") return;
    browser.scan({ type: "beehave", protocol: "tcp", domain: "local." });
    timer.current = setTimeout(() => {
      browser.stop();
      setSearching(false);
      setSearched(true);
    }, 10000);
  }
  const available = devices.filter((pi) => !isRegistered(pi));
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Sheet title="Register Edge Device" subtitle={`Select an available BeeHave Edge Device to connect it to ${farm.name}.`} onClose={close}>
      {step === "search" && (
        <>
          {searching ? (
            <Feedback tone="neutral">Searching for nearby BeeHave devices…</Feedback>
          ) : available.length ? (
            available.map((pi) => (
              <Card key={pi.url}>
                <View style={styles.row}>
                  <View style={styles.grow}>
                    <Text style={styles.body}>{pi.name}</Text>
                    <Text style={styles.caption}>Available nearby</Text>
                  </View>
                  <Button
                    primary
                    title="Select"
                    onPress={() => {
                      setSelected(pi);
                      setWifi(false);
                      setStep("pair");
                      setError("");
                    }}
                  />
                </View>
              </Card>
            ))
          ) : searched ? (
            <Feedback tone="warning">
              {"No available BeeHave devices were found.\n• Check that the Edge Device is powered on and BeeHave setup is running.\n• Connect this phone to the same Wi-Fi as the device. If the device has no Wi-Fi yet, join its BeeHave setup hotspot from the printed label.\n• Allow local network access for BeeHave if asked."}
            </Feedback>
          ) : null}
          {!!message && <Feedback tone="neutral">{message}</Feedback>}
          {!!error && <Feedback tone="bad">{error}</Feedback>}
          <Button title="Search Again" disabled={busy || searching} onPress={() => void scan()} />
          <Field label="Device setup name (.local)" value={address} onChange={setAddress} />
          <Button
            title={busy ? "Searching…" : "Search by setup name"}
            disabled={busy || searching}
            onPress={() =>
              void run(async () => {
                const url = `http://${address.trim()}:8765`;
                const pi = { ...(await localRequest<NearbyPi>(url, "/info")), url };
                if (isRegistered(pi)) {
                  setSearched(true);
                  setMessage(`${pi.name} is already registered to this farm.`);
                  return;
                }
                remember(pi);
                setSearched(true);
              })
            }
          />
          <Button
            title="Use a pairing code"
            disabled={busy}
            onPress={() => {
              stop();
              setStep("claim");
              setError("");
            }}
          />
          <Button
            title="Register without nearby setup"
            disabled={busy}
            onPress={() => {
              stop();
              setStep("manual");
              setError("");
            }}
          />
        </>
      )}
      {step === "pair" && selected && (
        <>
          <Card>
            <Text style={styles.body}>{selected.name}</Text>
            <Text style={styles.caption}>Selected · Available nearby</Text>
          </Card>
          <Field label="Device setup code (from its label)" value={code} onChange={setCode} secure />
          <Button title={wifi ? "Back to registration" : "Set up the device’s Wi-Fi"} disabled={busy} onPress={() => setWifi(!wifi)} />
          {wifi ? (
            <>
              <Field label="Wi-Fi network name" value={ssid} onChange={setSsid} />
              <Field label="Wi-Fi password" value={password} onChange={setPassword} secure />
              <Text style={styles.caption}>
                WPA/WPA2 personal networks only. The device will switch networks; reconnect this phone to that Wi-Fi afterward.
              </Text>
              <Button
                title={busy ? "Connecting…" : "Connect device to Wi-Fi"}
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const result = await setupCommand<{ message: string }>(selected.url, code, { action: "wifi", ssid, password }, getRandomBytes);
                    setPassword("");
                    setMessage(result.message);
                  })
                }
              />
              <Button
                title="Check Wi-Fi setup"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const result = await setupCommand<{ wifi: { state?: string; message?: string } }>(selected.url, code, { action: "status" }, getRandomBytes);
                    setMessage(result.wifi.message ?? `Wi-Fi setup: ${result.wifi.state ?? "not started"}.`);
                  })
                }
              />
            </>
          ) : (
            <>
              <Field label="Device name" value={name} onChange={setName} />
              <Field label="Installation label" value={location} onChange={setLocation} />
              <Text style={styles.caption}>
                Links the device to your current farm. Monitoring uploads are configured separately.
              </Text>
              <Button
                primary
                title="Continue"
                disabled={busy}
                onPress={() => {
                  setError("");
                  setStep("confirm");
                }}
              />
            </>
          )}
          {!!message && <Feedback tone="neutral">{message}</Feedback>}
          {!!error && <Feedback tone="bad">{error}</Feedback>}
          <Button title="Back" disabled={busy} onPress={() => { setStep("search"); setError(""); setMessage(""); }} />
        </>
      )}
      {step === "confirm" && selected && (
        <LinkConfirmation
          identifier={selected.id}
          label={selected.name}
          farm={farm.name}
          name={name}
          location={location}
          busy={busy}
          error={error}
          back={() => { setStep("pair"); setError(""); }}
          confirm={() =>
            void run(async () => {
              await pairNearby(apiRequest, selected, code, name, location, getRandomBytes);
              setCode("");
              registered();
              setStep("done");
            })
          }
        />
      )}
      {step === "claim" && (
        <>
          <Text style={styles.caption}>
            Enter the pairing code from the label of a provisioned BeeHave device. You will see which device it is before anything is linked.
          </Text>
          <Field label="Pairing code" value={pairingCode} onChange={setPairingCode} />
          <Field label="Device name" value={name} onChange={setName} />
          <Field label="Installation label" value={location} onChange={setLocation} />
          {!!error && <Feedback tone="bad">{error}</Feedback>}
          <Button
            primary
            title={busy ? "Checking…" : "Continue"}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                setClaim(await apiRequest<DeviceClaim>("/device-claims/lookup", { method: "POST", body: JSON.stringify({ code: pairingCode }) }));
                setStep("claim-confirm");
              })
            }
          />
          <Button title="Back" disabled={busy} onPress={() => { setStep("search"); setError(""); }} />
        </>
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
          confirm={() =>
            void run(async () => {
              await apiRequest<Device>("/device-claims", {
                method: "POST",
                body: JSON.stringify({ code: pairingCode, deviceUid: claim.deviceUid, name, location, confirm: true }),
              });
              setPairingCode("");
              registered();
              setStep("done");
            })
          }
        />
      )}
      {step === "done" && (
        <>
          <Feedback tone="good">
            Device registered successfully. It now appears under Registered devices. Its status stays unknown until it sends its first report.
          </Feedback>
          <Button primary title="Done" onPress={onClose} />
        </>
      )}
      {step === "manual" && (
        <>
          <Text style={styles.caption}>
            Use this when nearby setup is not possible. BeeHave creates a device key that you configure on the Pi yourself. No existing device ID or code is needed.
          </Text>
          <Field label="Device name" value={name} onChange={setName} />
          <Text style={styles.caption}>A recognizable name, such as Hive 1 Monitor. Use 2–100 characters.</Text>
          <Field label="Installation label" value={location} onChange={setLocation} />
          <Text style={styles.caption}>The hive or monitoring location, such as North apiary · Hive 1.</Text>
          {busy && <Feedback tone="neutral">Registering device…</Feedback>}
          {!!error && <Feedback tone="bad">{error}</Feedback>}
          <Button
            primary
            title={busy ? "Registering…" : "Register Device"}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                try {
                  const result = await apiRequest<{ device: Device; key: string }>("/devices", {
                    method: "POST",
                    body: JSON.stringify({ name, location }),
                  });
                  setKey(`Device: ${result.device.id}\nKey: ${result.key}`);
                  registered();
                  setStep("manual-done");
                } catch (e) {
                  const failure = e as Error & { status?: number };
                  throw new Error(
                    failure.status === 403
                      ? "Register devices with an administrator account on a private farm. Sample farms cannot register devices."
                      : failure.status === 400
                        ? `Check the device name and installation label. ${failure.message.replace(/\bname:/g, "Device name:").replace(/\blocation:/g, "Installation label:")}`
                        : failure instanceof TypeError
                          ? "Could not confirm registration with the BeeHave server. Check your network connection and the device list before trying again."
                          : failure.message,
                  );
                }
              })
            }
          />
          <Button title="Back" disabled={busy} onPress={() => { setStep("search"); setError(""); }} />
        </>
      )}
      {step === "manual-done" && (
        <>
          <Feedback tone="good">Device registered successfully.</Feedback>
          <Text selectable style={styles.notice}>{key}</Text>
          <Text style={styles.caption}>
            Save the device ID and key now. The key is shown once; store it securely on the Pi, not in web or mobile code. If using the provided uploader, set BEEHAVE_DEVICE_KEY to this key and BEEHAVE_API_URL to your reachable backend address. See docs/EDGE_INTEGRATION.md.
          </Text>
          <Button primary title="I saved the credential" onPress={onClose} />
        </>
      )}
    </Sheet>
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
    <>
      <Text style={styles.caption}>Check the device and farm before linking. The device can belong to only one farm at a time.</Text>
      <Card>
        <Pair label="Device identifier" value={identifier} />
        {!!label && <Pair label="Found as" value={label} />}
        <Pair label="Selected farm" value={farm} />
        <Pair label="Device name" value={name} />
        <Pair label="Installation label" value={location} />
      </Card>
      {busy && <Feedback tone="neutral">Registering device…</Feedback>}
      {!!error && <Feedback tone="bad">{error}</Feedback>}
      <Button primary title={busy ? "Registering…" : `Link to ${farm}`} disabled={busy} onPress={confirm} />
      <Button title="Back" disabled={busy} onPress={back} />
    </>
  );
}
