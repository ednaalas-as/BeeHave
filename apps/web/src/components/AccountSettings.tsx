import type { Account } from "@beehave/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, useWorkspace } from "../api";
import { RoleBadge } from "./FarmMembers";
import { SettingsBlock } from "./SettingsSection";

/** The signed-in person: who they are and their role on the selected farm. Name and email can be
 * edited; a new email needs the current password. Farm administration lives under Farms & access. */
export function AccountSettings() {
  const { account, farm } = useWorkspace();
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(account.email);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const emailChanged = email.trim().toLowerCase() !== account.email;
  function start() {
    setEmail(account.email);
    setError("");
    setNotice("");
    setEditing(true);
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    setPending(true);
    setError("");
    try {
      const result = await api<{ account: Account }>("/auth/profile", {
        method: "POST",
        body: JSON.stringify({
          name: String(fields.get("fullName")),
          email,
          ...(emailChanged ? { currentPassword: String(fields.get("currentPassword")) } : {}),
        }),
      });
      cache.setQueryData(["session"], (session: { account: Account } | undefined) =>
        session ? { ...session, account: result.account } : session,
      );
      await cache.invalidateQueries({ queryKey: ["session"] });
      setEditing(false);
      setNotice("Account updated.");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsBlock>
      {editing ? (
        <form onSubmit={(e) => void save(e)}>
          <label>
            Full name
            <input name="fullName" autoComplete="name" defaultValue={account.name} required minLength={2} maxLength={100} disabled={pending} />
          </label>
          <label>
            Email
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} disabled={pending} />
          </label>
          {emailChanged && (
            <label>
              Current password
              <input type="password" name="currentPassword" autoComplete="current-password" required disabled={pending} />
              <span className="caption">Needed to change the email you sign in with.</span>
            </label>
          )}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="button-row">
            <button className="primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
            <button type="button" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <dl>
          <dt>Full name</dt>
          <dd>{account.name}</dd>
          <dt>Email</dt>
          <dd>{account.email}</dd>
          <dt>Selected farm</dt>
          <dd>{farm.name}</dd>
          <dt>Role on this farm</dt>
          <dd><RoleBadge role={farm.role} /></dd>
        </dl>
      )}
      {!editing && !account.demo && (
        <div className="button-row">
          <button className="subtle-button" onClick={start}>
            <Pencil size={14} /> Edit account information
          </button>
        </div>
      )}
      {notice && !editing && <p role="status" className="caption">{notice}</p>}
    </SettingsBlock>
  );
}
