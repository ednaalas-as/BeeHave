import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "../api";
import { disablePush, enablePush, pushState, type PushState } from "../push";
import { Badge } from "../ui";
import { SettingsBlock } from "./SettingsSection";

const explanation: Record<PushState, string> = {
  unsupported: "This browser does not support push notifications.",
  insecure: "Browsers allow notifications only on a secure (HTTPS) BeeHave address or on localhost.",
  unconfigured: "Notifications are not set up on this BeeHave server yet.",
  denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then reload this page.",
  off: "Get a notification when an Edge Device comes online or someone asks for access to your farm.",
  on: "This browser gets a notification when an Edge Device comes online or someone asks for access to your farm.",
};

/** Turns push notifications on or off for this browser. The browser asks for permission only
 * when someone presses Turn on. */
export function NotificationSettings() {
  const { account } = useWorkspace();
  const cache = useQueryClient();
  const state = useQuery({ queryKey: ["push-state", account.id], queryFn: () => pushState(account.id) });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function change(on: boolean) {
    setPending(true);
    setError("");
    try {
      await (on ? enablePush(account.id) : disablePush(account.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await cache.invalidateQueries({ queryKey: ["push-state", account.id] });
      setPending(false);
    }
  }
  if (account.demo) return null;
  const value = state.data;
  return (
    <SettingsBlock
      title="Notifications"
      action={value === "on" ? <Badge tone="green">On</Badge> : value === "off" ? <Badge tone="gray">Off</Badge> : undefined}
    >
      <p className="caption">{value ? explanation[value] : state.isError ? (state.error as Error).message : "Checking this browser…"}</p>
      {(value === "on" || value === "off") && (
        <div className="button-row">
          {value === "off" ? (
            <button disabled={pending} onClick={() => void change(true)}>
              <Bell size={16} /> {pending ? "Turning on…" : "Turn on for this browser"}
            </button>
          ) : (
            <button className="subtle-button" disabled={pending} onClick={() => void change(false)}>
              <BellOff size={16} /> {pending ? "Turning off…" : "Turn off for this browser"}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
    </SettingsBlock>
  );
}
