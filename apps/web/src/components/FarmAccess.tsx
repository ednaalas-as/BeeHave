import type { FarmMembership } from "@beehave/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Leaf, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, useWorkspace } from "../api";
import { notCredential } from "../autofill";
import { Badge } from "../ui";
import { RoleBadge } from "./FarmMembers";
import { SettingsBlock } from "./SettingsSection";

type Action = "create" | "join" | "request";

/** Creates a farm (you become its Administrator), joins one with an administrator's invite code,
 * or asks a device's farm for access with the pairing code on its label. Farms are never listed:
 * an account reaches only farms it was granted. */
function FarmForm({ action, accountId, opened, cancel }: {
  action: Action;
  accountId: string;
  opened: (farm: FarmMembership) => void;
  cancel?: () => void;
}) {
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fields = new FormData(form);
    setPending(true);
    setError("");
    setNotice("");
    try {
      // The answer is the same whether or not the code matched a device, so it reveals nothing.
      if (action === "request") {
        await api("/device-access-requests", { method: "POST", body: JSON.stringify({ code: String(fields.get("pairingCode")) }) });
        form.reset();
        setNotice("Request sent. If this code belongs to an Edge Device a farm has registered, that farm's administrators can now approve your access.");
        return;
      }
      const farm = await api<FarmMembership>(action === "create" ? "/farms" : "/farm-invites/redeem", {
        method: "POST",
        body: JSON.stringify(
          action === "create"
            ? { name: String(fields.get("farmName")), location: String(fields.get("farmLocation")) }
            : { code: String(fields.get("inviteCode")) },
        ),
      });
      form.reset();
      await cache.invalidateQueries({ queryKey: ["farms", accountId] });
      await cache.invalidateQueries({ queryKey: ["session"] });
      opened(farm);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      {action === "create" ? (
        <>
          <label>
            Farm name
            <input {...notCredential} name="farmName" required minLength={2} maxLength={100} placeholder="North Coconut Farm" disabled={pending} />
          </label>
          <label>
            Farm location
            <input {...notCredential} name="farmLocation" maxLength={200} placeholder="Sariaya, Quezon" disabled={pending} />
          </label>
        </>
      ) : action === "request" ? (
        <label>
          Device pairing code
          <input {...notCredential} name="pairingCode" required minLength={6} maxLength={40} placeholder="ABCDE-23456" autoCapitalize="characters" disabled={pending} />
          <span className="caption">From the Edge Device’s label. The farm’s administrators decide whether you get access.</span>
        </label>
      ) : (
        <label>
          Invite code
          <input {...notCredential} name="inviteCode" required minLength={6} maxLength={40} placeholder="ABCDE-23456" autoCapitalize="characters" disabled={pending} />
          <span className="caption">From the farm’s administrator. Each code works once.</span>
        </label>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
      {notice && <p role="status" className="caption">{notice}</p>}
      <div className="button-row">
        <button className="primary" disabled={pending}>
          {action === "create"
            ? pending ? "Creating…" : "Create farm"
            : action === "request"
              ? pending ? "Sending…" : "Request access"
              : pending ? "Joining…" : "Join farm"}
        </button>
        {cancel && <button type="button" disabled={pending} onClick={cancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** For an account without any farm yet: both ways in, shown together. */
export function FarmAccess({ accountId, opened }: { accountId: string; opened: (farm: FarmMembership) => void }) {
  return (
    <section className="card padded farm-access">
      <h2>
        <Leaf size={18} /> Create or join a farm
      </h2>
      <p className="caption">You become the administrator of a farm you create.</p>
      <FarmForm action="create" accountId={accountId} opened={opened} />
      <FarmForm action="join" accountId={accountId} opened={opened} />
      <FarmForm action="request" accountId={accountId} opened={opened} />
    </section>
  );
}

/** Settings: the farms this account belongs to, then creating or joining another. The forms open
 * only when asked for. */
export function YourFarmsSection() {
  const { account, farms, farm: selected, setFarm } = useWorkspace();
  const [open, setOpen] = useState<Action | null>(null);
  const opened = (farm: FarmMembership) => {
    setOpen(null);
    setFarm(farm.id);
  };
  return (
    <SettingsBlock title="Your farms">
      <ul className="member-list">
        {farms.map((farm) => (
          <li key={farm.id}>
            <span>
              <strong>{farm.name}</strong>
            </span>
            <RoleBadge role={farm.role} />
            <span className="member-action">
              {farm.id === selected.id ? (
                <Badge tone="green">Selected</Badge>
              ) : (
                <button className="subtle-button" onClick={() => setFarm(farm.id)}>Open</button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {!account.demo && (
        open ? (
          <div className="settings-reveal">
            <h4 className="section-label">
              {open === "create" ? "Create a farm" : open === "request" ? "Request access to a device" : "Join a farm"}
            </h4>
            <FarmForm key={open} action={open} accountId={account.id} opened={opened} cancel={() => setOpen(null)} />
          </div>
        ) : (
          <div className="button-row">
            <button onClick={() => setOpen("create")}>
              <Plus size={16} /> Create farm
            </button>
            <button onClick={() => setOpen("join")}>Join farm</button>
            <button onClick={() => setOpen("request")}>Request device access</button>
          </div>
        )
      )}
    </SettingsBlock>
  );
}
