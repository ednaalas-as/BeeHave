import type { FarmInvite, FarmProfile, FarmRole } from "@beehave/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Ticket } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { api, useWorkspace } from "../api";
import { notCredential } from "../autofill";
import { Badge } from "../ui";
import { SettingsBlock } from "./SettingsSection";

const roleLabel: Record<FarmRole, string> = { owner: "Administrator", viewer: "Viewer" };

// The same badge for a role everywhere on the page.
export function RoleBadge({ role }: { role: FarmRole }) {
  return <Badge tone={role === "owner" ? "blue" : "gray"}>{roleLabel[role]}</Badge>;
}

function useFarmProfile() {
  const { farm } = useWorkspace();
  const path = `/farms/${encodeURIComponent(farm.id)}`;
  const query = useQuery({
    queryKey: ["farm-profile", farm.id],
    queryFn: () => api<FarmProfile>(path),
  });
  return { path, query };
}

/** The selected farm's access changes. Each subsection keeps its own progress and messages; the
 * API enforces every rule, including keeping at least one administrator. */
function useFarmAccess() {
  const { account, farm } = useWorkspace();
  const cache = useQueryClient();
  const { path, query } = useFarmProfile();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  async function change(work: () => Promise<unknown>, done: string, self = false) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(done);
      setConfirming(null);
      await cache.invalidateQueries({ queryKey: ["farm-profile", farm.id] });
      // The account's own farm list and role come with the session.
      if (self) {
        await cache.invalidateQueries({ queryKey: ["session"] });
        await cache.invalidateQueries({ queryKey: ["farms"] });
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }
  const remove = (member: string) =>
    change(
      () => api(`${path}/members/${encodeURIComponent(member)}/remove`, { method: "POST", body: JSON.stringify({ confirm: true }) }),
      member === account.id ? `You left ${farm.name}.` : "Access removed.",
      member === account.id,
    );
  const profile = query.data;
  const owners = profile?.members?.filter((member) => member.role === "owner").length ?? profile?.owners.length ?? 0;
  // The last administrator cannot step down or leave; the farm would have no administrator.
  const lastOwner = (role: FarmRole) => role === "owner" && owners <= 1;
  const messages = (
    <>
      {error && <p role="alert" className="form-error">{error}</p>}
      {notice && <p role="status" className="caption">{notice}</p>}
    </>
  );
  return { account, farm, path, query, profile, pending, confirming, setConfirming, change, remove, lastOwner, messages };
}

