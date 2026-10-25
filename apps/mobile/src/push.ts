import type { NotificationTarget } from "@beehave/shared";
import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { apiRequest } from "./api";

// Native push through Expo's push service. Each installation registers its own token, so an
// account may receive on several phones; the API ties every token to the session that sent it.
export type PushStatus =
  | "unconfigured" // this build has no EAS project ID, so it cannot get an Expo push token
  | "denied" // turned off in the phone's settings
  | "off" // turned off in BeeHave for this account
  | "on"
  | "unavailable"; // no token (e.g. a simulator, or no network)

// Notifications that arrive while BeeHave is open are still shown as a banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const installationKey = "beehave.installation";
const offKey = (account: string) => `beehave.push.off.${account}`;
let registeredToken: string | null = null;

const projectId = (): string | undefined =>
  (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ??
  Constants.easConfig?.projectId ??
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID;

async function installationId() {
  const stored = await SecureStore.getItemAsync(installationKey);
  if (stored) return stored;
  const id = randomUUID();
  await SecureStore.setItemAsync(installationKey, id);
  return id;
}

// Android 8+ shows nothing without a channel; "default" matches what the API sends.
async function channel() {
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("default", {
      name: "BeeHave",
      importance: Notifications.AndroidImportance.HIGH,
    });
}

/** Registers this phone for the signed-in account. Asks for permission only when `ask` is set and
 * the phone has not been asked before; a refusal is respected and never asked again here. */
export async function registerPush(account: string, ask: boolean): Promise<PushStatus> {
  if ((await SecureStore.getItemAsync(offKey(account))) === "1") return "off";
  const id = projectId();
  if (!id) return "unconfigured";
  await channel();
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain && ask) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return "denied";
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await apiRequest("/notifications/destinations", {
      method: "POST",
      body: JSON.stringify({ kind: "expo", token, installationId: await installationId(), platform: Platform.OS === "ios" ? "ios" : "android" }),
    });
    registeredToken = token;
    return "on";
  } catch {
    return "unavailable";
  }
}

/** Turns notifications on or off for this account on this phone. */
export async function setPushEnabled(account: string, on: boolean) {
  if (on) {
    await SecureStore.deleteItemAsync(offKey(account));
    return registerPush(account, true);
  }
  await SecureStore.setItemAsync(offKey(account), "1");
  await releasePush();
  return "off" as const;
}

/** Before signing out: this phone stops receiving for the account. */
export async function releasePush() {
  const token = registeredToken;
  registeredToken = null;
  if (token)
    await apiRequest("/notifications/destinations/remove", { method: "POST", body: JSON.stringify({ endpoint: token }) }).catch(() => {});
}

// The screen a tapped notification asks for, if it carries a valid target.
export function notificationTarget(response: Notifications.NotificationResponse | null | undefined): NotificationTarget | null {
  const target = (response?.notification.request.content.data as { target?: Partial<NotificationTarget> } | undefined)?.target;
  if (!target || typeof target.farmId !== "string" || (target.screen !== "device" && target.screen !== "farm-requests")) return null;
  return { screen: target.screen, farmId: target.farmId, ...(typeof target.deviceId === "string" ? { deviceId: target.deviceId } : {}) };
}
