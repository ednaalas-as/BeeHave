import { z } from "zod";
export const colors = {
  amber: "#F5A300",
  paleAmber: "#FFF4D6",
  navy: "#0B1930",
  slate: "#64748B",
  background: "#F8FAFC",
  white: "#FFFFFF",
  border: "#E2E8F0",
  blue: "#2589E8",
  teal: "#10B981",
  red: "#E5484D",
  paleBlue: "#EFF6FF",
  paleTeal: "#ECFDF5",
  paleRed: "#FEF2F2",
} as const;
export const tokens = {
  colors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, section: 48 },
  radius: { control: 8, card: 12 },
  font: { caption: 12, body: 14, lead: 16, heading: 18, title: 24, metric: 32 },
};
export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const timeSchema = z.string().datetime({ offset: true });
export const readingSchema = z.object({
  id: idSchema,
  observedAt: timeSchema,
  temperature: z.number().min(-40).max(85).nullable(),
  humidity: z.number().min(0).max(100).nullable(),
});
export const recordingSchema = z.object({
  id: idSchema,
  observedAt: timeSchema,
  duration: z.number().positive().max(3600),
  filename: z.string().min(1).max(160),
  status: z.enum(["pending", "missing"]).default("pending"),
});
export const detectionSchema = z.object({
  id: idSchema,
  observedAt: timeSchema,
  species: z.string().min(1).max(100),
  frequency: z.number().positive().max(100000),
  confidence: z.number().min(0).max(1),
  readingId: idSchema.nullable().default(null),
  recordingId: idSchema.nullable().default(null),
  modelVersion: z.string().min(1).max(100),
});
// The Pi's network as its setup service reports it: read-only and free of secrets.
// Raw priorities and profile names are for diagnostics; farmers see an ordered list.
export const savedNetworkSchema = z.object({
  // NetworkManager's profile UUID, used to rejoin a saved network without its password.
  id: z.string().max(64).optional(),
  ssid: z.string().min(1).max(32),
  profile: z.string().max(64),
  autoconnect: z.boolean(),
  priority: z.number().int().min(-999).max(999),
  active: z.boolean(),
  inRange: z.boolean(),
});
export const networkStatusSchema = z.object({
  method: z.enum(["wifi", "ethernet", "setup", "offline"]),
  setupMode: z.boolean(),
  ssid: z.string().max(32).optional(),
  signal: z.number().int().min(0).max(100).optional(),
  ipAddress: z.string().max(64).optional(),
  internet: z.enum(["full", "limited", "portal", "none", "unknown"]).optional(),
  lastConnectedAt: timeSchema.optional(),
  lastFailure: z
    .object({ ssid: z.string().max(32), stage: z.string().max(40), message: z.string().max(200), at: timeSchema })
    .optional(),
  // The last Wi-Fi change made on the setup hotspot page, reported once the Pi is back online.
  setupPageResult: z
    .object({
      ssid: z.string().max(32),
      result: z.enum(["connected", "failed"]),
      stage: z.string().max(40),
      message: z.string().max(200),
      at: timeSchema,
    })
    .optional(),
  saved: z.array(savedNetworkSchema).max(30),
  // X25519 public key the setup service decrypts Wi-Fi passwords with (never the private key).
  credentialKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type NetworkStatus = z.infer<typeof networkStatusSchema>;
export type SavedNetwork = z.infer<typeof savedNetworkSchema>;
// Networks the Pi itself can see (never the phone's or browser's).
export const wifiScanSchema = z.object({
  networks: z
    .array(z.object({ ssid: z.string().min(1).max(32), signal: z.number().int().min(0).max(100), security: z.string().max(20) }))
    .max(40),
  cached: z.boolean(),
  scannedAt: timeSchema.optional(),
});
export type WifiScan = z.infer<typeof wifiScanSchema>;
export const isWifiScan = (value: unknown): value is WifiScan =>
  !!value && typeof value === "object" && Array.isArray((value as WifiScan).networks);
// Farmer-facing wording for the network report, shared by web and mobile.
export const networkMethodLabels: Record<NetworkStatus["method"], string> = {
  wifi: "Wi-Fi",
  ethernet: "Ethernet cable",
  setup: "Setup hotspot (setup mode)",
  offline: "No network",
};
export const internetLabels: Record<NonNullable<NetworkStatus["internet"]>, string> = {
  full: "Reachable",
  limited: "Limited: connected to the network, but not to the internet",
  portal: "Needs a sign-in page the device cannot complete",
  none: "Not reachable",
  unknown: "Not checked yet",
};
export const signalLabel = (signal: number) =>
  `${signal >= 70 ? "Strong" : signal >= 45 ? "Good" : signal >= 25 ? "Fair" : "Weak"} (${signal}%)`;
export const healthSchema = z.object({
  collecting: z.boolean(),
  cpu: z.number().min(0).max(100),
  ram: z.number().min(0).max(100),
  cpuTemperature: z.number().min(-40).max(150),
  storageUsed: z.number().nonnegative(),
  storageTotal: z.number().positive(),
  queued: z.number().int().nonnegative(),
  microphone: z.boolean(),
  sensor: z.boolean(),
  softwareVersion: z.string().max(100),
  // Optional details from the BeeHave device agent; none of them are credentials.
  hostname: z.string().max(100).optional(),
  ipAddress: z.string().max(64).optional(),
  wifiNetwork: z.string().max(64).optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
  // Age of the newest classification window when the heartbeat was taken.
  lastWindowAgeSeconds: z.number().nonnegative().optional(),
  monitoringService: z.string().max(32).optional(),
  audioStatusDetail: z.string().max(200).optional(),
  sensorStatusDetail: z.string().max(200).optional(),
  errors: z.array(z.string().max(200)).max(10).optional(),
  uploader: z.enum(["installed", "not installed"]).optional(),
  // A malformed network report is dropped rather than rejecting the whole heartbeat.
  network: networkStatusSchema.optional().catch(undefined),
});
// Locates a detection's classifier window inside its original recording, using
// the classifier's own session and window identity. Frames are counted in the
// recording's verified sample rate.
export const audioWindowSchema = z.object({
  detectionId: idSchema,
  recordingId: idSchema,
  sessionId: z.string().min(1).max(100),
  windowIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  startFrame: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  frameCount: z.number().int().positive().max(3 * 384000),
});
// Stored label of a negative Pi classifier window. These records are listed with
// detections but are not Bee-positive detections, so counts and summaries skip them.
export const NON_BEE_CLASSIFICATION = "Non-Bee";
// Display names for the classifier's two outcomes. Stored identifiers ("Bee", "Non-Bee") are unchanged.
export const BEE_LABEL = "T. biroi";
export const NON_BEE_LABEL = "Non-T. biroi";
const beeSpecies = new Set(["bee", "t. biroi", "tetragonula biroi"]);
/** User-facing name of a stored classification; other specific labels are shown as stored. */
export function classificationLabel(species: string) {
  if (species === NON_BEE_CLASSIFICATION) return NON_BEE_LABEL;
  return beeSpecies.has(species.trim().toLowerCase()) ? BEE_LABEL : species;
}
// Classification filter choices: value is the stored identifier, label the display name.
export const classificationOptions = [
  { label: "All detections", value: "" },
  { label: BEE_LABEL, value: "Bee" },
  { label: NON_BEE_LABEL, value: NON_BEE_CLASSIFICATION },
];
export const batchSchema = z.object({
  readings: z.array(readingSchema).max(1000).default([]),
  recordings: z.array(recordingSchema).max(1000).default([]),
  detections: z.array(detectionSchema).max(1000).default([]),
  audioWindows: z.array(audioWindowSchema).max(1000).default([]),
  health: healthSchema.optional(),
});
export type AudioWindow = z.infer<typeof audioWindowSchema>;
export type Reading = z.infer<typeof readingSchema>;
// Where a recording's audio is on its way from the device; "available" only after verification.
export type RecordingTransfer = "waiting" | "uploading" | "interrupted" | "verifying" | "available" | "failed";
export const recordingTransferLabels: Record<RecordingTransfer, string> = {
  waiting: "Waiting to transfer",
  uploading: "Uploading",
  interrupted: "Upload interrupted",
  verifying: "Verifying",
  available: "Available",
  failed: "Unavailable",
};
export const recordingTransferLabel = (recording: Pick<Recording, "status" | "transfer">) =>
  recordingTransferLabels[
    recording.transfer ?? (recording.status === "available" ? "available" : recording.status === "missing" ? "failed" : "waiting")
  ];
export type Recording = Omit<z.infer<typeof recordingSchema>, "status"> & {
  status: "pending" | "missing" | "available";
  transfer?: RecordingTransfer;
  deviceId: string;
  detectionIds: string[];
  synthetic: boolean;
};
export type Detection = z.infer<typeof detectionSchema> & {
  deviceId: string;
  reading: Reading | null;
  recording: Recording | null;
  // Present when the detection's own window inside the recording is known.
  audioWindow?: { windowIndex: number; startFrame: number; frameCount: number } | null;
};
export type Health = z.infer<typeof healthSchema>;
// Remote device commands are queued by the API and collected by the Pi with its device key.
// Audio and temperature/humidity are read by one monitoring service, so they are controlled together.
export const deviceCommandActions = [
  "reboot",
  "shutdown",
  "monitoring_start",
  "monitoring_stop",
  "monitoring_restart",
  "network_scan",
  "wifi_connect",
  "wifi_disconnect",
  "wifi_forget",
  "wifi_priority",
] as const;
export type DeviceCommandAction = (typeof deviceCommandActions)[number];
// Lifecycle: pending (not yet collected) → sent (received by the device) → executing →
// succeeded | failed. A request nobody collected in time is "expired" and can never run;
// one the device collected but did not confirm in time is "timed_out" (outcome unknown).
export type DeviceCommandStatus =
  | "pending"
  | "sent"
  | "executing"
  | "succeeded"
  | "failed"
  | "expired"
  | "timed_out"
  | "cancelled";
export type DeviceCommand = {
  id: string;
  action: DeviceCommandAction;
  status: DeviceCommandStatus;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  receivedAt?: string | null;
  startedAt?: string | null;
  // Data a verified result carries, e.g. the networks a Wi-Fi scan found.
  result?: WifiScan | WifiConnectResult | null;
  // The network a Wi-Fi request is about (never its password).
  target?: string | null;
  // When the current stage gives up: pickup while pending, verification afterwards.
  deadline?: string | null;
};
// Minutes a request may wait for the device to collect it.
export const COMMAND_PICKUP_MINUTES = 10;
// Minutes after collection within which the device must confirm the verified result.
export const commandVerifyMinutes: Record<DeviceCommandAction, number> = {
  reboot: 6,
  shutdown: 3,
  monitoring_start: 3,
  monitoring_stop: 3,
  monitoring_restart: 3,
  network_scan: 2,
  // Joining, checking BeeHave on the new network, and returning to the old one if needed.
  wifi_connect: 6,
  // Leaving the active network first moves the device to another saved one.
  wifi_disconnect: 5,
  wifi_forget: 5,
  wifi_priority: 2,
};
// Changes to one saved network that the device may make without a password.
export const savedNetworkActions = ["wifi_disconnect", "wifi_forget", "wifi_priority"] as const;
export type SavedNetworkAction = (typeof savedNetworkActions)[number];
export const isSavedNetworkAction = (action: DeviceCommandAction): action is SavedNetworkAction =>
  (savedNetworkActions as readonly string[]).includes(action);
// Which saved network to change, by its NetworkManager profile, and the new priority if any.
export const savedNetworkRequestSchema = z.object({
  ssid: z.string().min(1).max(32),
  profile: z.string().min(1).max(64),
  priority: z.number().int().min(0).max(100).optional(),
});
export type SavedNetworkRequest = z.infer<typeof savedNetworkRequestSchema>;
// Where a request's progress is shown: next to the controls that issued it.
export type CommandGroup = "monitoring" | "device" | "network";
export const commandGroup = (action: DeviceCommandAction): CommandGroup =>
  action.startsWith("monitoring_") ? "monitoring" : action.startsWith("network_") || action.startsWith("wifi_") ? "network" : "device";
// What the device reports after a Wi-Fi change: where it ended up, and why.
export const wifiConnectResultSchema = z.object({
  ssid: z.string().max(32),
  result: z.enum(["connected", "restored", "setup_mode", "rejected"]),
  stage: z.string().max(40),
  previous: z.string().max(32).optional(),
  current: z.string().max(32).optional(),
});
export type WifiConnectResult = z.infer<typeof wifiConnectResultSchema>;
export const commandResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  message: z.string().trim().max(500).optional(),
  data: z.union([wifiScanSchema, wifiConnectResultSchema]).optional().catch(undefined),
});
// A Wi-Fi change request: the network name in the clear, the password only as a sealed
// envelope (see wifi-credential.ts), or a saved profile to rejoin without any password.
export const wifiRequestSchema = z
  .object({
    ssid: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).length <= 32 && !/[\r\n]/.test(value), "Enter a Wi-Fi network name of up to 32 characters."),
    hidden: z.boolean().default(false),
    // Exactly one of: a saved profile, a sealed password, or an explicitly open network.
    open: z.boolean().default(false),
    profile: z.string().max(64).optional(),
    credential: z
      .object({
        v: z.literal(1),
        epk: z.string().regex(/^[0-9a-f]{64}$/),
        nonce: z.string().regex(/^[0-9a-f]{24}$/),
        ct: z.string().regex(/^[0-9a-f]{34,158}$/),
      })
      .optional(),
  })
  .refine(
    (value) => [!!value.profile, !!value.credential, value.open].filter(Boolean).length === 1,
    "Choose a saved network, enter a password, or mark the network as open.",
  );
