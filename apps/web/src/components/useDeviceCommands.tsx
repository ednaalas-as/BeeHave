import {
  ApiError,
  commandFeedback,
  commandGroup,
  commandLabels,
  type CommandGroup,
  isOnline,
  offlineControlsMessage,
  type Device,
  type DeviceCommand,
  type DeviceCommandAction,
  type SavedNetworkRequest,
  type WifiRequest,
} from "@beehave/shared";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../api";

// Devices with a submission in flight, across every control on the page. Checked synchronously
// so a second tap anywhere is ignored before React re-renders the disabled buttons.
const inFlight = new Set<string>();
// A Wi-Fi request carries its own ID (its sealed password is bound to it) and only sealed data.
type Submission = { action: DeviceCommandAction; at: number; id?: string; wifi?: WifiRequest; network?: SavedNetworkRequest };
// A version 4 UUID for one submission. crypto.randomUUID exists only on HTTPS and localhost,
// and the LAN address is plain HTTP; getRandomValues is available everywhere.
export function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Remote device requests through the API command queue. Every control for a device (quick
 * actions, Advanced settings) reads the same query and mutation state, so all
 * copies of an action show the same progress. Nothing here treats a submitted request as done:
 * progress and outcome come from the device. */
export function useDeviceCommands(device: Device, canControl: boolean) {
  const cache = useQueryClient();
  const { farm, farmApi: api } = useWorkspace();
  const online = isOnline(device);
  const [cancelling, setCancelling] = useState(false);
  const mutationKey = ["device-command", device.id];
  const submit = useMutation({
    mutationKey,
    mutationFn: async ({ action, id, wifi, network }: Submission) => {
      // One ID per tap: a retried submission returns the same request instead of a second one.
      const body = JSON.stringify({ action, confirm: true, id: id ?? requestId(), ...(wifi ? { wifi } : {}), ...(network ? { network } : {}) });
      const post = () => api(`/devices/${encodeURIComponent(device.id)}/commands`, { method: "POST", body });
      try {
        await post();
      } catch (failure) {
        if (failure instanceof ApiError) throw failure;
        await post();
      }
    },
  });
  // The newest submission from any control for this device.
  const submissions = useMutationState({
    filters: { mutationKey },
    select: (mutation) => ({
      status: mutation.state.status,
      variables: mutation.state.variables as Submission | undefined,
      error: mutation.state.error as Error | null,
    }),
  });
  const newest = submissions[submissions.length - 1];
  const sending = newest?.status === "pending" ? newest.variables?.action ?? null : null;
  const failed = newest?.status === "error" && newest.variables ? newest : null;
  const error = failed
    ? (failed.error instanceof ApiError && /cannot currently be reached|Disconnected/.test(failed.error.message)
        ? `Device unavailable. ${commandLabels[failed.variables!.action].name} was not sent. `
        : `${commandLabels[failed.variables!.action].name} was not sent. `) + failed.error!.message
    : "";
  const commands = useQuery({
    queryKey: ["device-commands", farm.id, device.id],
    queryFn: () => api<DeviceCommand[]>(`/devices/${encodeURIComponent(device.id)}/commands`),
    // Command history is for owners only; the API refuses it to viewers.
    enabled: canControl,
    refetchInterval: (query) =>
      query.state.data?.[0] && commandFeedback(query.state.data[0]).active ? 3000 : false,
  });
  const latest = commands.data?.[0];
  const feedback = latest ? commandFeedback(latest, online) : null;
  const busy = !!sending || !!feedback?.active;
  // Refresh device health once a command reaches its real outcome.
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (latest && !commandFeedback(latest).active && settled.current !== latest.id + latest.status) {
      if (settled.current !== null) {
        void cache.invalidateQueries({ queryKey: ["devices"] });
        // The device's next report (within seconds) carries the new state; fetch it again then.
        setTimeout(() => void cache.invalidateQueries({ queryKey: ["devices"] }), 8000);
      }
      settled.current = latest.id + latest.status;
    }
  }, [latest, cache]);

  async function send(action: DeviceCommandAction, extra?: { id: string; wifi?: WifiRequest; network?: SavedNetworkRequest }) {
    if (inFlight.has(device.id) || busy) return;
    inFlight.add(device.id);
    try {
      await submit.mutateAsync({ action, at: Date.now(), ...extra });
      settled.current = "";
    } catch {
      // Shown through the shared mutation state.
    } finally {
      inFlight.delete(device.id);
      await cache.invalidateQueries({ queryKey: ["device-commands", farm.id, device.id] });
    }
  }
  const [cancelError, setCancelError] = useState("");
  async function cancel() {
    if (!latest) return;
    setCancelling(true);
    setCancelError("");
    try {
      await api(`/devices/${encodeURIComponent(device.id)}/commands/${encodeURIComponent(latest.id)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (failure) {
      setCancelError((failure as Error).message);
    } finally {
      await commands.refetch();
      setCancelling(false);
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
  // Show the outcome next to the controls that issued it, for a while after it settles.
  const feedbackFor = (group: CommandGroup) =>
    latest && feedback && commandGroup(latest.action) === group &&
    // A settled result is not repeated while the device is unreachable: it may no longer hold.
    (feedback.active || (online && Date.now() - Date.parse(latest.updatedAt) < 15 * 60_000))
      ? feedback
      : null;
  // The action currently in progress (being sent, or waiting on the device), if any.
  const activeAction = sending ?? (feedback?.active ? latest!.action : null);
  // Progress or outcome for a request, with a way to withdraw it while the device has not collected it.
  const result = (shown: ReturnType<typeof commandFeedback> | null, group?: CommandGroup) => {
    if (sending && (!group || commandGroup(sending) === group))
      return (
        <div className="feedback-row">
          <p className="feedback command-progress" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" /> Sending…
          </p>
        </div>
      );
    return (
      shown && (
        <div className="feedback-row">
          <p className={`feedback ${shown.tone}${shown.active ? " command-progress" : ""}`} role="status">
            {shown.active && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
            {shown.active && <strong>{shown.step}</strong>} {shown.text}
          </p>
          {shown.cancellable && canControl && (
            <button disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? "Cancelling…" : "Cancel request"}
            </button>
          )}
        </div>
      )
    );
  };
  // A submission error next to the controls that issued it.
  const errorFor = (group: CommandGroup) =>
    failed && commandGroup(failed.variables!.action) === group ? error : "";
  const history = commands.data ?? [];
  return { online, latest, history, feedback, sending, activeAction, error: error || cancelError, errorFor, send, disabledReason, feedbackFor, result };
}
