import { useQueryClient } from "@tanstack/react-query";
import { useState,type FormEvent } from "react";
import { api,useWorkspace } from "../api";
import { notCredential } from "../autofill";
import { AccountSettings } from "../components/AccountSettings";
import { YourFarmsSection } from "../components/FarmAccess";
import { NotificationSettings } from "../components/NotificationSettings";
import { AddPeopleSection, FarmMembersSection, FarmProfileSection, LeaveFarmSection } from "../components/FarmMembers";
import { SettingsBlock, SettingsSection } from "../components/SettingsSection";
import { clearSession } from "../query-client";
import { PageHeading } from "../ui";
import { readTextSize, saveTextSize, textSizes, type TextSize } from "../text-size";

export function SettingsPage() {
  const { account, refresh, setRefresh } = useWorkspace();
  const cache = useQueryClient();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [textSize, setTextSize] = useState(readTextSize);
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    if (data.password !== data.confirm) {
      setError("New passwords do not match.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await api("/auth/password", {
        method: "POST",
        body: JSON.stringify(data),
      });
      await clearSession(cache);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="settings-page">
      <PageHeading
        eyebrow="YOUR WORKSPACE PREFERENCES"
        title="Settings"
        description="Manage your account, farms, preferences and security."
      />
      {/* One column of collapsible groups, most-used first. Collapsed groups stay mounted, so
          nothing typed into a form is lost by closing its group. */}
      <div className="settings-sections">
        <SettingsSection title="Account" defaultOpen>
          <AccountSettings />
        </SettingsSection>
        <SettingsSection title="Farms & access" defaultOpen>
          <FarmProfileSection />
          <FarmMembersSection />
          <AddPeopleSection />
          <YourFarmsSection />
          <LeaveFarmSection />
        </SettingsSection>
        <SettingsSection title="Preferences">
          <NotificationSettings />
          <SettingsBlock>
            <div className="settings-fields">
              <label>
                Automatic refresh
                <select
                  {...notCredential}
                  value={refresh}
                  aria-describedby="refresh-help"
                  onChange={(e) => setRefresh(Number(e.target.value))}
                >
                  <option value="30">Every 30 seconds</option>
                  <option value="60">Every minute</option>
                  <option value="300">Every 5 minutes</option>
                  <option value="0">Manual only</option>
                </select>
                <span id="refresh-help" className="caption">
                  Reloads server data; it does not make the Pi upload.
                </span>
              </label>
              <label>
                Text size
                <select
                  {...notCredential}
                  value={textSize}
                  onChange={(e) => {
                    const size = e.target.value as TextSize;
                    setTextSize(size);
                    saveTextSize(size);
                  }}
                >
                  {Object.entries(textSizes).map(([value, { label }]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
            <dl>
              <dt>Report timezone</dt>
              <dd>Asia/Manila (UTC+8)</dd>
              <dt>Appearance</dt>
              <dd>Scientific light</dd>
            </dl>
          </SettingsBlock>
        </SettingsSection>
        <SettingsSection title="Security & about">
          <SettingsBlock title="Security">
            {account.demo ? (
              <p className="muted">
                Sample account credentials cannot be changed. Sign out and create
                your own account to manage a real workspace.
              </p>
            ) : (
              <form className="settings-fields" onSubmit={change}>
                <label>
                  Current password
                  <input
                    type="password"
                    name="currentPassword"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <label>
                  New password
                  <input
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                </label>
                <label>
                  Confirm new password
                  <input
                    type="password"
                    name="confirm"
                    autoComplete="new-password"
                    minLength={12}
                    required
                  />
                </label>
                {error && (
                  <p role="alert" className="form-error">
                    {error}
                  </p>
                )}
                <div>
                  <button disabled={pending}>
                    {pending ? "Updating…" : "Change password and sign out"}
                  </button>
                  <p className="caption">Signs you out on every device.</p>
                </div>
              </form>
            )}
          </SettingsBlock>
          <SettingsBlock title="About BeeHave" className="settings-about">
            <p className="caption">
              A bioacoustic monitoring system for observing bee activity around
              coconut flowers.
            </p>
            <dl>
              <dt>Version</dt>
              <dd>0.1.0 · Local prototype</dd>
              <dt>Data storage</dt>
              <dd>PostgreSQL database</dd>
              <dt>Evidence policy</dt>
              <dd>Read-only detection records. No user recording deletion.</dd>
            </dl>
            <div className="notice">
              Email recovery requires an additional service integration.
            </div>
          </SettingsBlock>
        </SettingsSection>
      </div>
    </div>
  );
}
