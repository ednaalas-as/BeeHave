import { AdvancedSettings } from "../components/AdvancedSettings";
import { RegisterDeviceModal } from "../components/RegisterDeviceModal";
import { healthFresh, type Device } from "@beehave/shared";
import { type NearbyPi } from "@beehave/shared/nearby";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Plus, Radio, Settings2 } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { useWorkspace } from "../api";
import { DeviceCard } from "../components/DeviceCard";
import { Empty, Failure, Loading, PageHeading } from "../ui";

export function Devices() {
  const { farm, owner, farmApi: api, refresh, device: selectedDevice, setDevice } = useWorkspace();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["devices", farm.id],
    queryFn: () => api<Device[]>("/devices"),
    // While a device is offline or its report is stale, check often so a reconnect is reflected
    // promptly from the device's real state.
    refetchInterval: (q) =>
      q.state.data?.some((device) => !device.disconnectedAt && !healthFresh(device))
        ? 10_000
        : refresh ? refresh * 1000 : false,
  });
  // Freshness depends on the clock: re-evaluate so a device that stops reporting turns Unknown.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, []);
  const admin = owner;
  const [registering, setRegistering] = useState<{ initial: NearbyPi | null } | null>(null);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyPi[]>([]);
  // A discovered Pi counts as registered only while its pairing is active in this farm.
  const isRegistered = (pi: NearbyPi) =>
    !!query.data?.some((device) => device.setupId === pi.id && !device.disconnectedAt);
  const available = nearby.filter((pi) => !isRegistered(pi));
  const advancedDevice = query.data?.find((device) => device.id === advanced);
  const refreshDevices = () => void cache.invalidateQueries({ queryKey: ["devices", farm.id] });
  // The API resolves the account's permission per device; older responses fall back to the farm role.
  const controls = (device: Device) => (device.access ? device.access === "administrator" : admin);
  // A selected Edge Device narrows the page to that device; otherwise every device of this farm.
  const shown = query.data?.filter((device) => !selectedDevice || device.id === selectedDevice) ?? [];

  return (
    <>
      <PageHeading
        eyebrow="MONITORING DEVICES"
        title="Edge device"
        description="Check that your BeeHave devices are monitoring, connected, and syncing."
        actions={
          admin && (
            <button className="primary" onClick={() => setRegistering({ initial: null })}>
              <Plus size={16} /> Register Device
            </button>
          )
        }
      />
      <div className="device-section-title">
        <h2>Registered devices</h2>
        <span className="caption muted">Linked to {farm.name}</span>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => query.refetch()} />
      ) : shown.length ? (
        shown.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            canControl={controls(device)}
            headerAction={
              /* Advanced Settings hold device controls, network and service administration: administrators only. */
              controls(device) && (
                <button className="subtle-button" onClick={() => setAdvanced(device.id)}>
                  <Settings2 size={14} /> Advanced Settings
                </button>
              )
            }
          />
        ))
      ) : (
        <section className="card">
          <Empty
            title="No edge device registered"
            text={admin ? "Select Register Device to connect your first BeeHave device." : "A farm administrator can register a BeeHave device."}
          />
        </section>
      )}
      {admin && (
        <>
          <div className="device-section-title">
            <h2>Available devices</h2>
            <span className="caption muted">Nearby devices to register</span>
          </div>
          <section className="card">
            {available.length ? (
              available.map((pi) => (
                <div className="available-device" key={pi.id}>
                  <Radio size={18} />
                  <div>
                    <strong>{pi.name}</strong>
                    <small>Available nearby</small>
                  </div>
                  <button onClick={() => setRegistering({ initial: pi })}>Register</button>
                </div>
              ))
            ) : (
              <p className="empty-line">
                No nearby devices found yet. Select Register Device to search for nearby BeeHave devices.
              </p>
            )}
          </section>
        </>
      )}
      <div className="insight-note">
        <Info size={16} />
        An old heartbeat means the connection state is unknown. The device may
        still be collecting locally and will upload when its connection returns.
      </div>
      {registering && (
        <RegisterDeviceModal
          farm={farm.name}
          initial={registering.initial}
          isRegistered={isRegistered}
          found={setNearby}
          onClose={() => setRegistering(null)}
          registered={refreshDevices}
        />
      )}
      {advancedDevice && controls(advancedDevice) && (
        <AdvancedSettings
          device={advancedDevice}
          canControl={controls(advancedDevice)}
          changed={(deleted) => {
            if (deleted && selectedDevice === advancedDevice.id) setDevice("");
            refreshDevices();
          }}
          onClose={() => setAdvanced(null)}
        />
      )}
    </>
  );
}
