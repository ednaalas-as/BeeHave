import { useId } from "react";
import { wordmark } from "../../../../packages/shared/src/branding";

export function Wordmark({ width = 132 }: { width?: number }) {
  const gradient = useId();
  return (
    <svg
      width={width}
      height={(width * 44) / 306}
      viewBox={wordmark.viewBox}
      role="img"
      aria-label="BeeHave"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="70%" y2="100%">
          <stop offset="0" stopColor={wordmark.amber} />
          <stop offset="1" stopColor={wordmark.orange} />
        </linearGradient>
      </defs>
      <g fill={wordmark.bee} fillRule="evenodd">
        <path d={wordmark.b} />
        <path d={wordmark.e} transform="translate(45 0)" />
        <path d={wordmark.e} transform="translate(89 0)" />
      </g>
      <g
        fill="none"
        stroke={`url(#${gradient})`}
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M140 7V37M140 22H167M167 7V37" />
        <path d="M183 37L200 7L217 37" />
        <path d="M227 7L243 37L259 7" />
      </g>
      <path
        d={wordmark.e}
        transform="translate(270 0)"
        fill={`url(#${gradient})`}
      />
    </svg>
  );
}
