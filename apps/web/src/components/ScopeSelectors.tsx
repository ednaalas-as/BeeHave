import type { Device, FarmMembership } from "@beehave/shared";
import { ChevronDown, Leaf, Radio } from "lucide-react";
import { notCredential } from "../autofill";

export function ScopeSelectors({ farms, devices, farmId, deviceId, onFarm, onDevice }: {
  farms: FarmMembership[];
  devices: Device[];
  farmId: string;
  deviceId: string;
  onFarm: (id: string) => void;
  onDevice: (id: string) => void;
}) {
  return (
    <div className="context-selectors">
      <div className="installation">
        <span className="station-icon"><Leaf size={18} /></span>
        <div>
          <span className="caption">FARM</span>
          <div className="select-wrap">
            <select {...notCredential} name="farm-scope" aria-label="Farm" value={farmId} disabled={!farms.length} onChange={(e) => onFarm(e.target.value)}>
              {!farms.length && <option value="">No Available Farm</option>}
              {farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
            </select>
            <ChevronDown size={14} />
          </div>
        </div>
      </div>
      <div className="installation">
        <span className="station-icon"><Radio size={18} /></span>
        <div>
          <span className="caption">EDGE DEVICE</span>
          <div className="select-wrap">
            <select {...notCredential} name="device-scope" aria-label="Edge device" value={devices.length ? deviceId : ""} disabled={!devices.length} onChange={(e) => onDevice(e.target.value)}>
              <option value="">{devices.length ? "All devices in this farm" : "No Available Edge Device"}</option>
              {devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
            </select>
            <ChevronDown size={14} />
          </div>
        </div>
      </div>
    </div>
  );
}