export type WifiRequest = z.input<typeof wifiRequestSchema>;
// The device claims a collected request before acting; a refused claim means "do not run".
export const commandAckSchema = z.object({
  stage: z.literal("executing"),
  message: z.string().trim().max(500).optional(),
});
// The signed-in account's permission on a device, as the API resolved it.
export type DeviceAccess = "administrator" | "viewer";
export type Device = {
  access?: DeviceAccess;
  disconnectedAt?: string | null;
  // Public identity hash of a nearby-paired Pi; never a credential.
  setupId?: string | null;
  // Computed by the API when it answered; clients recompute it as time passes.
  monitoring?: MonitoringStatus;
  id: string;
  name: string;
  location: string;
  model: string;
  lastSeen: string | null;
  lastSync: string | null;
  health: Health | null;
  // When the health above was reported. Data uploads refresh lastSeen without health,
  // so health can be older than lastSeen. Absent from older API responses.
  healthAt?: string | null;
};
// A role belongs to one farm membership, never to the whole account.
export type FarmRole = "owner" | "viewer";
export type FarmMembership = { id: string; name: string; role: FarmRole; demo: boolean };
export type Account = {
  id: string;
  name: string;
  email: string;
  // The default farm's name and role, kept for older clients.
  farm: string;
  role: "administrator" | "viewer";
  demo: boolean;
  // Every farm this account is a member of, and which one to open first. Absent from older API servers.
  farmId?: string;
  farms?: FarmMembership[];
};
export type FarmMember = {
  accountId: string;
  name: string;
  email: string;
  role: FarmRole;
};
// A single-use invite code an owner created; the code itself is shown only when it is created.
export type FarmInvite = { id: string; role: FarmRole; createdBy: string; createdAt: string; expiresAt: string };
// Asking to connect to a whole farm, with a claimed device's pairing code (or, before invite codes,
// from the farm directory). Owners approve or decline. deviceName: the device whose code was used.
export type FarmRequest = { accountId: string; name: string; email: string; createdAt: string; deviceName?: string | null };
// Viewers see who owns the farm; only owners see the member list, requests and emails.
export type FarmProfile = {
  id: string;
  name: string;
  // Human-readable location, e.g. "Sariaya, Quezon". Absent from older API servers.
  location?: string | null;
  demo: boolean;
  role: FarmRole;
  owners: string[];
  members: FarmMember[] | null;
  requests?: FarmRequest[] | null;
  // Unused invite codes, for owners only. Absent from older API servers.
  invites?: FarmInvite[] | null;
  devices: { id: string; name: string }[];
};
// A provisioned Edge Device found by its pairing code, shown for confirmation before it is
// claimed into the selected farm.
export type DeviceClaim = { deviceUid: string; farm: string };
// Where a push notification leads. It only selects the screen; the API still checks access there.
export type NotificationTarget = { screen: "device" | "farm-requests"; farmId: string; deviceId?: string };
// What this API offers for push notifications. webPushKey is the VAPID public key (null: Web Push
// is not configured on this server).
export type NotificationConfig = { webPushKey: string | null; expo: boolean };
// The web app's route for a notification target.
export function notificationPath(target: NotificationTarget) {
  const farm = `farm=${encodeURIComponent(target.farmId)}`;
  return target.screen === "farm-requests"
    ? `/settings?${farm}&section=requests`
    : `/devices?${farm}${target.deviceId ? `&device=${encodeURIComponent(target.deviceId)}` : ""}`;
}
// What the Pi's printed setup label holds, reported by the device itself. Farm owners only.
export type SetupLabel = { hotspot: string; hotspotPassword: string; code: string; updatedAt: string };
// The setup page the Pi serves on its own hotspot.
export const setupPageUrl = "http://192.168.77.1:8765";
// Farm-scoped requests name the selected farm; the API still checks membership on every call.
export function withFarm(path: string, farm: string | undefined) {
  if (!farm) return path;
  return `${path}${path.includes("?") ? "&" : "?"}farm=${encodeURIComponent(farm)}`;
}
export type Session = { account: Account; token?: string };
export type Daily = {
  date: string;
  count: number;
  frequency: number;
  confidence: number;
  temperature: number | null;
  humidity: number | null;
};
export type SeriesResolution = "hour" | "3hour" | "day" | "week" | "month";
// count is null when the device sent nothing for the bucket, so missing data stays visibly missing.
export type SeriesPoint = {
  start: string;
  end: string;
  count: number | null;
  // Mean acoustic frequency (Hz) of the bucket's Bee detections; null without detections.
  // Optional for older API servers.
  frequency?: number | null;
  temperature: number | null;
  humidity: number | null;
};
export type Summary = {
  total: number;
  averageFrequency: number;
  averageConfidence: number;
  previousTotal: number;
  peakHour: string | null;
  // Bee detections per elapsed hour of the range. Optional for older API servers.
  visitationFrequency?: number;
  // Busiest single clock hour in the range; start is that hour's ISO timestamp.
  peakVisitation?: { count: number; start: string } | null;
  hourly: {
    hour: string;
    count: number;
    temperature: number | null;
    humidity: number | null;
  }[];
  daily: Daily[];
  // Chronological chart buckets sized to the range. Optional for older API servers.
  resolution?: SeriesResolution;
  series?: SeriesPoint[];
  recent: Detection[];
  devices: Device[];
  from: string;
  to: string;
};
export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pages: number;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function createApi(
  base = "",
  getToken: () => string | null = () => null,
) {
  return async function api<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = getToken();
    const response = await fetch(`${base}/api${path}`, {
      ...options,
      credentials: "include",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({
          error: "The server could not complete this request.",
        }));
      throw new ApiError(body.error ?? "Request failed", response.status);
    }
    return response.json() as Promise<T>;
  };
}
export const formatTime = (value: string) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
export const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
// Display only: a temperature or humidity rounded half away from zero to exactly
// two decimals. Rounding the decimal digits (not the binary float) keeps
// 73.365 → "73.37"; stored values keep their full precision.
export function formatMeasurement(value: number) {
  const digits = String(Math.abs(value));
  if (digits.includes("e")) return value.toFixed(2);
  const rounded = Math.sign(value) * Math.round(Number(`${digits}e2`));
  return Number(`${rounded}e-2`).toFixed(2);
}
// "14:00–15:00" in Philippine time, prefixed with the date when the range spans several days.
export function formatHourWindow(start: string, withDate = false) {
  const hour = new Date(Date.parse(start) + 8 * 3600000).getUTCHours();
  const pad = (n: number) => String(n % 24).padStart(2, "0") + ":00";
  return `${withDate ? formatDate(start) + ", " : ""}${pad(hour)}–${pad(hour + 1)}`;
}
export function manilaDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function ago(value: string | null) {
  if (!value) return "Not yet reported";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes} min ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} hr ago`
        : `${Math.floor(minutes / 1440)} days ago`;
}
// A report older than this cannot be trusted as the device's current state.
export const FRESH_REPORT_MS = 180000;
export const isOnline = (device: Device) =>
  !device.disconnectedAt && !!device.lastSeen && Date.now() - Date.parse(device.lastSeen) < FRESH_REPORT_MS;
// When the device's latest health report was taken (older APIs only had lastSeen).
export const healthReportedAt = (device: Device) =>
  device.health ? (device.healthAt ?? device.lastSeen) : null;
// Pi-dependent state (monitoring, microphone, sensor, storage, network) counts as current only
// while the device is reachable and its own health report is recent; otherwise it is Unknown.
export function healthFresh(device: Device) {
  const at = healthReportedAt(device);
  return isOnline(device) && !!at && Date.now() - Date.parse(at) < FRESH_REPORT_MS;
}

// The result of the last Wi-Fi change made on the Pi's setup hotspot page. That page cannot show
// it (the phone loses the hotspot as soon as the Pi switches), so the device reports it once it
// is back online. Shown on the device card for a day; network details keep it as history.
export const SETUP_RESULT_NOTE_MS = 24 * 60 * 60 * 1000;
export function setupPageNote(device: Device, recentOnly = true) {
  const result = device.health?.network?.setupPageResult;
  if (!result || device.disconnectedAt) return null;
  if (recentOnly && Date.now() - Date.parse(result.at) > SETUP_RESULT_NOTE_MS) return null;
  const ssid = result.ssid.trim() || "the network";
  return result.result === "connected"
    ? { tone: "good" as const, at: result.at, summary: `Connected to ${ssid}`, title: `Wi-Fi setup: connected to ${ssid}`, text: result.message || `Connected to ${ssid}.` }
    : {
        tone: "warning" as const,
        at: result.at,
        summary: `Could not connect to ${ssid}`,
        title: `Wi-Fi setup: could not connect to ${ssid}`,
        text: `${result.message} The device went back to a network it already knew; nothing was changed.`.trim(),
      };
}

// Farmer-facing device status. Every label is derived only from what the device reported.
export type StatusTone = "good" | "warning" | "bad" | "neutral";
// Monitoring state as BeeHave can verify it. "unknown" whenever the device is unreachable.
export type MonitoringState = "active" | "stopped" | "error" | "unknown";
export type MonitoringStatus = {
  current: MonitoringState;
  // What the device said in its last heartbeat; history, not the current state.
  lastReported?: Exclude<MonitoringState, "unknown">;
  reportedAt: string | null;
};
export const monitoringStateLabels: Record<MonitoringState, string> = {
  active: "Monitoring",
  stopped: "Paused",
  error: "Not running",
  unknown: "Unknown",
};
export function reportedMonitoringState(health: Health | null): MonitoringState {
  if (!health) return "unknown";
  const service = health.monitoringService;
  // Devices without the agent only report whether they were collecting.
  if (service === undefined) return health.collecting ? "active" : "stopped";
  if (service === "active" || service === "activating" || service === "reloading") return "active";
  if (service === "failed") return "error";
  if (service === "inactive" || service === "deactivating") return "stopped";
  return "unknown";
}
export function monitoringStatus(device: Device, latest?: DeviceCommand | null): MonitoringStatus {
  const reported = reportedMonitoringState(device.health);
  const reportedAt = healthReportedAt(device);
  let current: MonitoringState = healthFresh(device) ? reported : "unknown";
  // A monitoring request the reachable device confirmed after its last health report is newer live evidence.
  if (
    current !== "unknown" &&
    latest?.status === "succeeded" &&
    latest.action.startsWith("monitoring_") &&
    (!reportedAt || Date.parse(latest.updatedAt) > Date.parse(reportedAt))
  )
    current = latest.action === "monitoring_stop" ? "stopped" : "active";
  return {
    current,
    lastReported: reported === "unknown" ? undefined : reported,
    reportedAt,
  };
}
export type StatusKey = "microphone" | "environment" | "connection" | "storage" | "sync" | "monitoring" | "device";
export type StatusItem = { key: StatusKey; label: string; value: string; tone: StatusTone; detail?: string };
// The UI can only act on a device it can reach; this is the explanation shown when it cannot.
export const offlineControlsMessage = "Device controls are unavailable because the Edge Device cannot currently be reached.";
// Pass the latest request so a verified result newer than the last heartbeat is reflected.
export function deviceOverview(device: Device, latest?: DeviceCommand | null) {
  const h = device.health;
  const online = isOnline(device);
  const fresh = healthFresh(device);
  const reportedAt = healthReportedAt(device);
  const storage = h ? h.storageUsed / h.storageTotal : 0;
  // Unreachable or stale: a component is Unknown, never Stopped or Failed. Its last report is history.
  const unknown = (key: StatusKey, label: string, last?: string): StatusItem => ({
    key,
    label,
    value: "Unknown",
    tone: "neutral",
    detail: !online
      ? `The device cannot currently be reached.${last && reportedAt ? ` Last reported: ${last} · ${ago(reportedAt).toLowerCase()}.` : ""}`
      : `Waiting for a recent report from the device.${last && reportedAt ? ` Last reported: ${last} · ${ago(reportedAt).toLowerCase()}.` : ""}`,
  });
  const overall: StatusItem = device.disconnectedAt
    ? { key: "device", label: "Device status", value: "Disconnected", tone: "neutral" }
    : !device.lastSeen
      ? { key: "device", label: "Device status", value: "Waiting for first report", tone: "neutral" }
      : !online
        ? { key: "device", label: "Device status", value: "Offline", tone: "neutral" }
        : fresh && h && (!h.microphone || !h.sensor || storage >= 0.95)
          ? { key: "device", label: "Device status", value: "Attention Needed", tone: "warning" }
          : { key: "device", label: "Device status", value: "Online", tone: "good" };
  // Current monitoring is only what BeeHave can verify now; offline it is Unknown.
  // The last report is kept as secondary history and never presented as current.
  const status = monitoringStatus(device, latest);
  const lastReported = status.lastReported && status.reportedAt
    ? `Last reported: ${monitoringStateLabels[status.lastReported]} · ${ago(status.reportedAt).toLowerCase()}.`
    : undefined;
  const monitoring: StatusItem =
    status.current === "active"
      ? { key: "monitoring", label: "Monitoring", value: monitoringStateLabels.active, tone: "good", detail: "Recording hive audio and reading temperature and humidity." }
      : status.current === "stopped"
        ? { key: "monitoring", label: "Monitoring", value: monitoringStateLabels.stopped, tone: "warning", detail: "Recording and bee detection are paused. Monitoring resumes when you resume it or the device restarts." }
        : status.current === "error"
          ? { key: "monitoring", label: "Monitoring", value: monitoringStateLabels.error, tone: "bad", detail: "Monitoring stopped unexpectedly on the device. Check the microphone and sensor connections, then resume monitoring." }
          : {
              key: "monitoring",
              label: "Monitoring",
              value: monitoringStateLabels.unknown,
              tone: "neutral",
              detail: !online
                ? `The Edge Device cannot currently be reached, so its monitoring state cannot be verified.${lastReported ? " " + lastReported : ""}`
                : reportedAt && !fresh
                  ? `Waiting for a recent report from the device.${lastReported ? " " + lastReported : ""}`
                  : "The device has not reported its monitoring state.",
            };
  const sensor = (key: StatusKey, label: string, ok: boolean | undefined, detail?: string): StatusItem =>
    ok === undefined
      ? online
        ? { key, label, value: "Not Available", tone: "neutral", detail: "Not reported yet." }
        : unknown(key, label)
      : !fresh
        ? unknown(key, label, ok ? "Working" : "Attention needed")
        : ok
          ? { key, label, value: "Working", tone: "good", detail }
          : { key, label, value: "Attention Needed", tone: "warning", detail: "The device reported this sensor as unavailable." };
  const free = h ? `${(h.storageTotal - h.storageUsed).toFixed(1)} GB free` : "";
  const items: StatusItem[] = [
    sensor("microphone", "Microphone", h?.microphone),
    sensor("environment", "Temperature & humidity sensor", h?.sensor, "One sensor module provides both readings."),
    device.disconnectedAt
      ? { key: "connection", label: "Connection", value: "Disconnected", tone: "neutral" }
      : online
        ? { key: "connection", label: "Connection", value: "Online", tone: "good" }
        : device.lastSeen
          ? { key: "connection", label: "Connection", value: "Offline", tone: "neutral", detail: `Last heard from ${ago(device.lastSeen).toLowerCase()}.` }
          : { key: "connection", label: "Connection", value: "Not connected yet", tone: "neutral" },
    !h
      ? online
        ? { key: "storage", label: "Storage", value: "Not Available", tone: "neutral" }
        : unknown("storage", "Storage")
      : !fresh
        ? unknown("storage", "Storage", free)
        : storage >= 0.95
          ? { key: "storage", label: "Storage", value: "Attention Needed", tone: "bad", detail: `${free}.` }
          : storage >= 0.8
            ? { key: "storage", label: "Storage", value: "Getting Full", tone: "warning", detail: `${free}.` }
            : { key: "storage", label: "Storage", value: "Good", tone: "good", detail: `${free}.` },
    // Sync is reported on its own; it never stands in for monitoring or connectivity.
    h?.uploader === "not installed"
      ? { key: "sync", label: "Data sync", value: "Data upload not set up", tone: "neutral", detail: "Monitoring data stays on the device until an uploader is installed." }
      : !online && device.lastSeen
        ? { key: "sync", label: "Data sync", value: "Waiting for connection", tone: "neutral", detail: device.lastSync ? `Last synced ${ago(device.lastSync).toLowerCase()}.` : undefined }
        : !device.lastSync
          ? { key: "sync", label: "Data sync", value: "Not synchronized yet", tone: "neutral" }
          : h?.queued
            ? { key: "sync", label: "Data sync", value: "Waiting to Sync", tone: "warning", detail: `${h.queued} records waiting.` }
            : { key: "sync", label: "Data sync", value: "Up to date", tone: "good" },
  ];
  // Connectivity first, then monitoring; offline never claims a monitoring state.
  const summary = device.disconnectedAt
    ? "Disconnected"
    : !device.lastSeen
      ? "Waiting for first report"
      : online
        ? `Online · ${status.current === "unknown" ? "Monitoring status unknown" : monitoringStateLabels[status.current]}`
        : "Offline · Monitoring status unknown";
  return { overall, monitoring, items, online, fresh, summary };
}
export const commandLabels: Record<
  DeviceCommandAction,
  { name: string; running: string; done: string; failed: string; timedOut: string }
> = {
  reboot: { name: "Restart", running: "Restarting… waiting for the device to reconnect.", done: "Device restarted and reconnected.", failed: "Restart failed.", timedOut: "Restart timed out. The device did not reconnect in time." },
  shutdown: { name: "Shutdown", running: "Shutting down…", done: "The device confirmed it is shutting down.", failed: "Shutdown failed.", timedOut: "Shutdown timed out. The device did not confirm it." },
  monitoring_restart: { name: "Monitoring restart", running: "Restarting monitoring…", done: "Monitoring restarted. The device confirmed it is running.", failed: "Monitoring restart failed.", timedOut: "Monitoring restart timed out. The device did not confirm the result." },
  monitoring_start: { name: "Resume", running: "Resuming monitoring…", done: "Monitoring resumed. The device confirmed it is running.", failed: "Resume failed.", timedOut: "Resume timed out. The device did not confirm the result." },
  monitoring_stop: { name: "Pause", running: "Pausing monitoring…", done: "Monitoring paused. The device confirmed it stopped.", failed: "Pause failed.", timedOut: "Pause timed out. The device did not confirm the result." },
  network_scan: { name: "Wi-Fi scan", running: "Scanning for Wi-Fi networks…", done: "Scan complete.", failed: "Wi-Fi scan failed.", timedOut: "Wi-Fi scan timed out. The device did not send its results." },
  wifi_connect: {
    name: "Wi-Fi change",
    running: "Connecting… The device may go offline for a minute or two while it switches networks.",
    done: "Connected. The device confirmed it joined the network and reached BeeHave.",
    failed: "Wi-Fi connection failed.",
    timedOut: "The device did not report back after the Wi-Fi change. If it could neither join the new network nor return to a saved one, it is in setup mode: join the BeeHave setup hotspot to reconfigure it.",
  },
  wifi_disconnect: {
    name: "Disconnect",
    running: "Disconnecting… The device moves to another saved network and may go offline for a minute.",
    done: "Disconnected. The device moved to another saved network.",
    failed: "Disconnect failed.",
    timedOut: "The device did not report back after disconnecting. It may still be switching networks, or be in setup mode if no saved network worked.",
  },
  wifi_forget: {
    name: "Forget network",
    running: "Forgetting the network…",
    done: "Network forgotten. The device no longer joins it automatically.",
    failed: "Forget failed.",
    timedOut: "The device did not report back after forgetting the network. It may still be switching networks.",
  },
  wifi_priority: {
    name: "Priority change",
    running: "Saving the new priority…",
    done: "Priority saved.",
    failed: "Priority change failed.",
    timedOut: "Priority change timed out. The device did not confirm it.",
  },
};
export type CommandStage =
  | "waiting"
  | "received"
  | "executing"
  | "completed"
  | "failed"
  | "timed_out"
  | "expired"
  | "cancelled";
// Plain-language progress for a request. Only a request the device has not collected can be
// cancelled, and nothing short of the device's verified confirmation counts as completed.
export function commandFeedback(command: DeviceCommand, online = true) {
  const labels = commandLabels[command.action];
  const wifi = command.action === "wifi_connect";
  const network = command.target ? ` ${command.target}` : "";
  // A Wi-Fi change takes the device offline on purpose; anything else going quiet is news.
  const switching = wifi || command.action === "wifi_disconnect" || command.action === "wifi_forget";
  const lost = online ? "" : switching ? " The device is offline while it switches networks; this is expected."
    : " The device stopped responding, so the result is unknown until it reconnects.";
  const progress = (stage: CommandStage, step: string, text: string, cancellable = false) =>
    ({ active: true, cancellable, stage, step, tone: "neutral" as StatusTone, text: text + lost });
  const done = (stage: CommandStage, tone: StatusTone, text: string) =>
    ({ active: false, cancellable: false, stage, step: "", tone, text });
  switch (command.status) {
    case "pending":
      return progress("waiting", "Sending…", wifi
        ? `Sending the network settings for${network}. Waiting for the device to receive them. Nothing has changed yet.`
        : `${labels.name} sent. Waiting for the device to receive it. Nothing has changed yet.`, true);
    case "sent":
      return progress("received", "Received by device", wifi ? `The device received the settings for${network}. ${labels.running}` : `Received by device. ${labels.running}`);
    case "executing":
      return progress("executing", "Executing…", labels.running);
    case "succeeded":
      return done("completed", "good", command.action === "network_scan" && command.message ? command.message
        : command.action === "wifi_connect" && command.target ? `Connected to ${command.target}. The device confirmed it joined the network and reached BeeHave.`
        : isSavedNetworkAction(command.action) && command.message ? command.message
        : labels.done);
    case "failed":
      return done("failed", "bad", labels.failed + (command.message ? ` ${command.message}` : ""));
    case "timed_out":
      return done("timed_out", "warning", `${labels.timedOut} The outcome is unknown; BeeHave shows the device's real state from its next report.${command.message ? ` ${command.message}` : ""}`);
    case "cancelled":
      return done("cancelled", "neutral", `${labels.name} request cancelled. Nothing was changed on the device.`);
    default:
      return done("expired", "warning", "Command expired before the device received it. Nothing was changed on the device, and the request will never run.");
  }
}
// Confirmation wording for each remote request, shared by web and mobile.
export const commandPrompts: Record<DeviceCommandAction, { button: string; title: string; text: string; confirm: string }> = {
  reboot: {
    button: "Restart Device",
    title: "Restart BeeHave Device?",
    text: "The device will temporarily stop monitoring while it restarts. Monitoring should resume automatically after startup if the BeeHave monitoring service is configured to do so.",
    confirm: "Restart Device",
  },
  shutdown: {
    button: "Shut Down Device",
    title: "Shut Down BeeHave Device?",
    text: "BeeHave will stop monitoring and recording until the Raspberry Pi is physically powered on again.",
    confirm: "Shut Down",
  },
  monitoring_restart: {
    button: "Restart Monitoring",
    title: "Restart BeeHave monitoring?",
    text: "Audio recording, bee detection, and temperature and humidity readings pause briefly while monitoring restarts. The microphone and the temperature & humidity sensor restart together because one monitoring service runs both.",
    confirm: "Restart Monitoring",
  },
  monitoring_stop: {
    button: "Pause Monitoring",
    title: "Pause BeeHave monitoring?",
    text: "Audio recording, bee detection, and temperature and humidity readings pause until you resume monitoring. Monitoring also resumes automatically the next time the device restarts.",
    confirm: "Pause Monitoring",
  },
  wifi_connect: {
    button: "Connect",
    title: "Connect to Wi-Fi?",
    text: "The device switches networks. It goes offline briefly, and returns to its current network if it cannot reach BeeHave on the new one.",
    confirm: "Connect",
  },
  wifi_disconnect: {
    button: "Disconnect",
    title: "Disconnect from this Wi-Fi?",
    text: "The device moves to the next saved network that can reach BeeHave and may go offline for a minute. This network stays saved. If no other saved network is in range, the device stays connected and nothing changes.",
    confirm: "Disconnect",
  },
  wifi_forget: {
    button: "Forget",
    title: "Forget this Wi-Fi network?",
    text: "The device deletes this saved network and its password, and will not join it again until it is added back. If the device is using it now, it first moves to another saved network; if none is in range, nothing is deleted.",
    confirm: "Forget Network",
  },
  wifi_priority: {
    button: "Save Priority",
    title: "Change this network's priority?",
    text: "When several saved networks are in range, the device joins the one with the highest priority (0–100). The current connection does not change.",
    confirm: "Save Priority",
  },
  network_scan: {
    button: "Scan for Wi-Fi",
    title: "Scan for Wi-Fi networks?",
    text: "The device looks for nearby Wi-Fi networks. Its current connection does not change.",
    confirm: "Scan",
  },
  monitoring_start: {
    button: "Resume Monitoring",
    title: "Resume BeeHave monitoring?",
    text: "The device starts recording audio and reading temperature and humidity again.",
    confirm: "Resume Monitoring",
  },
};
export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}
