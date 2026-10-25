import {
  Activity,
  Cpu,
  Droplets,
  HardDrive,
  MemoryStick,
  Mic,
  Power,
  Radio,
  RefreshCw,
  Thermometer,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

// One small icon per device-health item, for recognition; the text label always stays.
export const healthIcons = {
  cpu: Cpu,
  memory: MemoryStick,
  temperature: Thermometer,
  humidity: Droplets,
  microphone: Mic,
  storage: HardDrive,
  connection: Wifi,
  offline: WifiOff,
  monitoring: Activity,
  sync: RefreshCw,
  power: Power,
  device: Radio,
} satisfies Record<string, LucideIcon>;
export type HealthIconName = keyof typeof healthIcons;

export function HealthLabel({ icons, children }: { icons: HealthIconName[]; children: ReactNode }) {
  return (
    <span className="health-label">
      {icons.map((name) => {
        const Icon = healthIcons[name];
        return <Icon key={name} size={14} strokeWidth={2} aria-hidden="true" />;
      })}
      {children}
    </span>
  );
}
