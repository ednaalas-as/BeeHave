import { colors } from "@beehave/shared";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, {
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Path,
  Stop,
} from "react-native-svg";
import { styles } from "../styles";
import { BrandLogo } from "./BrandLogo";
import { Wordmark } from "./Wordmark";

const entranceDuration = 2800;
// Sample a short curved flight once; the native driver handles every frame.
const flight = Array.from({ length: 61 }, (_, index) => {
  const time = index / 60;
  const t = Easing.inOut(Easing.quad)(
    Math.max(0, Math.min(1, (time - 0.12) / 0.58)),
  );
  const u = 1 - t;
  const exit = Easing.out(Easing.cubic)(Math.max(0, (time - 0.7) / 0.3));
  return {
    time,
    x:
      time <= 0.7
        ? u ** 3 * -100 +
          3 * u ** 2 * t * -75 +
          3 * u * t ** 2 * -35 +
          t ** 3 * 44
        : 44 + exit * 16,
    y:
      time <= 0.7
        ? u ** 3 * 28 + 3 * u ** 2 * t * -35 + 3 * u * t ** 2 * 80 + t ** 3 * -9
        : -9 - exit * 5,
  };
});

/** Native counterpart of the web startup; all styles and motion stay local. */
export function StartupScreen({
  ready,
  active,
  onComplete,
}: {
  ready: boolean;
  active: boolean;
  onComplete: () => void;
}) {
  const { width } = useWindowDimensions();
  const size = Math.max(1, Math.min(320, width - 48));
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);
  const [entered, setEntered] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const scan = useRef(new Animated.Value(0)).current;
  const wings = useRef(new Animated.Value(0)).current;
  const settle = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let live = true;
    let receivedChange = false;
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value) => {
        receivedChange = true;
        setReducedMotion(value);
      },
    );
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (live && !receivedChange) setReducedMotion(value);
      })
      .catch(() => {
        if (live && !receivedChange) setReducedMotion(true);
      });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!active || reducedMotion === null) return;
    if (reducedMotion) {
      progress.setValue(1);
      setEntered(true);
      return;
    }
    let live = true;
    // Read the native animation position so background time never skips a beat.
    progress.stopAnimation((position) => {
      if (!live) return;
      Animated.timing(progress, {
        toValue: 1,
        duration: Math.max(0, (1 - position) * entranceDuration),
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }).start(({ finished }) => {
        if (live && finished) setEntered(true);
      });
    });
    return () => {
      live = false;
      progress.stopAnimation();
    };
  }, [active, reducedMotion, progress]);

  useEffect(() => {
    if (!active || reducedMotion !== false) return;
    const sweep = Animated.loop(
      Animated.timing(scan, {
        toValue: 1,
        duration: 2600,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    const wingbeat = Animated.loop(
      Animated.sequence([
        Animated.timing(wings, {
          toValue: 1,
          duration: 120,
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(wings, {
          toValue: 0,
          duration: 120,
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    sweep.start();
    if (!entered) wingbeat.start();
    return () => {
      sweep.stop();
      wingbeat.stop();
    };
  }, [active, reducedMotion, entered, scan, wings]);

  useEffect(() => {
    if (!active || !ready || !entered || reducedMotion === null) return;
    let live = true;
    const finish = reducedMotion
      ? Animated.timing(opacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
          isInteraction: false,
        })
      : Animated.sequence([
          Animated.timing(settle, {
            toValue: 1,
            duration: 120,
            useNativeDriver: true,
            isInteraction: false,
          }),
          Animated.timing(opacity, {
            toValue: 0,
            duration: 240,
            useNativeDriver: true,
            isInteraction: false,
          }),
        ]);
    finish.start(({ finished }) => {
      if (live && finished) onComplete();
    });
    return () => {
      live = false;
      finish.stop();
      opacity.setValue(1);
      settle.setValue(0);
    };
  }, [active, ready, entered, reducedMotion, opacity, settle, onComplete]);

  const phase = (inputRange: number[], outputRange: number[]) =>
    progress.interpolate({ inputRange, outputRange, extrapolate: "clamp" });
  const reveal = reducedMotion === false ? phase([0.64, 0.86], [0, 1]) : 1;
  const signalOpacity = phase([0, 0.25], [0, 1]);
  return (
    <Animated.View
      style={[local.overlay, { opacity }]}
      accessibilityViewIsModal
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Preparing BeeHave. Loading monitoring data…"
      accessibilityLiveRegion="polite"
      pointerEvents="auto"
    >
      <View
        style={{ width: size, opacity: reducedMotion === null ? 0 : 1 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={local.scene}>
          {reducedMotion === false && (
            <>
              <Animated.View style={[local.signal, { opacity: signalOpacity }]}>
                <Svg width="100%" height={60} viewBox="0 48 360 60" fill="none">
                  <SignalGradient />
                  <Path d="M12 78H348" stroke="url(#startupSignal)" />
                </Svg>
              </Animated.View>
              <Animated.View
                style={[
                  local.signal,
                  {
                    opacity: Animated.multiply(
                      phase([0, 0.48, 0.68, 1], [0, 0, 0.25, 0.07]),
                      Animated.subtract(1, settle),
                    ),
                  },
                ]}
              >
                <Svg width="100%" height={60} viewBox="0 48 360 60" fill="none">
                  <Path
                    d="M132 68v18m8-25v32m8-38v44m8-48v51m8-46v42m8-54v62m8-58v53m8-45v39m8-35v30m8-26v22m8-19v16m8-13v10"
                    stroke={colors.amber}
                    strokeWidth={2}
                    strokeDasharray="2 4"
                  />
                </Svg>
              </Animated.View>
              <Animated.View
                style={[
                  local.signal,
                  {
                    opacity: Animated.multiply(
                      phase(
                        [0, 0.15, 0.35, 0.55, 0.78, 1],
                        [0, 0, 0.45, 1, 0.7, 0.35],
                      ),
                      Animated.subtract(1, settle),
                    ),
                    transform: [
                      {
                        scaleY: phase(
                          [0, 0.15, 0.35, 0.55, 0.78, 1],
                          [0.03, 0.03, 0.15, 1, 0.45, 0.2],
                        ),
                      },
                    ],
                  },
                ]}
              >
                <Svg width="100%" height={60} viewBox="0 48 360 60" fill="none">
                  <SignalGradient />
                  <Path
                    d="M12 78h82q6 0 9-3t6 3 6 0 6-9 6 9 6 0 6-16 6 16 6 0 6-26 6 26 6 0 6-19 6 19 6 0 6-10 6 10 6 0 6-4 6 4h96"
                    stroke="url(#startupSignal)"
                    strokeWidth={1.25}
                    strokeLinecap="round"
                  />
                </Svg>
              </Animated.View>
              <Animated.View
                style={[
                  local.bee,
                  {
                    left: size / 2 - 32,
                    opacity: phase(
                      [0, 0.12, 0.28, 0.5, 0.7, 0.86, 1],
                      [0, 0, 0.9, 1, 0.85, 0.5, 0],
                    ),
                    transform: [
                      {
                        translateX: progress.interpolate({
                          inputRange: flight.map((point) => point.time),
                          outputRange: flight.map(
                            (point) => point.x * Math.min(1, size / 288),
                          ),
                        }),
                      },
                      {
                        translateY: progress.interpolate({
                          inputRange: flight.map((point) => point.time),
                          outputRange: flight.map((point) => point.y),
                        }),
                      },
                      {
                        rotate: progress.interpolate({
                          inputRange: [0, 0.12, 0.28, 0.5, 0.7, 0.86, 1],
                          outputRange: [
                            "-12deg",
                            "-12deg",
                            "-10deg",
                            "7deg",
                            "-8deg",
                            "-2deg",
                            "0deg",
                          ],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <Bee wings={wings} />
              </Animated.View>
            </>
          )}
          <Animated.View
            style={[
              local.brand,
              {
                left: size / 2 - 32,
                opacity:
                  reducedMotion === false ? phase([0.6, 0.85], [0, 1]) : 1,
              },
            ]}
          >
            <BrandLogo size={64} />
          </Animated.View>
        </View>
        <Animated.View
          style={{
            alignItems: "center",
            opacity: reveal,
            transform: [
              {
                translateY:
                  reducedMotion === false ? phase([0.64, 0.86], [5, 0]) : 0,
              },
            ],
          }}
        >
          <Wordmark width={Math.min(184, size)} />
          <Text style={[styles.body, local.title]}>Preparing BeeHave</Text>
          <Text style={[styles.caption, local.description]}>
            Loading monitoring data…
          </Text>
        </Animated.View>
        <View style={[local.track, { width: Math.min(224, size * 0.85) }]}>
          <View style={local.baseline} />
          <Animated.View
            style={[
              local.completed,
              { opacity: reducedMotion ? 0.65 : settle },
            ]}
          />
          {reducedMotion === false && (
            <Animated.View
              style={[
                local.scan,
                {
                  opacity: Animated.multiply(
                    scan.interpolate({
                      inputRange: [0, 0.18, 0.78, 1],
                      outputRange: [0, 0.7, 0.7, 0],
                    }),
                    Animated.subtract(1, settle),
                  ),
                  transform: [
                    {
                      translateX: scan.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-56, Math.min(224, size * 0.85)],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Svg width={56} height={12} viewBox="0 0 56 12" fill="none">
                <Path
                  d="M0 6h18l3-2 3 4 4-7 4 10 3-5h21"
                  stroke={colors.amber}
                />
              </Svg>
            </Animated.View>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

function SignalGradient() {
  return (
    <Defs>
      <LinearGradient id="startupSignal" x1="0" y1="0" x2="1" y2="0">
        <Stop offset="0" stopColor={colors.slate} stopOpacity={0} />
        <Stop offset="0.3" stopColor={colors.slate} stopOpacity={0.32} />
        <Stop offset="0.5" stopColor={colors.amber} stopOpacity={0.7} />
        <Stop offset="0.7" stopColor={colors.slate} stopOpacity={0.32} />
        <Stop offset="1" stopColor={colors.slate} stopOpacity={0} />
      </LinearGradient>
    </Defs>
  );
}

function Bee({ wings }: { wings: Animated.Value }) {
  return (
    <>
      <Svg width={64} height={49} viewBox="0 0 100 76" fill="none">
        <Defs>
          <LinearGradient
            id="beeAmber"
            x1="25"
            y1="38"
            x2="61"
            y2="60"
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0" stopColor="#F2B740" />
            <Stop offset="1" stopColor="#B87526" />
          </LinearGradient>
          <ClipPath id="beeBody">
            <Path d="M60 40C49 34 31 39 23 49c8 9 24 13 35 6 6-4 8-10 2-15Z" />
          </ClipPath>
        </Defs>
        <Path
          d="m49 53-5 9-9 3m22-13 5 11 7 2m-3-18 9 9 7-1"
          stroke={colors.slate}
          strokeLinecap="round"
        />
        <Path
          d="M60 40C49 34 31 39 23 49c8 9 24 13 35 6 6-4 8-10 2-15Z"
          fill="url(#beeAmber)"
        />
        <G clipPath="url(#beeBody)" stroke="#122033" strokeWidth={5}>
          <Path d="M32 38q-5 12 2 23m9-27q-6 15 1 28m10-28q-5 14 1 25" />
        </G>
      </Svg>
      <Animated.View
        style={[
          StyleSheet.absoluteFillObject,
          {
            transform: [
              {
                scaleY: wings.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.82, 1],
                }),
              },
              {
                rotate: wings.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["-3deg", "3deg"],
                }),
              },
            ],
          },
        ]}
      >
        <Svg width={64} height={49} viewBox="0 0 100 76" fill="none">
          <Defs>
            <LinearGradient
              id="beeWing"
              x1="50"
              y1="15"
              x2="57"
              y2="43"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.95} />
              <Stop offset="1" stopColor="#CBD5E1" stopOpacity={0.55} />
            </LinearGradient>
          </Defs>
          <G fill="url(#beeWing)" stroke="#94A3B8" strokeWidth={0.8}>
            <Path d="M60 43C49 42 25 24 29 15c6-11 30 6 31 28Z" />
            <Path d="M60 43C54 25 61 7 70 10c12 5 5 25-10 33Z" />
            <Path d="M60 43 35 19m25 24 9-27" fill="none" opacity={0.45} />
          </G>
        </Svg>
      </Animated.View>
      <Svg
        style={StyleSheet.absoluteFillObject}
        width={64}
        height={49}
        viewBox="0 0 100 76"
        fill="none"
      >
        <Path
          d="M55 40c3-7 12-9 17-3 5 7 0 16-7 17-7 0-13-7-10-14Z"
          fill="#26364A"
        />
        <Path d="M69 35c5-6 13-4 15 2 1 6-4 11-10 9" fill="#122033" />
        <Path
          d="m78 33 3-8 5-2m-3 12 6-5 5 1"
          stroke="#122033"
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      </Svg>
    </>
  );
}

const local = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    backgroundColor: "#EDF2F7",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  scene: { height: 120 },
  signal: { position: "absolute", top: 48, left: 0, right: 0, height: 60 },
  bee: { position: "absolute", top: 28, width: 64, height: 49 },
  brand: { position: "absolute", top: 8 },
  title: { marginTop: 24, textAlign: "center", fontWeight: "500" },
  description: { marginTop: 8, textAlign: "center" },
  track: { height: 12, marginTop: 24, alignSelf: "center", overflow: "hidden" },
  baseline: {
    position: "absolute",
    top: 5.5,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "#E7EBEF",
  },
  completed: {
    position: "absolute",
    top: 5.5,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.amber,
  },
  scan: { position: "absolute", top: 0, width: 56, height: 12 },
});
