import { type Account, type FarmMembership } from "@beehave/shared";
import { ScrollView, Text, View } from "react-native";
import { AccountSettings } from "../components/AccountSettings";
import { FarmsAndAccess } from "../components/FarmAccess";
import { Button, Pair } from "../components/FormControls";
import { NotificationSettings } from "../components/NotificationSettings";
import { PasswordChange } from "../components/PasswordChange";
import { SettingsBlock, SettingsSection } from "../components/SettingsSection";
import { styles } from "../styles";

/** Four collapsible groups, most-used first. Collapsed groups stay mounted, so nothing typed into
 * a form is lost by closing its group. */
export function SettingsScreen({
  account,
  expired,
  logout,
  opened,
  refreshSession,
}: {
  account: Account;
  expired: () => void;
  logout: () => void;
  // Open a farm: one just created or joined, or another of this account's farms.
  opened: (farm: FarmMembership) => void;
  // Reload the account and its farms after a change to either.
  refreshSession: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Settings</Text>
      <SettingsSection title="Account" defaultOpen>
        <AccountSettings account={account} changed={refreshSession} />
      </SettingsSection>
      <SettingsSection title="Farms & access" defaultOpen>
        <FarmsAndAccess accountId={account.id} expired={expired} opened={opened} left={refreshSession} />
      </SettingsSection>
      <SettingsSection title="Preferences">
        {!account.demo && <NotificationSettings accountId={account.id} />}
        <SettingsBlock first={account.demo}>
          <View>
            <Pair label="Automatic refresh" value="Every minute" />
            <Pair label="Text size" value="Follows your phone" />
            <Pair label="Report timezone" value="Asia/Manila (UTC+8)" />
            <Pair label="Appearance" value="Scientific light" />
          </View>
        </SettingsBlock>
      </SettingsSection>
      <SettingsSection title="Security & about">
        {account.demo ? (
          <SettingsBlock title="Security" first>
            <Text style={styles.muted}>Sample account credentials cannot be changed.</Text>
          </SettingsBlock>
        ) : (
          <PasswordChange done={expired} />
        )}
        <SettingsBlock title="About BeeHave">
          <Text style={styles.aboutText}>A bioacoustic monitoring system for observing bee activity around coconut flowers.</Text>
          <View>
            <Pair label="Version" value="0.1.0" />
            <Pair label="Data storage" value="PostgreSQL database" />
            <Pair label="Evidence policy" value="Read-only detection records" />
          </View>
          <Text style={styles.notice}>Email recovery requires an additional service integration.</Text>
        </SettingsBlock>
      </SettingsSection>
      <Button title="Sign out" onPress={logout} />
    </ScrollView>
  );
}
