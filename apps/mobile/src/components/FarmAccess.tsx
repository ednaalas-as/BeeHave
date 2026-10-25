import type { FarmInvite, FarmMembership, FarmProfile, FarmRole } from "@beehave/shared";
import { colors } from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { apiRequest } from "../api";
import { useFarm } from "../farm";
import { useRemote } from "../hooks/useRemote";
import { styles } from "../styles";
import { Button, Card, Field, Pair } from "./FormControls";
import { SelectionSheet } from "./SelectionSheet";
import { SettingsBlock, TextAction } from "./SettingsSection";
import { Feedback, StatusBadge } from "./Sheet";

const roleLabel: Record<FarmRole, string> = { owner: "Administrator", viewer: "Viewer" };
const roleOptions = [
  { label: "Viewer", value: "viewer" },
  { label: "Administrator", value: "owner" },
];

// The same badge for a role everywhere in Settings.
export function RoleBadge({ role }: { role: FarmRole }) {
  return <Text style={[styles.statusBadge, role === "owner" ? styles.roleAdmin : styles.toneNeutral]}>{roleLabel[role]}</Text>;
}

// A role picker that looks like the app's other selectors.
function RolePicker({ title, value, onChange, disabled = false }: {
  title: string;
  value: FarmRole;
  onChange: (role: FarmRole) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${roleLabel[value]}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.button, styles.buttonWithIcon, disabled && styles.disabled, pressed && styles.pressed]}
      >
        <Text style={styles.buttonText}>{roleLabel[value]}</Text>
        <Feather name="chevron-down" size={14} color={colors.slate} />
      </Pressable>
      <SelectionSheet
        title={title}
        visible={open}
        selected={value}
        options={roleOptions}
        onSelect={(role) => onChange(role as FarmRole)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** Create a farm (you become its Administrator), join one with an invite code, or ask a device's
 * farm for access with the pairing code on its label. */
function FarmForm({ action, opened, cancel }: {
  action: "create" | "join" | "request";
  opened: (farm: FarmMembership) => void;
  cancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // The answer is the same whether or not the code matched a device, so it reveals nothing.
      if (action === "request") {
        await apiRequest("/device-access-requests", { method: "POST", body: JSON.stringify({ code }) });
        setCode("");
        setNotice("Request sent. If this code belongs to an Edge Device a farm has registered, that farm's administrators can now approve your access.");
        return;
      }
      const farm = await apiRequest<FarmMembership>(action === "create" ? "/farms" : "/farm-invites/redeem", {
        method: "POST",
        body: JSON.stringify(action === "create" ? { name, location } : { code }),
      });
      setName("");
      setLocation("");
      setCode("");
      opened(farm);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {action === "create" ? (
        <>
          <Field label="Farm name" value={name} onChange={setName} />
          <Field label="Farm location (optional)" value={location} onChange={setLocation} />
        </>
      ) : (
        <Field label={action === "request" ? "Device pairing code" : "Invite code"} value={code} onChange={setCode} />
      )}
      {action === "request" && (
        <Text style={styles.caption}>From the Edge Device’s label. The farm’s administrators decide whether you get access.</Text>
      )}
      {!!error && <Feedback tone="bad">{error}</Feedback>}
      {!!notice && <Feedback tone="good">{notice}</Feedback>}
      <Button
        primary
        title={action === "create"
          ? busy ? "Creating…" : "Create farm"
          : action === "request"
            ? busy ? "Sending…" : "Request access"
            : busy ? "Joining…" : "Join farm"}
        disabled={busy || (action === "create" ? name.trim().length < 2 : code.trim().length < 6)}
        onPress={() => void submit()}
      />
      {cancel && <Button title="Cancel" disabled={busy} onPress={cancel} />}
    </>
  );
}

/** For an account without any farm yet: both ways in, shown together. */
export function FarmAccess({ opened }: { opened: (farm: FarmMembership) => void }) {
  return (
    <Card>
      <Text style={styles.subtitle}>Create or join a farm</Text>
      <FarmForm action="create" opened={opened} />
      <View style={styles.settingsDivider} />
      <FarmForm action="join" opened={opened} />
      <View style={styles.settingsDivider} />
      <FarmForm action="request" opened={opened} />
    </Card>
  );
}

/** Farms & access in Settings: the selected farm's profile, members and invitations, the
 * account's farms, and leaving. One profile request serves every part. */
export function FarmsAndAccess({ accountId, expired, opened, left }: {
  // The signed-in account, marked "(you)" and the one that leaves.
  accountId: string;
  expired: () => void;
  // Open a farm (one just created or joined, or another of this account's farms).
  opened: (farm: FarmMembership) => void;
  // This account left the selected farm.
  left: () => void;
}) {
  const { farm } = useFarm();
  const profile = useRemote<FarmProfile>(`/farms/${encodeURIComponent(farm.id)}`, expired, 30_000);
  const data = profile.data;
  return (
    <>
      {!data ? (
        <SettingsBlock title="Farm profile" first>
          {profile.error ? <Feedback tone="bad">{profile.error}</Feedback> : <Text style={styles.muted}>Loading farm profile…</Text>}
        </SettingsBlock>
      ) : (
        <>
          <FarmProfileBlock profile={data} changed={() => { profile.refresh(); opened(farm); }} />
          <MembersBlock profile={data} accountId={accountId} changed={profile.refresh} />
          {data.members && <AddPeopleBlock profile={data} changed={profile.refresh} />}
        </>
      )}
      <YourFarmsBlock opened={opened} />
      {data && !data.demo && <LeaveFarmBlock profile={data} accountId={accountId} left={left} />}
    </>
  );
}

/** Read-only for viewers; administrators edit the name and location. */
function FarmProfileBlock({ profile, changed }: { profile: FarmProfile; changed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [location, setLocation] = useState(profile.location ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEdit = profile.role === "owner" && !profile.demo;
  function start() {
    setName(profile.name);
    setLocation(profile.location ?? "");
    setError("");
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/farms/${encodeURIComponent(profile.id)}`, { method: "POST", body: JSON.stringify({ name, location }) });
      setEditing(false);
      // The farm name also shows in the farm selector.
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsBlock title="Farm profile" first action={canEdit && !editing ? <TextAction title="Edit" onPress={start} /> : undefined}>
      {editing ? (
        <>
          <Field label="Farm name" value={name} onChange={setName} />
          <Field label="Farm location" value={location} onChange={setLocation} />
          {!!error && <Feedback tone="bad">{error}</Feedback>}
          <View style={styles.row}>
            <View style={styles.grow}>
              <Button primary title={busy ? "Saving…" : "Save"} disabled={busy || name.trim().length < 2} onPress={() => void save()} />
            </View>
            <View style={styles.grow}>
              <Button title="Cancel" disabled={busy} onPress={() => setEditing(false)} />
            </View>
          </View>
        </>
      ) : (
        <View>
          <Pair label="Farm name" value={profile.name} />
          <Pair label="Location" value={profile.location || "Not set"} />
          <Pair label="Administrators" value={profile.owners.join(", ") || "None"} />
          <Pair
            label="Edge devices"
            value={profile.devices.length ? `${profile.devices.length} · ${profile.devices.map((device) => device.name).join(", ")}` : "None registered"}
          />
          <View style={styles.pair}>
            <Text style={styles.muted}>Your role</Text>
            <RoleBadge role={profile.role} />
          </View>
        </View>
      )}
    </SettingsBlock>
  );
}

/** Members in a compact list. Administrators change roles, remove people and answer access
 * requests; the last administrator can neither step down nor leave. */
function MembersBlock({ profile, accountId, changed }: { profile: FarmProfile; accountId: string; changed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const path = `/farms/${encodeURIComponent(profile.id)}`;
  const owners = profile.members?.filter((member) => member.role === "owner").length ?? profile.owners.length;
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      setConfirming(null);
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!profile.members)
    return (
      <SettingsBlock title="Members & access">
        <Text style={styles.muted}>Administrators manage who can open this farm.</Text>
      </SettingsBlock>
    );
  return (
    <SettingsBlock title="Members & access">
      <View>
        {profile.members.map((member, index) => {
          const self = member.accountId === accountId;
          const last = member.role === "owner" && owners <= 1;
          return (
            <View key={member.accountId} style={[styles.memberRow, index === 0 && styles.memberRowFirst]}>
              <View>
                <Text style={styles.body}>{member.name}{self ? " (you)" : ""}</Text>
                <Text style={styles.caption}>{member.email}</Text>
              </View>
              <View style={styles.memberActions}>
                <RolePicker
                  title={`Role for ${member.name}`}
                  value={member.role}
                  disabled={busy || last}
                  onChange={(role) => role !== member.role && void act(() =>
                    apiRequest(`${path}/members/${encodeURIComponent(member.accountId)}/role`, { method: "POST", body: JSON.stringify({ role }) }),
                  )}
                />
                {self ? null : confirming === member.accountId ? (
                  <View style={styles.roleChip}>
                    <Button warning title="Remove" disabled={busy} onPress={() => void act(() =>
                      apiRequest(`${path}/members/${encodeURIComponent(member.accountId)}/remove`, { method: "POST", body: JSON.stringify({ confirm: true }) }),
                    )} />
                    <TextAction title="Cancel" onPress={() => setConfirming(null)} />
                  </View>
                ) : (
                  <TextAction title="Remove" disabled={busy} onPress={() => setConfirming(member.accountId)} />
                )}
              </View>
            </View>
          );
        })}
      </View>
      {!!profile.requests?.length && (
        <>
          <Text style={styles.eyebrowSmall}>Asking to connect</Text>
          {profile.requests.map((request) => (
            <View key={request.accountId} style={styles.memberRow}>
              <View>
                <Text style={styles.body}>{request.name}</Text>
                <Text style={styles.caption}>{request.email}</Text>
                {!!request.deviceName && <Text style={styles.caption}>With the pairing code of {request.deviceName}</Text>}
              </View>
              <View style={styles.row}>
                <View style={styles.grow}>
                  <Button primary title="Approve" disabled={busy} onPress={() => void act(() =>
                    apiRequest(`${path}/requests/${encodeURIComponent(request.accountId)}/approve`, { method: "POST", body: "{}" }),
                  )} />
                </View>
                <View style={styles.grow}>
                  <Button title="Decline" disabled={busy} onPress={() => void act(() =>
                    apiRequest(`${path}/requests/${encodeURIComponent(request.accountId)}/decline`, { method: "POST", body: "{}" }),
                  )} />
                </View>
              </View>
            </View>
          ))}
        </>
      )}
      {!!error && <Feedback tone="bad">{error}</Feedback>}
    </SettingsBlock>
  );
}

/** Administrators add people by email or with a single-use invite code; each form opens only
 * when asked for, and a new code is shown once. */
function AddPeopleBlock({ profile, changed }: { profile: FarmProfile; changed: () => void }) {
  const [open, setOpen] = useState<"member" | "invite" | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<FarmRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<(FarmInvite & { code: string }) | null>(null);
  const path = `/farms/${encodeURIComponent(profile.id)}`;
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const show = (form: "member" | "invite") => {
    setRole("viewer");
    setError("");
    setOpen(form);
  };
  return (
    <SettingsBlock title="Add people">
      {open === "member" ? (
        <>
          <Field label="Email" value={email} onChange={setEmail} />
          <Text style={styles.caption}>They need a BeeHave account first.</Text>
          <RolePicker title="Role" value={role} onChange={setRole} disabled={busy} />
          <Button primary title={busy ? "Granting…" : "Grant access"} disabled={busy || !email.includes("@")} onPress={() => void act(async () => {
            await apiRequest(`${path}/members`, { method: "POST", body: JSON.stringify({ email, role }) });
            setNotice(`${email} can now open ${profile.name} as ${roleLabel[role].toLowerCase()}.`);
            setEmail("");
            setOpen(null);
          })} />
          <Button title="Cancel" disabled={busy} onPress={() => setOpen(null)} />
        </>
      ) : open === "invite" ? (
        <>
          <RolePicker title="Role" value={role} onChange={setRole} disabled={busy} />
          <Button primary title={busy ? "Creating…" : "Create invite code"} disabled={busy} onPress={() => void act(async () => {
            setCreated(await apiRequest<FarmInvite & { code: string }>(`${path}/invites`, { method: "POST", body: JSON.stringify({ role }) }));
            setOpen(null);
          })} />
          <Button title="Cancel" disabled={busy} onPress={() => setOpen(null)} />
        </>
      ) : (
        <View style={styles.row}>
          <View style={styles.grow}>
            <Button icon="user-plus" title="Add member" onPress={() => show("member")} />
          </View>
          <View style={styles.grow}>
            <Button icon="hash" title="Invite code" onPress={() => show("invite")} />
          </View>
        </View>
      )}
      {created && (
        <>
          <Text selectable style={styles.notice}>{created.code}</Text>
          <Text style={styles.caption}>
            {roleLabel[created.role]} · single use · expires {new Date(created.expiresAt).toLocaleString()}. Copy it now; it is not shown again.
          </Text>
        </>
      )}
      {!!profile.invites?.length && (
        <>
          <Text style={styles.eyebrowSmall}>Unused invite codes</Text>
          {profile.invites.map((invite) => (
            <View key={invite.id} style={[styles.row, styles.memberRow]}>
              <View style={styles.grow}>
                <Text style={styles.body}>{roleLabel[invite.role]} invite</Text>
                <Text style={styles.caption}>Expires {new Date(invite.expiresAt).toLocaleString()}</Text>
              </View>
              <TextAction title="Revoke" disabled={busy} onPress={() => void act(async () => {
                await apiRequest(`${path}/invites/${encodeURIComponent(invite.id)}/revoke`, { method: "POST", body: "{}" });
                if (created?.id === invite.id) setCreated(null);
              })} />
            </View>
          ))}
        </>
      )}
      {!!notice && <Feedback tone="good">{notice}</Feedback>}
      {!!error && <Feedback tone="bad">{error}</Feedback>}
    </SettingsBlock>
  );
}

/** The account's farms, then creating or joining another; each form opens only when asked for. */
function YourFarmsBlock({ opened }: { opened: (farm: FarmMembership) => void }) {
  const { farm: selected, farms } = useFarm();
  const [open, setOpen] = useState<"create" | "join" | "request" | null>(null);
  return (
    <SettingsBlock title="Your farms">
      <View>
        {farms.map((farm, index) => (
          <View key={farm.id} style={[styles.row, styles.memberRow, index === 0 && styles.memberRowFirst]}>
            <Text style={[styles.body, styles.grow]} numberOfLines={2}>{farm.name}</Text>
            <RoleBadge role={farm.role} />
            {farm.id === selected.id ? (
              <StatusBadge tone="good">Selected</StatusBadge>
            ) : (
              <TextAction title="Open" onPress={() => opened(farm)} />
            )}
          </View>
        ))}
      </View>
      {open ? (
        <>
          <Text style={styles.eyebrowSmall}>
            {open === "create" ? "Create a farm" : open === "request" ? "Request access to a device" : "Join a farm"}
          </Text>
          <FarmForm key={open} action={open} opened={(farm) => { setOpen(null); opened(farm); }} cancel={() => setOpen(null)} />
        </>
      ) : (
        <View style={styles.row}>
          <View style={styles.grow}>
            <Button icon="plus" title="Create farm" onPress={() => setOpen("create")} />
          </View>
          <View style={styles.grow}>
            <Button title="Join farm" onPress={() => setOpen("join")} />
          </View>
        </View>
      )}
      {!open && <Button title="Request device access" onPress={() => setOpen("request")} />}
    </SettingsBlock>
  );
}

/** Leaving the selected farm: last and quiet. The last administrator cannot leave. */
function LeaveFarmBlock({ profile, accountId, left }: { profile: FarmProfile; accountId: string; left: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owners = profile.members?.filter((member) => member.role === "owner").length ?? profile.owners.length;
  const blocked = profile.role === "owner" && owners <= 1;
  return (
    <SettingsBlock>
      {confirming ? (
        <View style={styles.row}>
          <View style={styles.grow}>
            <Button warning busy={busy} title={`Leave ${profile.name}`} onPress={() => void (async () => {
              setBusy(true);
              setError("");
              try {
                await apiRequest(`/farms/${encodeURIComponent(profile.id)}/members/${encodeURIComponent(accountId)}/remove`, { method: "POST", body: JSON.stringify({ confirm: true }) });
                left();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            })()} />
          </View>
          <TextAction title="Cancel" disabled={busy} onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <Pressable accessibilityRole="button" disabled={blocked} onPress={() => setConfirming(true)} hitSlop={8}>
          <Text style={[styles.muted, blocked && styles.disabled]}>Leave this farm</Text>
        </Pressable>
      )}
      {blocked && <Text style={styles.caption}>Make another member an administrator before leaving.</Text>}
      {!!error && <Feedback tone="bad">{error}</Feedback>}
    </SettingsBlock>
  );
}
