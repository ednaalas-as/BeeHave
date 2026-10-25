import { type Recording } from "@beehave/shared";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { API_BASE_URL, getSessionToken } from "../api";
import { useFarm } from "../farm";
import { amplifyPcmWav } from "../audio/playback-gain";
import { styles } from "../styles";
import { Button, Message, Pair } from "./FormControls";

export function Player({
  recording,
  source,
}: {
  recording: Recording;
  // Plays part of the recording (a detection's window) instead of all of it.
  source?: { path: string; duration: number };
}) {
  const duration = source ? source.duration : recording.duration;
  const { farmPath } = useFarm();
  const audioUrl = `${API_BASE_URL}${farmPath(source ? source.path : `/api/recordings/${recording.deviceId}/${recording.id}/audio`)}`;
  const headers = { Authorization: `Bearer ${getSessionToken()}` };
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function loadPlaybackCopy() {
      try {
        const response = await fetch(audioUrl, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Audio request failed (${response.status}).`);
        const original = new Uint8Array(await response.arrayBuffer());
        const amplified = amplifyPcmWav(original);
        if (!active) return;

        if (amplified) {
          const file = new File(
            Paths.cache,
            `beehave-playback-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
          );
          file.write(amplified);
          if (!active) {
            file.delete();
            return;
          }
          player.replace(file.uri);
        } else {
          // Keep formats outside the verified PCM WAV set playable as before.
          player.replace({ uri: audioUrl, headers });
        }
      } catch (e) {
        if (active && !controller.signal.aborted) {
          try {
            player.replace({ uri: audioUrl, headers });
            setError(
              "Playback gain was unavailable; playing the original audio.",
            );
          } catch {
            setError((e as Error).message);
          }
        }
      }
    }

    void loadPlaybackCopy();
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    audioUrl,
    headers.Authorization,
    player,
    recording.deviceId,
    recording.id,
  ]);

  return (
    <View style={styles.field}>
      {recording.synthetic && (
        <Message>Synthetic demonstration tone — not field audio.</Message>
      )}
      <Pair
        label="Playback"
        value={`${status.currentTime.toFixed(1)} / ${duration}s`}
      />
      <Button
        title={
          status.playing
            ? "Pause"
            : status.isLoaded
              ? "Play recording"
              : "Loading audio…"
        }
        disabled={!status.isLoaded}
        primary
        onPress={() => {
          try {
            if (status.playing) player.pause();
            else {
              if (status.currentTime >= duration - 0.1) void player.seekTo(0);
              player.play();
            }
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      <Button
        title="Restart recording"
        disabled={!status.isLoaded}
        onPress={() => {
          void player.seekTo(0).catch((e) => setError(String(e)));
        }}
      />
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.caption}>
        If loading does not complete, return and retry. The recording may be
        unavailable or unsupported.
      </Text>
    </View>
  );
}
