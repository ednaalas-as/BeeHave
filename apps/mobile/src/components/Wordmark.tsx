import Svg, { Defs, G, LinearGradient, Path, Stop } from "react-native-svg";
import { wordmark } from "../../../../packages/shared/src/branding";

export function Wordmark({ width = 144 }: { width?: number }) {
  return (
    <Svg
      width={width}
      height={(width * 44) / 306}
      viewBox={wordmark.viewBox}
      accessible
      accessibilityLabel="BeeHave"
    >
      <Defs>
        <LinearGradient id="honey" x1="0" y1="0" x2="0.7" y2="1">
          <Stop offset="0" stopColor={wordmark.amber} />
          <Stop offset="1" stopColor={wordmark.orange} />
        </LinearGradient>
      </Defs>
      <G fill={wordmark.bee} fillRule="evenodd">
        <Path d={wordmark.b} />
        <Path d={wordmark.e} transform="translate(45 0)" />
        <Path d={wordmark.e} transform="translate(89 0)" />
      </G>
      <G
        fill="none"
        stroke="url(#honey)"
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Path d="M140 7V37M140 22H167M167 7V37" />
        <Path d="M183 37L200 7L217 37" />
        <Path d="M227 7L243 37L259 7" />
      </G>
      <Path d={wordmark.e} transform="translate(270 0)" fill="url(#honey)" />
    </Svg>
  );
}
