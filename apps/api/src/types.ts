import type {
Account,
Detection,
Device,
Reading,
Recording,
} from "@beehave/shared";
export type AccountRow = {
  id: string;
  // The farm to open first, if any; access comes from farm_members only.
  farm_id: string | null;
  name: string;
  email: string;
  password: string;
  role: Account["role"];
  farm: string;
  demo: boolean;
};
export type DeviceRow = {
  id: string;
  farm_id: string;
  name: string;
  location: string;
  model: string;
  key_hash: string;
  disconnected_at: string | null;
  last_seen: string | null;
  last_sync: string | null;
  health: Device["health"];
  health_at?: string | null;
  setup_id?: string | null;
};
export type EventRow = {
  id: string;
  device_id: string;
  observed_at: string;
  data: Reading | Recording | Detection;
  audio?: Buffer | null;
};
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
