import type { Account } from "@beehave/shared";
import { useState } from "react";
import { Text, View } from "react-native";
import { apiRequest } from "../api";
import { useFarm } from "../farm";
import { styles } from "../styles";
import { RoleBadge } from "./FarmAccess";
import { Button, Field, Pair } from "./FormControls";
import { SettingsBlock, TextAction } from "./SettingsSection";
import { Feedback } from "./Sheet";

/** The signed-in person and their role on the selected farm. Name and email can be edited; a new
 * email needs the current password. */
export function AccountSettings({ account, changed }: { account: Account; changed: () => void }) {
  const { farm } = useFarm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [currentPassword, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const emailChanged = email.trim().toLowerCase() !== account.email;
  function start() {
    setName(account.name);
    setEmail(account.email);
    setCurrent("");
    setError("");
    setNotice("");
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiRequest("/auth/profile", {
        method: "POST",
        body: JSON.stringify({ name, email, ...(emailChanged ? { currentPassword } : {}) }),
      });
      setCurrent("");
      setEditing(false);
      setNotice("Account updated.");
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsBlock first>
      {editing ? (
        <>
          <Field label="Full name" value={name} onChange={setName} account="name" />
          <Field label="Email" value={email} onChange={setEmail} account="email" />
          {emailChanged && (
            <>
              <Field label="Current password" value={currentPassword} onChange={setCurrent} secure account="password" />
              <Text style={styles.caption}>Needed to change the email you sign in with.</Text>
            </>
          )}
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
          <Pair label="Full name" value={account.name} />
          <Pair label="Email" value={account.email} />
          <Pair label="Selected farm" value={farm.name} />
          <View style={styles.pair}>
            <Text style={styles.muted}>Role on this farm</Text>
            <RoleBadge role={farm.role} />
          </View>
        </View>
      )}
      {!editing && !account.demo && <TextAction title="Edit account information" onPress={start} />}
      {!!notice && !editing && <Feedback tone="good">{notice}</Feedback>}
    </SettingsBlock>
  );
}