/** The selected farm's profile. Administrators edit its name and location; viewers only read it. */
export function FarmProfileSection() {
  const { farm } = useWorkspace();
  const cache = useQueryClient();
  const { path, query } = useFarmProfile();
  const profile = query.data;
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const canEdit = !!profile && profile.role === "owner" && !profile.demo;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    setPending(true);
    setError("");
    try {
      await api(path, {
        method: "POST",
        body: JSON.stringify({ name: String(fields.get("farmName")), location: String(fields.get("farmLocation")) }),
      });
      await cache.invalidateQueries({ queryKey: ["farm-profile", farm.id] });
      // The farm selector shows the name.
      await cache.invalidateQueries({ queryKey: ["farms"] });
      await cache.invalidateQueries({ queryKey: ["session"] });
      setEditing(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsBlock
      title="Farm profile"
      action={canEdit && !editing && (
        <button className="subtle-button" onClick={() => { setError(""); setEditing(true); }}>
          <Pencil size={14} /> Edit farm profile
        </button>
      )}
    >
      {query.isPending ? (
        <p className="muted">Loading farm profile…</p>
      ) : query.isError ? (
        <p role="alert" className="form-error">{(query.error as Error).message}</p>
      ) : profile && editing ? (
        <form onSubmit={(e) => void save(e)}>
          <label>
            Farm name
            <input {...notCredential} name="farmName" defaultValue={profile.name} required minLength={2} maxLength={100} disabled={pending} />
          </label>
          <label>
            Farm location
            <input {...notCredential} name="farmLocation" defaultValue={profile.location ?? ""} maxLength={200} placeholder="Sariaya, Quezon" disabled={pending} />
          </label>
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="button-row">
            <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
            <button type="button" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : profile && (
        <dl>
          <dt>Farm name</dt>
          <dd>{profile.name}</dd>
          <dt>Location</dt>
          <dd className={profile.location ? undefined : "muted"}>{profile.location || "Not set"}</dd>
          <dt>Administrators</dt>
          <dd>{profile.owners.join(", ") || "None"}</dd>
          <dt>Edge devices</dt>
          <dd>
            {profile.devices.length
              ? `${profile.devices.length} · ${profile.devices.map((device) => device.name).join(", ")}`
              : "None registered"}
          </dd>
          <dt>Your role</dt>
          <dd><RoleBadge role={profile.role} /></dd>
        </dl>
      )}
    </SettingsBlock>
  );
}

/** Who can open the selected farm. Administrators change roles, remove members and answer
 * access requests; viewers see a short note instead. */
export function FarmMembersSection() {
  const { account, farm, path, profile, pending, confirming, setConfirming, change, remove, lastOwner, messages } = useFarmAccess();
  // An access-request notification opens Settings at the requests (?section=requests).
  const linked = new URLSearchParams(useLocation().search).get("section") === "requests";
  const requestsRef = useRef<HTMLHeadingElement>(null);
  const cache = useQueryClient();
  useEffect(() => {
    if (linked) void cache.invalidateQueries({ queryKey: ["farm-profile", farm.id] });
  }, [linked, cache, farm.id]);
  const hasRequests = !!profile?.requests?.length;
  useEffect(() => {
    if (linked && hasRequests) requestsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [linked, hasRequests]);
  if (!profile) return null;
  const setRole = (member: string, role: FarmRole) =>
    change(
      () => api(`${path}/members/${encodeURIComponent(member)}/role`, { method: "POST", body: JSON.stringify({ role }) }),
      "Access updated.",
      member === account.id,
    );
  return (
    <SettingsBlock title="Members & access">
      {!profile.members ? (
        <p className="muted">Administrators manage who can open this farm.</p>
      ) : (
        <ul className="member-list">
          {profile.members.map((member) => (
            <li key={member.accountId}>
              <span>
                <strong>{member.name}{member.accountId === account.id ? " (you)" : ""}</strong>
                <small className="muted">{member.email}</small>
              </span>
              <select
                {...notCredential}
                aria-label={`Role for ${member.name}`}
                value={member.role}
                disabled={pending || lastOwner(member.role)}
                title={lastOwner(member.role) ? "A farm needs at least one administrator." : undefined}
                onChange={(e) => void setRole(member.accountId, e.target.value as FarmRole)}
              >
                <option value="owner">Administrator</option>
                <option value="viewer">Viewer</option>
              </select>
              <span className="member-action">
                {member.accountId === account.id ? null : confirming === member.accountId ? (
                  <>
                    <button className="warning" disabled={pending} onClick={() => void remove(member.accountId)}>Remove</button>
                    <button className="subtle-button" disabled={pending} onClick={() => setConfirming(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="subtle-button" disabled={pending} onClick={() => setConfirming(member.accountId)}>Remove</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!!profile.requests?.length && (
        <>
          <h4 className="section-label" id="farm-requests" ref={requestsRef}>Asking to connect</h4>
          <ul className="member-list">
            {profile.requests.map((request) => (
              <li key={request.accountId}>
                <span>
                  <strong>{request.name}</strong>
                  <small className="muted">{request.email}</small>
                  {request.deviceName && <small className="muted">With the pairing code of {request.deviceName}</small>}
                </span>
                <span className="member-action">
                  <button
                    disabled={pending}
                    onClick={() => void change(
                      () => api(`${path}/requests/${encodeURIComponent(request.accountId)}/approve`, { method: "POST", body: "{}" }),
                      `${request.name} can now view ${farm.name}.`,
                    )}
                  >
                    Approve
                  </button>
                  <button
                    className="subtle-button"
                    disabled={pending}
                    onClick={() => void change(
                      () => api(`${path}/requests/${encodeURIComponent(request.accountId)}/decline`, { method: "POST", body: "{}" }),
                      "Request declined.",
                    )}
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {messages}
    </SettingsBlock>
  );
}

/** Administrators add people by email or with a single-use invite code. Each form opens only when
 * asked for; a new code is shown once, right after it is created. */
export function AddPeopleSection() {
  const { farm, path, profile, pending, change, messages } = useFarmAccess();
  const [open, setOpen] = useState<"member" | "invite" | null>(null);
  const [created, setCreated] = useState<(FarmInvite & { code: string }) | null>(null);
  if (!profile?.members) return null;
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fields = new FormData(form);
    // The field is not named "email" so browsers do not treat it as a sign-in username.
    const data = { email: String(fields.get("memberEmail")), role: fields.get("role") as FarmRole };
    void change(async () => {
      await api(`${path}/members`, { method: "POST", body: JSON.stringify(data) });
      form.reset();
    }, `${data.email} can now open ${farm.name} as ${roleLabel[data.role].toLowerCase()}.`).then((ok) => ok && setOpen(null));
  }
  function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const role = new FormData(e.currentTarget).get("inviteRole") as FarmRole;
    void change(async () => {
      setCreated(await api<FarmInvite & { code: string }>(`${path}/invites`, { method: "POST", body: JSON.stringify({ role }) }));
    }, "").then((ok) => ok && setOpen(null));
  }
  const revoke = (id: string) =>
    change(async () => {
      await api(`${path}/invites/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
      if (created?.id === id) setCreated(null);
    }, "Invite code revoked.");
  return (
    <SettingsBlock title="Add people">
      {open === "member" ? (
        <form className="inline-form" onSubmit={add}>
          <label className="grow">
            Email
            <input {...notCredential} type="email" name="memberEmail" required maxLength={254} placeholder="name@example.com" disabled={pending} autoFocus />
            <span className="caption">They need a BeeHave account first.</span>
          </label>
          <label>
            Role
            <select {...notCredential} name="role" defaultValue="viewer" disabled={pending}>
              <option value="viewer">Viewer</option>
              <option value="owner">Administrator</option>
            </select>
          </label>
          <div className="button-row inline-actions">
            <button className="primary" disabled={pending}>Grant access</button>
            <button type="button" disabled={pending} onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      ) : open === "invite" ? (
        <form className="inline-form" onSubmit={invite}>
          <label className="grow">
            Role
            <select {...notCredential} name="inviteRole" defaultValue="viewer" disabled={pending}>
              <option value="viewer">Viewer</option>
              <option value="owner">Administrator</option>
            </select>
          </label>
          <div className="button-row inline-actions">
            <button className="primary" disabled={pending}>Create invite code</button>
            <button type="button" disabled={pending} onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="button-row">
          <button onClick={() => setOpen("member")}>
            <Plus size={16} /> Add member
          </button>
          <button onClick={() => setOpen("invite")}>
            <Ticket size={16} /> Create invite code
          </button>
        </div>
      )}
      {created && (
        <div className="feedback good invite-result" role="status">
          <strong className="mono invite-code">{created.code}</strong>
          <p>
            {roleLabel[created.role]} · single use · expires {new Date(created.expiresAt).toLocaleString()}. Copy it now; it is not shown again.
          </p>
        </div>
      )}
      {!!profile.invites?.length && (
        <>
          <h4 className="section-label">Unused invite codes</h4>
          <ul className="member-list">
            {profile.invites.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{roleLabel[item.role]} invite</strong>
                  <small className="muted">By {item.createdBy} · expires {new Date(item.expiresAt).toLocaleString()}</small>
                </span>
                <span className="member-action">
                  <button className="subtle-button" disabled={pending} onClick={() => void revoke(item.id)}>Revoke</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {messages}
    </SettingsBlock>
  );
}

/** Leaving the selected farm: kept last and quiet. The last administrator cannot leave. */
export function LeaveFarmSection() {
  const { account, profile, pending, confirming, setConfirming, remove, lastOwner, messages } = useFarmAccess();
  if (!profile || profile.demo) return null;
  const blocked = lastOwner(profile.role);
  return (
    <SettingsBlock className="settings-danger">
      <div className="settings-danger-row">
        {confirming === account.id ? (
          <>
            <button className="warning" disabled={pending} onClick={() => void remove(account.id)}>
              Leave {profile.name}
            </button>
            <button className="subtle-button" disabled={pending} onClick={() => setConfirming(null)}>Cancel</button>
          </>
        ) : (
          <button className="subtle-button" disabled={pending || blocked} onClick={() => setConfirming(account.id)}>
            Leave this farm
          </button>
        )}
        {blocked && <span className="caption">Make another member an administrator before leaving.</span>}
      </div>
      {messages}
    </SettingsBlock>
  );
}
