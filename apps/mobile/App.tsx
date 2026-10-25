import { colors, manilaDate, type FarmMembership, type Session } from "@beehave/shared";
import {
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
  useFonts,
} from "@expo-google-fonts/space-grotesk";
import { Feather } from "@expo/vector-icons";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  apiRequest,
  clearSessionToken,
  restoreSessionToken,
  saveSessionToken,
} from "./src/api";
import { BrandLogo } from "./src/components/BrandLogo";
import { FarmAccess } from "./src/components/FarmAccess";
import { ScopeBar, ScopeSelectors } from "./src/components/ScopeBar";
import { FarmProvider, farmScope, membershipsOf } from "./src/farm";
import { Wordmark } from "./src/components/Wordmark";
import { StartupScreen } from "./src/components/StartupScreen";
import { Detail, Tab, tabs } from "./src/navigation";
import { DeviceScreen } from "./src/screens/DevicesScreen";
import { Overview } from "./src/screens/OverviewScreen";
import { Details } from "./src/screens/RecordDetailsScreen";
import { Records } from "./src/screens/RecordsScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { Login } from "./src/screens/SignInScreen";
import { notificationTarget, registerPush, releasePush } from "./src/push";
import { styles } from "./src/styles";

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });
  const [startupVisible, setStartupVisible] = useState(true);
  const [applicationState, setApplicationState] = useState(
    AppState.currentState,
  );
  const [windowFocused, setWindowFocused] = useState(true);
  const active = applicationState === "active" && windowFocused;
  const protectedContent = startupVisible || !active;
  const finishStartup = useCallback(() => setStartupVisible(false), []);
  useEffect(() => {
    const state = AppState.addEventListener("change", (next) => {
      if (next !== "active") Keyboard.dismiss();
      setApplicationState(next);
    });
    const blur =
      Platform.OS === "android"
        ? AppState.addEventListener("blur", () => {
            Keyboard.dismiss();
            setWindowFocused(false);
          })
        : undefined;
    const focus =
      Platform.OS === "android"
        ? AppState.addEventListener("focus", () => setWindowFocused(true))
        : undefined;
    return () => {
      state.remove();
      blur?.remove();
      focus?.remove();
    };
  }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [starting, setStarting] = useState(true);
  const [startupError, setStartupError] = useState("");
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [detail, setDetail] = useState<Detail>(null);
  const [date, setDate] = useState(manilaDate());
  // The selected farm decides every farm-scoped screen; a device choice belongs to its farm.
  const [scope, setScope] = useState({ farm: "", device: "" });
  const farms = session ? membershipsOf(session.account) : [];
  const farm =
    farms.find((f) => f.id === scope.farm) ??
    farms.find((f) => f.id === session?.account.farmId) ??
    farms[0];
  const station = farm && scope.farm === farm.id ? scope.device : "";
  const setStation = useCallback(
    (device: string) => setScope((current) => ({ farm: farm?.id ?? current.farm, device })),
    [farm?.id],
  );
  const setFarm = (id: string) => {
    setScope({ farm: id, device: "" });
    setDetail(null);
  };
  const expired = useCallback(() => {
    void clearSessionToken();
    setSession(null);
    setDetail(null);
  }, []);
  useEffect(() => {
    async function restore() {
      try {
        const token = await restoreSessionToken();
        if (token) setSession(await apiRequest<Session>("/auth/me"));
      } catch (e) {
        if ((e as { status?: number }).status === 401) expired();
        else
          setStartupError(
            "Could not reach the API. Check its address and network connection.",
          );
      } finally {
        setStarting(false);
      }
    }
    void restore();
  }, [expired]);
  async function loggedIn(value: Session) {
    if (!value.token)
      throw new Error("The server did not provide a native session.");
    await saveSessionToken(value.token);
    setSession(value);
    setStartupError("");
  }
  // Farm memberships change when a request is approved or a farm is left.
  const refreshSession = useCallback(async () => {
    try {
      setSession(await apiRequest<Session>("/auth/me"));
    } catch (e) {
      if ((e as { status?: number }).status === 401) expired();
    }
  }, [expired]);
  // A farm just created or joined: reload the memberships, then open it.
  const openFarm = (created: FarmMembership) => {
    setFarm(created.id);
    void refreshSession();
  };
  // Refresh access while the app is open, including the no-farm screen.
  const accountId = session?.account.id;
  useEffect(() => {
    if (!accountId || !active) return;
    let cancelled = false;
    const refreshAccess = async () => {
      try {
        const next = await apiRequest<Session>("/auth/me");
        if (!cancelled) setSession(next);
      } catch (e) {
        if (!cancelled && (e as { status?: number }).status === 401) expired();
      }
    };
    void refreshAccess();
    const timer = setInterval(() => void refreshAccess(), 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [accountId, active, expired]);
  // Register this phone for push once the account is signed in and BeeHave is in front, which is
  // also when iOS shows its one-time permission prompt.
  const pushRegistered = useRef<string | null>(null);
  useEffect(() => {
    // Signed out or expired: the next sign-in registers again, for its new session.
    if (!accountId) pushRegistered.current = null;
    if (!accountId || !active || session?.account.demo || pushRegistered.current === accountId) return;
    pushRegistered.current = accountId;
    void registerPush(accountId, true).catch(() => {});
  }, [accountId, active, session?.account.demo]);
  // A tapped notification (also one that launched the app) opens its farm, device or requests.
  // It only selects: a farm this account does not belong to is ignored.
  const response = Notifications.useLastNotificationResponse();
  const handledResponse = useRef<string | null>(null);
  useEffect(() => {
    const target = notificationTarget(response);
    const id = response?.notification.request.identifier;
    if (!target || !id || !session || handledResponse.current === id) return;
    handledResponse.current = id;
    if (!membershipsOf(session.account).some((f) => f.id === target.farmId)) return;
    setScope({ farm: target.farmId, device: target.deviceId ?? "" });
    setDetail(null);
    setTab(target.screen === "device" ? "Edge Device" : "Settings");
  }, [response, session]);
  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      // This phone stops receiving notifications for the account signing out.
      await releasePush();
      await apiRequest("/auth/logout", { method: "POST" });
      expired();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e) {
      Alert.alert("Sign out failed", (e as Error).message);
    } finally {
      setSigningOut(false);
    }
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView
        style={[
          styles.root,
          protectedContent && { backgroundColor: "#EDF2F7" },
        ]}
      >
        <StatusBar style="dark" />
        <View
          style={{ flex: 1 }}
          pointerEvents={protectedContent ? "none" : "auto"}
          accessibilityElementsHidden={protectedContent}
          importantForAccessibility={
            protectedContent ? "no-hide-descendants" : "auto"
          }
        >
          {signingOut ? (
            <View style={styles.empty} accessibilityRole="alert">
              <ActivityIndicator color={colors.amber} />
              <Text style={styles.muted}>Signing you out…</Text>
            </View>
          ) : starting || (!fontsLoaded && !fontError) ? (
            <ActivityIndicator color={colors.amber} />
          ) : !session ? (
            <Login onLogin={loggedIn} initialError={startupError} />
          ) : !farm ? (
            <ScrollView contentContainerStyle={styles.content}>
              <ScopeSelectors />
              <Text style={styles.muted} accessibilityRole="alert">
                This account is not a member of any farm yet.
              </Text>
              {!session.account.demo && <FarmAccess opened={openFarm} />}
              <Pressable accessibilityRole="button" onPress={() => void logout()}>
                <Text style={styles.blue}>Sign out</Text>
              </Pressable>
            </ScrollView>
          ) : (
            <FarmProvider value={farmScope(farm, farms)}>
              <View style={styles.top}>
                <View style={styles.brandRow}>
                  <BrandLogo size={38} />
                  <View>
                    <Wordmark width={140} />
                    <Text numberOfLines={1} style={styles.farmName}>
                      {farm.name}
                    </Text>
                  </View>
                </View>
                <Pressable
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel={
                    tab === "Settings" ? "Back to overview" : "Open settings"
                  }
                  onPress={() => {
                    setDetail(null);
                    setTab(tab === "Settings" ? "Dashboard" : "Settings");
                  }}
                >
                  <Feather
                    name={tab === "Settings" ? "x" : "settings"}
                    size={19}
                    color={colors.navy}
                  />
                </Pressable>
              </View>
              {farm.demo && (
                <Text style={styles.demo}>
                  Sample farm · Synthetic observations and audio
                </Text>
              )}
              {!detail && tab !== "Settings" && (
                <ScopeBar
                  key={`scope-${farm.id}`}
                  farms={farms}
                  setFarm={setFarm}
                  station={station}
                  setStation={setStation}
                  expired={expired}
                />
              )}
              {detail ? (
                <Details
                  detail={detail}
                  open={setDetail}
                  close={() => setDetail(null)}
                  expired={expired}
                />
              ) : tab === "Dashboard" || tab === "Activity" ? (
                <Overview
                  key={`overview-${farm.id}`}
                  historical={tab === "Activity"}
                  sample={farm.demo}
                  openDevices={() => setTab("Edge Device")}
                  station={station}
                  expired={expired}
                  open={setDetail}
                  selectDate={(date) => {
                    setDate(date);
                    setTab("Detection");
                  }}
                />
              ) : tab === "Detection" || tab === "Recordings" ? (
                <Records
                  key={`${tab}-${farm.id}`}
                  audio={tab === "Recordings"}
                  date={date}
                  setDate={setDate}
                  station={station}
                  expired={expired}
                  open={setDetail}
                />
              ) : tab === "Edge Device" ? (
                <DeviceScreen
                  key={`devices-${farm.id}`}
                  expired={expired}
                  account={session.account}
                  refreshSession={refreshSession}
                  station={station}
                  deleted={(id) => {
                    if (station === id) setStation("");
                  }}
                />
              ) : (
                <SettingsScreen
                  account={session.account}
                  expired={expired}
                  logout={logout}
                  opened={openFarm}
                  refreshSession={() => void refreshSession()}
                />
              )}
              <View style={styles.nav} accessibilityRole="tablist">
                {tabs.map((destination) => (
                  <Pressable
                    key={destination.label}
                    accessibilityRole="tab"
                    accessibilityLabel={destination.title}
                    accessibilityState={{ selected: tab === destination.label }}
                    onPress={() => {
                      setTab(destination.label);
                      setDetail(null);
                    }}
                    style={styles.tab}
                  >
                    <View
                      style={[
                        styles.tabIcon,
                        tab === destination.label && styles.tabIconActive,
                      ]}
                    >
                      <Feather
                        name={destination.icon}
                        size={19}
                        color={
                          tab === destination.label ? "#A57826" : "#8A95A3"
                        }
                      />
                    </View>
                    <Text
                      style={[
                        styles.tabText,
                        tab === destination.label && styles.activeTab,
                      ]}
                    >
                      {destination.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </FarmProvider>
          )}
        </View>
        {startupVisible && (
          <StartupScreen
            ready={!starting && (fontsLoaded || !!fontError)}
            active={active}
            onComplete={finishStartup}
          />
        )}
        {!active && (
          <View
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: "#EDF2F7", zIndex: 20 },
            ]}
            pointerEvents="auto"
            accessibilityViewIsModal
            accessible
            accessibilityLabel="BeeHave is inactive"
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
