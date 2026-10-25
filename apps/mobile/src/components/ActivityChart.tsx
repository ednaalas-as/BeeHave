import {
  chartMetrics,
  chartScale,
  formatChartValue,
  type ChartMetric,
} from "@beehave/shared/chart-series";
import { useEffect, useState } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { styles } from "../styles";

const FONT = 10;
// Conservative width of one axis character at FONT, so labels never run past the card.
const CHAR = FONT * 0.62;
// Room above the plot for the y-axis label.
const TOP = FONT + 14;
const PLOT = 150;
const AXIS = 22;
const TOOLTIP = 168;
const TOOLTIP_HEIGHT = 68;

/**
 * A line and area chart of the selected metric, drawn at the card's measured width so text
 * keeps its size on every phone. Tap a point to see its period and value.
 */
export function ActivityChart({
  values,
  labels,
  periods,
  metric = "count",
}: {
  values: (number | null)[];
  labels: string[];
  // Full description of the period each point covers, shown in its tooltip.
  periods: string[];
  metric?: ChartMetric;
}) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => setActive(null), [values, metric]);
  const { unit, description, axis, short } = chartMetrics[metric];
  const { floor, ceiling, ticks } = chartScale(values, metric);
  const tickWidth = Math.max(...ticks.map((t) => String(t).length)) * CHAR;
  const labelWidth = Math.max(1, ...labels.map((l) => l.length)) * CHAR;
  const left = Math.max(tickWidth + 8, labelWidth / 2 + 2);
  const right = labelWidth / 2 + 2;
  const plotWidth = Math.max(1, width - left - right);
  const baseline = TOP + PLOT;
  const height = baseline + AXIS;
  const x = (i: number) => left + (i * plotWidth) / Math.max(1, values.length - 1);
  const y = (v: number) => baseline - ((v - floor) / (ceiling - floor)) * PLOT;
  // Empty labels are intentional blanks; thin out only the labels that exist.
  const labelled = labels.flatMap((label, i) => (label ? [i] : []));
  const step = Math.max(
    1,
    Math.ceil(labelled.length / Math.max(1, Math.floor(plotWidth / (labelWidth + 10)))),
  );
  const shownLabels = labelled.filter((_, k) => k % step === 0);
  const segments: { index: number; value: number }[][] = [];
  values.forEach((value, index) => {
    if (value === null) return;
    if (index === 0 || values[index - 1] === null) segments.push([]);
    segments[segments.length - 1].push({ index, value });
  });
  const path = (points: { index: number; value: number }[]) =>
    points.map((p, k) => `${k ? "L" : "M"}${x(p.index)},${y(p.value)}`).join(" ");
  const select = (event: GestureResponderEvent) => {
    if (!values.length) return;
    const i = Math.round(
      ((event.nativeEvent.locationX - left) / plotWidth) * Math.max(1, values.length - 1),
    );
    setActive(Math.min(values.length - 1, Math.max(0, i)));
  };
  const tooltipWidth = Math.min(TOOLTIP, width);
  const tooltipLeft =
    active === null
      ? 0
      : Math.min(width - tooltipWidth, Math.max(0, x(active) - tooltipWidth / 2));
  // Drop the tooltip to the bottom of the plot when it would cover a point near the top.
  const tooltipTop =
    active !== null && values[active] !== null && y(values[active] as number) < TOP + TOOLTIP_HEIGHT + 8
      ? baseline - TOOLTIP_HEIGHT
      : 0;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ minHeight: height }}>
      {width > 0 && (
        <Pressable
          onPress={select}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${description}. ${values.map((value, i) => `${periods[i] ?? labels[i]}: ${value === null ? "No data" : `${formatChartValue(value, metric)} ${unit}`}`).join(", ")}`}
        >
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#5B96D2" stopOpacity={0.23} />
                <Stop offset="1" stopColor="#5B96D2" stopOpacity={0.01} />
              </LinearGradient>
            </Defs>
            <SvgText x={0} y={FONT} fontSize={FONT} fontWeight="600" fill="#172B40" textAnchor="start">
              {axis}
            </SvgText>
            {ticks.map((tick) => (
              <GridLine key={tick} y={y(tick)} left={left} right={width - right} label={String(tick)} />
            ))}
            {segments.map((points) => (
              <Path
                key={`a${points[0].index}`}
                d={`${path(points)} L${x(points[points.length - 1].index)},${baseline} L${x(points[0].index)},${baseline} Z`}
                fill="url(#activityFill)"
              />
            ))}
            {segments.map((points) => (
              <Path
                key={`l${points[0].index}`}
                d={path(points)}
                fill="none"
                stroke="#4C89C8"
                strokeWidth={2.3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {/* A point between two gaps has no line, so draw it as a dot. */}
            {segments
              .filter((points) => points.length === 1)
              .map(([point]) => (
                <Circle key={`d${point.index}`} cx={x(point.index)} cy={y(point.value)} r={2.5} fill="#4C89C8" />
              ))}
            {active !== null && (
              <Line x1={x(active)} x2={x(active)} y1={TOP} y2={baseline} stroke="#4C89C8" strokeOpacity={0.35} />
            )}
            {active !== null && values[active] !== null && (
              <Circle
                cx={x(active)}
                cy={y(values[active] as number)}
                r={4.5}
                fill="#4C89C8"
                stroke="#FFFFFF"
                strokeWidth={2}
              />
            )}
            {shownLabels.map((i) => (
              <SvgText
                key={i}
                x={x(i)}
                y={baseline + FONT + 7}
                fontSize={FONT}
                fill="#8A94A3"
                textAnchor="middle"
              >
                {labels[i]}
              </SvgText>
            ))}
          </Svg>
        </Pressable>
      )}
      {active !== null && (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.chartTooltip, { left: tooltipLeft, top: tooltipTop, width: tooltipWidth }]}
        >
          <Text style={styles.chartTooltipPeriod} numberOfLines={2}>
            {periods[active] ?? labels[active]}
          </Text>
          <Text style={styles.chartTooltipPeriod} numberOfLines={1}>
            {short}
          </Text>
          <Text style={styles.chartTooltipValue} numberOfLines={1}>
            {values[active] === null
              ? "No data received"
              : `${formatChartValue(values[active] as number, metric)} ${unit}`}
          </Text>
        </View>
      )}
    </View>
  );
}

function GridLine({
  y,
  left,
  right,
  label,
}: {
  y: number;
  left: number;
  right: number;
  label: string;
}) {
  return (
    <>
      <Line x1={left} x2={right} y1={y} y2={y} stroke="#E9EDF2" strokeDasharray="3 4" />
      <SvgText x={left - 6} y={y + 3.5} fontSize={FONT} fill="#8A94A3" textAnchor="end">
        {label}
      </SvgText>
    </>
  );
}
