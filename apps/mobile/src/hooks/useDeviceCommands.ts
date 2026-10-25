import {
  ApiError,
  commandFeedback,
  commandGroup,
  commandLabels,
  isOnline,
  offlineControlsMessage,
  type CommandGroup,
  type Device,
  type DeviceCommand,
  type DeviceCommandAction,
  type SavedNetworkRequest,
  type WifiRequest,
} from "@beehave/shared";
import { randomUUID } from "expo-crypto";
import { useEffect, useSyncExternalStore } from "react";
import { apiRequest } from "../api";

/** One store per device, shared by every control on screen (card quick actions, Device
 * Controls, Advanced settings), so all copies of an action show the same progress and one tap
 * locks them all. Nothing here treats a submitted request as done: outcomes come from the device. */
type Store = {
  commands: DeviceCommand[];
  sending: DeviceCommandAction | null;
  failed: { action: DeviceCommandAction; error: Error } | null;
  cancelling: boolean;
  cancelError: string;
};
const stores = new Map<string, Store>();
const listeners = new Map<string, Set<() => void>>();
const settledListeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const empty: Store = { commands: [], sending: null, failed: null, cancelling: false, cancelError: "" };

const get = (id: string) => stores.get(id) ?? empty;
function set(id: string, patch: Partial<Store>) {
  const before = get(id);
  const after = { ...before, ...patch };
  stores.set(id, after);
  listeners.get(id)?.forEach((listener) => listener());
  const [was, now] = [before.commands[0], after.commands[0]];
  // Refresh device health once a request reaches its real outcome.
  if (now && was?.id === now.id && commandFeedback(was).active && !commandFeedback(now).active) {
    settledListeners.forEach((listener) => listener());
    // The device's next report (within seconds) carries the new state; fetch it again then.
    setTimeout(() => settledListeners.forEach((listener) => listener()), 8000);
  }
  // Poll only while a request is in progress.
  const active = !!after.sending || (now ? commandFeedback(now).active : false);
  if (active && !timers.has(id)) timers.set(id, setInterval(() => void load(id), 3000));
  if (!active && timers.has(id)) {
    clearInterval(timers.get(id));
    timers.delete(id);
  }
}
async function load(id: string) {
  try {
    set(id, { commands: await apiRequest<DeviceCommand[]>(`/devices/${encodeURIComponent(id)}/commands`) });
  } catch {
    // Keep the last known list; the next poll or screen refresh tries again.
  }
}

/** Called when any device request settles, e.g. to reload the device list. */
export function useCommandsSettled(listener: () => void) {
  useEffect(() => {
    settledListeners.add(listener);
    return () => void settledListeners.delete(listener);
  }, [listener]);
}

export function useDeviceCommands(device: Device, canControl: boolean) {
  const id = device.id;
  const state = useSyncExternalStore(
    (listener) => {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id)!.add(listener);
      return () => void listeners.get(id)!.delete(listener);
    },
    () => get(id),
  );
  // Command history is for owners only; the API refuses it to viewers.
  useEffect(() => {
    if (canControl) void load(id);
  }, [id, canControl]);
  const online = isOnline(device);
  const latest = state.commands[0];
  const feedback = latest ? commandFeedback(latest, online) : null;
  const busy = !!state.sending || !!feedback?.active;

  // A Wi-Fi request brings its own ID (its sealed password is bound to it) and only sealed data.
  async function send(action: DeviceCommandAction, extra?: { id: string; wifi?: WifiRequest; network?: SavedNetworkRequest }) {
    // Checked against the shared store, so a second tap anywhere is ignored.
    const current = get(id);
    if (current.sending || (current.commands[0] && commandFeedback(current.commands[0]).active)) return;
    set(id, { sending: action, failed: null });
    // One ID per tap: a retried submission returns the same request instead of a second one.
    const body = JSON.stringify({ action, confirm: true, id: extra?.id ?? randomUUID(), ...(extra?.wifi ? { wifi: extra.wifi } : {}), ...(extra?.network ? { network: extra.network } : {}) });
    const post = () => apiRequest(`/devices/${encodeURIComponent(id)}/commands`, { method: "POST", body });
    try {
      try {
        await post();
      } catch (failure) {
        if (failure instanceof ApiError) throw failure;
        await post();
      }
      set(id, { sending: null });
    } catch (failure) {
      set(id, { sending: null, failed: { action, error: failure as Error } });
    }
    await load(id);
  }
  async function cancel() {
    if (!latest) return;
    set(id, { cancelling: true, cancelError: "" });
    try {
      await apiRequest(`/devices/${encodeURIComponent(id)}/commands/${encodeURIComponent(latest.id)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (failure) {
      set(id, { cancelError: (failure as Error).message });
    } finally {
      await load(id);
      set(id, { cancelling: false });
    }
  }

  const disabledReason = !canControl
    ? "Only farm administrators can control devices."
    : device.disconnectedAt
      ? "Disconnected devices cannot receive requests."
      : !online
        ? offlineControlsMessage
        : busy
          ? "Waiting for the current request to finish."
          : "";
  // The outcome next to the controls that issued it, for a while after it settles; a settled
  // result is not repeated while the device is unreachable, since it may no longer hold.
  const feedbackFor = (group: CommandGroup) =>
    latest && feedback && commandGroup(latest.action) === group &&
    (feedback.active || (online && Date.now() - Date.parse(latest.updatedAt) < 15 * 60_000))
      ? feedback
      : null;
  const failed = state.failed;
  const errorFor = (group: CommandGroup) =>
    failed && commandGroup(failed.action) === group
      ? (failed.error instanceof ApiError && /cannot currently be reached|Disconnected/.test(failed.error.message)
          ? "Device unavailable. "
          : "") + `${commandLabels[failed.action].name} was not sent. ${failed.error.message}`
      : "";
  return {
    online,
    latest,
    history: state.commands,
    feedback,
    sending: state.sending,
    // The action in progress (being sent, or waiting on the device), if any.
    activeAction: state.sending ?? (feedback?.active ? latest!.action : null),
    cancelling: state.cancelling,
    cancelError: state.cancelError,
    send,
    cancel,
    disabledReason,
    feedbackFor,
    errorFor,
  };
}
