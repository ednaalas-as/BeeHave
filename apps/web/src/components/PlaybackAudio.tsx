import { useEffect, useRef } from "react";

const PLAYBACK_GAIN = 4;

type AudioContextWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** Keep the native controls while applying gain only to the playback signal. */
export function PlaybackAudio({
  src,
  label,
  onError,
  className,
}: {
  src: string;
  label: string;
  onError?: () => void;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const AudioContextConstructor =
      window.AudioContext || (window as AudioContextWindow).webkitAudioContext;
    if (!AudioContextConstructor) return;

    // A media element can only be connected to one source node. Reuse the graph
    // across React Strict Mode effect replays for the lifetime of this element.
    let graph = playbackGraphs.get(audio);
    if (!graph) {
      try {
        const context = new AudioContextConstructor();
        const source = context.createMediaElementSource(audio);
        const gain = context.createGain();
        const limiter = context.createDynamicsCompressor();
        gain.gain.value = PLAYBACK_GAIN;
        limiter.threshold.value = -1;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.2;
        source.connect(gain);
        gain.connect(limiter);
        limiter.connect(context.destination);
        graph = { context };
        playbackGraphs.set(audio, graph);
      } catch {
        // Leave native playback available on browsers that reject Web Audio routing.
        return;
      }
    }

    const context = graph.context;
    const resume = () => {
      if (context.state === "suspended") void context.resume().catch(() => {});
    };
    audio.addEventListener("play", resume);
    return () => audio.removeEventListener("play", resume);
  }, []);

  return (
    <audio
      ref={audioRef}
      className={className}
      controls
      preload="metadata"
      src={src}
      onError={onError}
      aria-label={label}
    />
  );
}

const playbackGraphs = new WeakMap<
  HTMLAudioElement,
  { context: AudioContext }
>();
